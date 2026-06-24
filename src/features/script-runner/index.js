'use strict';

/**
 * script-runner feature
 *
 * Prebaked + custom scripts that run against the authenticated AWS account.
 * Auth gate (Touch ID / password) is enforced in the renderer before any run.
 * Custom scripts are stored locally as shell scripts and executed via child_process
 * with AWS credentials injected as environment variables.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { exec } = require('child_process');
const { dialog } = require('electron');

const {
  EC2Client,
  DescribeVolumesCommand,
  ModifyVolumeCommand,
  DescribeSecurityGroupsCommand,
  DescribeRegionsCommand,
  DescribeInstancesCommand,
  ModifyInstanceMetadataOptionsCommand,
  EnableEbsEncryptionByDefaultCommand,
  RevokeSecurityGroupIngressCommand,
  RevokeSecurityGroupEgressCommand,
  DescribeAddressesCommand,
  ReleaseAddressCommand,
  DescribeImagesCommand,
  DescribeLaunchTemplateVersionsCommand,
  DeregisterImageCommand,
  DeleteSnapshotCommand,
  DeleteVolumeCommand,
  DescribeLaunchTemplatesCommand,
  DescribeNetworkInterfacesCommand,
  DeleteSecurityGroupCommand,
  ModifyInstancePlacementCommand,
  StopInstancesCommand,
  StartInstancesCommand,
  DescribeInstanceStatusCommand,
} = require('@aws-sdk/client-ec2');

const {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  ModifyLoadBalancerAttributesCommand,
} = require('@aws-sdk/client-elastic-load-balancing-v2');

const {
  S3Client,
  ListBucketsCommand,
  GetBucketLocationCommand,
  CreateBucketCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
  GetPublicAccessBlockCommand,
} = require('@aws-sdk/client-s3');

const {
  SSOAdminClient,
  ListInstancesCommand:                    ListSSOInstancesCommand,
  ListPermissionSetsCommand,
  CreatePermissionSetCommand,
  DescribePermissionSetCommand,
  AttachManagedPolicyToPermissionSetCommand,
  CreateAccountAssignmentCommand,
} = require('@aws-sdk/client-sso-admin');

const {
  IdentitystoreClient,
  CreateUserCommand,
  ListUsersCommand,
} = require('@aws-sdk/client-identitystore');

const {
  CloudWatchClient,
  PutMetricAlarmCommand,
} = require('@aws-sdk/client-cloudwatch');

const {
  SNSClient,
  CreateTopicCommand,
  SubscribeCommand,
} = require('@aws-sdk/client-sns');

const {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  PutRetentionPolicyCommand,
} = require('@aws-sdk/client-cloudwatch-logs');

let _cloudTrail;
function getCloudTrailSdk() {
  if (!_cloudTrail) {
    try {
      _cloudTrail = require('@aws-sdk/client-cloudtrail');
    } catch {
      throw new Error('CloudTrail SDK not installed. Run: npm install @aws-sdk/client-cloudtrail');
    }
  }
  return _cloudTrail;
}

let _macie;
function getMacieSdk() {
  if (!_macie) {
    try {
      _macie = require('@aws-sdk/client-macie2');
    } catch {
      throw new Error('Macie SDK not installed. Run: npm install @aws-sdk/client-macie2');
    }
  }
  return _macie;
}

let _guardduty;
function getGuardDutySdk() {
  if (!_guardduty) {
    try {
      _guardduty = require('@aws-sdk/client-guardduty');
    } catch {
      throw new Error('GuardDuty SDK not installed. Run: npm install @aws-sdk/client-guardduty');
    }
  }
  return _guardduty;
}

let _detective;
function getDetectiveSdk() {
  if (!_detective) {
    try {
      _detective = require('@aws-sdk/client-detective');
    } catch {
      throw new Error('Detective SDK not installed. Run: npm install @aws-sdk/client-detective');
    }
  }
  return _detective;
}

const awsAuth = require('../../main/aws-auth');
const audit   = require('../../main/audit-logger');

function genId() {
  try { return require('crypto').randomUUID(); } catch { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
}

// Convert camelCase param IDs to UPPER_SNAKE_CASE env var names
function camelToSnake(s) {
  return s.replace(/([A-Z])/g, '_$1').toUpperCase();
}

const DATA_DIR        = path.join(os.homedir(), 'Library', 'Application Support', 'maws');
const CUSTOM_FILE     = path.join(DATA_DIR, 'custom-scripts.json');
const VERSIONS_FILE   = path.join(DATA_DIR, 'script-versions.json');
const FAVORITES_FILE  = path.join(DATA_DIR, 'script-favorites.json');
const SCRIPT_LOG_DIR  = path.join(DATA_DIR, 'script-logs');

function loadFavorites() {
  try {
    if (fs.existsSync(FAVORITES_FILE)) return new Set(JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8')));
  } catch {}
  return new Set();
}
function saveFavorites(set) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FAVORITES_FILE, JSON.stringify([...set], null, 2), 'utf8');
}

const MAX_VERSIONS = 5;

// ── Script run log helpers ───────────────────────────────────────────────────

/**
 * Write full script output to a timestamped file in SCRIPT_LOG_DIR.
 * Returns the absolute path so it can be stored in the audit entry.
 */
function writeScriptLog(runId, scriptLabel, logs) {
  try {
    if (!fs.existsSync(SCRIPT_LOG_DIR)) fs.mkdirSync(SCRIPT_LOG_DIR, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = scriptLabel.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const file = path.join(SCRIPT_LOG_DIR, `${ts}-${safe}.log`);
    const header = `# Script run: ${scriptLabel}\n# Run ID: ${runId}\n# Started: ${new Date().toISOString()}\n\n`;
    fs.writeFileSync(file, header + logs.join('\n') + '\n', 'utf8');
    return file;
  } catch (err) {
    console.error('[script-runner] failed to write script log:', err.message);
    return null;
  }
}

/**
 * Emit an audit entry for a completed script run.
 */
function auditScriptRun({ runId, scriptId, scriptName, region, result, logPath }) {
  const session = awsAuth.getSession();
  audit.log({
    category: 'feature',
    event:    result === 'success' ? 'SCRIPT_RUN_SUCCESS' : 'SCRIPT_RUN_FAILURE',
    message:  `Script "${scriptName}" ran ${result === 'success' ? 'successfully' : 'with errors'}`,
    actor:    session?.identityArn  || null,
    account:  session?.accountId    || null,
    profile:  session?.profile      || null,
    result,
    details: {
      runId,
      scriptId,
      scriptName,
      region: region || 'all',
      logPath: logPath || null,
    },
  });
}

// ── Custom scripts persistence ───────────────────────────────────────────────

function loadCustom() {
  try {
    if (fs.existsSync(CUSTOM_FILE)) return JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveCustom(entries) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CUSTOM_FILE, JSON.stringify(entries, null, 2), 'utf8');
}

// ── Version history persistence ──────────────────────────────────────────────

function loadVersions() {
  try {
    if (fs.existsSync(VERSIONS_FILE)) return JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveVersions(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(VERSIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function addVersion(scriptId, content, label) {
  const data     = loadVersions();
  const versions = data[scriptId] || [];
  versions.push({
    id:        genId(),
    timestamp: new Date().toISOString(),
    label:     label || '',
    content,
    isDefault: false,
  });
  // Ring buffer — keep only the most recent MAX_VERSIONS, drop oldest
  while (versions.length > MAX_VERSIONS) versions.shift();
  data[scriptId] = versions;
  saveVersions(data);
}

// ── AWS client helpers ───────────────────────────────────────────────────────

async function getCredentials() {
  const provider = awsAuth.getCredentialProvider();
  if (!provider) throw new Error('Not authenticated');
  return provider();
}

async function getEc2Client(region) {
  const credentials = await getCredentials();
  return new EC2Client({ credentials, region });
}

async function getElbClient(region) {
  const credentials = await getCredentials();
  return new ElasticLoadBalancingV2Client({ credentials, region });
}

// ── Shell runner — for scripts using AWS CLI ─────────────────────────────────
// Injects all params as UPPER_SNAKE_CASE env vars derived from camelCase param IDs.

/**
 * Check if the `aws` CLI is reachable in the user's login shell.
 * If not, offer to install via Homebrew using a native dialog.
 * Returns { ok: true } if aws is available (or just installed),
 * or { ok: false, error } if the user cancels or install fails.
 */
async function ensureAwsCli(userShell) {
  const available = await new Promise(resolve => {
    exec(`"${userShell}" -l -c "which aws"`, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });

  if (available) return { ok: true };

  const { response } = await dialog.showMessageBox({
    type:      'question',
    buttons:   ['Install via Homebrew', 'Cancel'],
    defaultId: 0,
    cancelId:  1,
    title:     'AWS CLI not found',
    message:   'AWS CLI not found',
    detail:    'The AWS CLI is required to run shell scripts but was not found in your PATH.\n\nInstall it now via Homebrew?\n\n  brew install awscli',
  });

  if (response !== 0) {
    return { ok: false, error: 'AWS CLI is required to run this script. Installation cancelled.' };
  }

  // Run the install in the user's login shell so brew is on PATH
  const installResult = await new Promise(resolve => {
    exec(`"${userShell}" -l -c "brew install awscli"`, { timeout: 300_000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (stderr || err.message).trim() });
      else     resolve({ ok: true });
    });
  });

  if (!installResult.ok) {
    return { ok: false, error: `AWS CLI installation failed: ${installResult.error}` };
  }

  return { ok: true };
}

async function runWithShell(scriptId, region, params) {
  const provider = awsAuth.getCredentialProvider();
  if (!provider) return { ok: false, error: 'Not authenticated' };
  const credentials = await provider();

  const script = PREBAKED.find(s => s.id === scriptId);
  if (!script) return { ok: false, error: `Unknown script: ${scriptId}` };

  const userShell = process.env.SHELL || '/bin/zsh';

  const cliCheck = await ensureAwsCli(userShell);
  if (!cliCheck.ok) return cliCheck;

  const tmpFile = path.join(os.tmpdir(), `maws-script-${Date.now()}.sh`);
  fs.writeFileSync(tmpFile, script.scriptBody, { encoding: 'utf8', mode: 0o700 });
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID:     credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_DEFAULT_REGION:    region || 'us-east-1',
    AWS_REGION:            region || 'us-east-1',
  };
  if (credentials.sessionToken) env.AWS_SESSION_TOKEN = credentials.sessionToken;

  // Inject params as UPPER_SNAKE_CASE env vars
  for (const [key, val] of Object.entries(params || {})) {
    if (val != null) env[camelToSnake(key)] = String(val);
  }

  return new Promise((resolve) => {
    // Run as a login shell so it sources ~/.zprofile / ~/.bash_profile and picks
    // up the user's full PATH (including Homebrew, pyenv, etc.).
    exec(`"${userShell}" -l "${tmpFile}"`, { env, timeout: 300_000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
      const lines    = combined ? combined.split('\n') : [];
      if (err && !stdout.trim()) {
        resolve({ ok: false, error: combined || err.message });
      } else {
        resolve({ ok: true, logs: lines.length ? lines : ['(script produced no output)'] });
      }
    });
  });
}

// ── Prebaked script definitions ─────────────────────────────────────────────

const PREBAKED = [
  // ── Existing scripts ────────────────────────────────────────────────────────

  {
    id:          'convert-gp2-gp3',
    name:        'Convert all GP2 volumes to GP3',
    description: 'Finds all EBS volumes with type gp2 in the selected region and converts them to gp3. GP3 delivers 20% lower cost and 16% better baseline throughput than GP2 at no extra charge.',
    category:    'cost-optimization',
    danger:      false,
    allRegions:  false,
    scriptBody:
`# Finds all gp2 EBS volumes in the target region and converts them to gp3.
# gp3 is cheaper and faster — AWS does not charge for the conversion itself.

aws ec2 describe-volumes \\
  --filters "Name=volume-type,Values=gp2" \\
  --query "Volumes[*].VolumeId" \\
  --output text \\
| tr '\\t' '\\n' \\
| xargs -I{} aws ec2 modify-volume \\
    --volume-id {} \\
    --volume-type gp3 \\
    --output text`,
  },

  {
    id:          'audit-security-groups',
    name:        'Audit Security Group rules',
    description: 'Checks all security groups for inbound rules that allow traffic from 0.0.0.0/0 or ::/0 (open to the entire internet) and reports them so you can review and tighten access.',
    category:    'security',
    danger:      false,
    allRegions:  false,
    scriptBody:
`# Lists security groups that have at least one inbound rule open to 0.0.0.0/0.
# Review the output and restrict rules that don't need global access.

aws ec2 describe-security-groups \\
  --query "SecurityGroups[?IpPermissions[?IpRanges[?CidrIp=='0.0.0.0/0'] || Ipv6Ranges[?CidrIpv6=='::/0']]].[GroupId,GroupName,Description]" \\
  --output table`,
  },

  {
    id:          'lock-default-sg',
    name:        'Lock down default security group in all active regions',
    description: 'Removes all inbound and outbound rules from the default security group in every active AWS region. AWS does not allow default SGs to be deleted, but stripping all rules makes them unusable — nothing can use the group to allow traffic. This satisfies CIS and AWS Foundational Security Best Practices controls.',
    category:    'security',
    danger:      true,
    allRegions:  true,
    scriptBody:
`# Removes all inbound and outbound rules from the default security group in every active region.
# AWS prevents deletion of default SGs, but an empty SG cannot pass any traffic.

for region in $(aws ec2 describe-regions \\
  --query "Regions[*].RegionName" \\
  --output text); do
  SG_ID=$(aws ec2 describe-security-groups \\
    --region "$region" \\
    --filters "Name=group-name,Values=default" \\
    --query "SecurityGroups[0].GroupId" \\
    --output text 2>/dev/null)
  if [ -n "$SG_ID" ] && [ "$SG_ID" != "None" ]; then
    echo "[$region] Revoking all rules on $SG_ID..."
    INGRESS=$(aws ec2 describe-security-groups --region "$region" --group-ids "$SG_ID" \\
      --query "SecurityGroups[0].IpPermissions" --output json 2>/dev/null)
    EGRESS=$(aws ec2 describe-security-groups --region "$region" --group-ids "$SG_ID" \\
      --query "SecurityGroups[0].IpPermissionsEgress" --output json 2>/dev/null)
    [ "$INGRESS" != "[]" ] && [ -n "$INGRESS" ] && \\
      aws ec2 revoke-security-group-ingress --region "$region" --group-id "$SG_ID" \\
        --ip-permissions "$INGRESS" 2>/dev/null
    [ "$EGRESS" != "[]" ] && [ -n "$EGRESS" ] && \\
      aws ec2 revoke-security-group-egress --region "$region" --group-id "$SG_ID" \\
        --ip-permissions "$EGRESS" 2>/dev/null
    echo "[$region] ✓ Locked down $SG_ID"
  else
    echo "[$region] No default SG found"
  fi
done`,
  },

  // ── New scripts ──────────────────────────────────────────────────────────────

  {
    id:          'block-s3-public-access',
    name:        'Block Public Access on all S3 buckets',
    description: 'Iterates every S3 bucket in the account and enables all four Block Public Access settings on each one. This prevents any bucket policy or ACL from granting public access, regardless of region.',
    category:    'security',
    danger:      false,
    allRegions:  false,
    scriptBody:
`# Enables all four S3 Block Public Access settings on every bucket in the account.
# Safe to run — only adds restrictions, never removes them.

BUCKETS=$(aws s3api list-buckets --query "Buckets[*].Name" --output text)

if [ -z "$BUCKETS" ]; then
  echo "No S3 buckets found in this account."
  exit 0
fi

for BUCKET in $BUCKETS; do
  echo "Configuring $BUCKET..."
  aws s3api put-public-access-block \\
    --bucket "$BUCKET" \\
    --public-access-block-configuration \\
      "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" \\
    && echo "  ✓ $BUCKET" \\
    || echo "  ✗ $BUCKET — failed (check permissions or bucket ownership)"
done
echo ""
echo "Done. All Block Public Access settings enabled."`,
  },

  {
    id:          'enable-ebs-encryption-by-default',
    name:        'Require encryption on new EBS volumes (account-level)',
    description: 'Enables the "EBS encryption by default" account-level setting in the selected region. All new EBS volumes and snapshot copies created after this change will be automatically encrypted with the default AWS-managed KMS key. Existing unencrypted volumes are not affected.',
    category:    'security',
    danger:      false,
    allRegions:  false,
    scriptBody:
`# Enables EBS encryption by default for the account in the selected region.
# Only new volumes created after this setting are encrypted — existing ones are not affected.

aws ec2 enable-ebs-encryption-by-default
echo ""
aws ec2 get-ebs-encryption-by-default`,
  },

  {
    id:          'create-idc-user',
    name:        'IAM Identity Center — Create user',
    description: 'Creates a new user in IAM Identity Center (SSO). Lists available Identity Center instances and prompts for first name, last name, and email address. Requires sso-admin:ListInstances and identitystore:CreateUser permissions.',
    category:    'iam',
    danger:      false,
    allRegions:  false,
    params: [
      { id: 'firstName',    label: 'First Name',    type: 'text',  required: true },
      { id: 'lastName',     label: 'Last Name',     type: 'text',  required: true },
      { id: 'email',        label: 'Email Address', type: 'email', required: true },
      {
        id: 'jobFunctions', label: 'Permission Sets (Job Functions)', type: 'multiselect', required: false,
        options: [
          { value: 'arn:aws:iam::aws:policy/AdministratorAccess',            label: 'Administrator Access' },
          { value: 'arn:aws:iam::aws:policy/job-function/Billing',           label: 'Billing' },
          { value: 'arn:aws:iam::aws:policy/job-function/DatabaseAdministrator', label: 'Database Administrator' },
          { value: 'arn:aws:iam::aws:policy/job-function/DataScientist',     label: 'Data Scientist' },
          { value: 'arn:aws:iam::aws:policy/job-function/NetworkAdministrator', label: 'Network Administrator' },
          { value: 'arn:aws:iam::aws:policy/PowerUserAccess',                label: 'Power User Access' },
          { value: 'arn:aws:iam::aws:policy/ReadOnlyAccess',                 label: 'Read Only Access' },
          { value: 'arn:aws:iam::aws:policy/SecurityAudit',                  label: 'Security Audit' },
          { value: 'arn:aws:iam::aws:policy/job-function/SupportUser',       label: 'Support User' },
          { value: 'arn:aws:iam::aws:policy/job-function/SystemAdministrator', label: 'System Administrator' },
          { value: 'arn:aws:iam::aws:policy/job-function/ViewOnlyAccess',    label: 'View Only Access' },
        ],
      },
    ],
    scriptBody:
`# Creates a new IAM Identity Center user.
# Env vars: FIRST_NAME, LAST_NAME, EMAIL

INSTANCE_ARN=$(aws sso-admin list-instances \\
  --query "Instances[0].InstanceArn" --output text 2>/dev/null)
STORE_ID=$(aws sso-admin list-instances \\
  --query "Instances[0].IdentityStoreId" --output text 2>/dev/null)

if [ -z "$INSTANCE_ARN" ] || [ "$INSTANCE_ARN" = "None" ]; then
  echo "✗ No IAM Identity Center instance found."
  echo "  Ensure Identity Center is enabled and you have sso-admin:ListInstances permission."
  exit 1
fi

echo "Instance ARN:   $INSTANCE_ARN"
echo "Identity Store: $STORE_ID"
echo ""
echo "Creating user: $FIRST_NAME $LAST_NAME <$EMAIL>..."

aws identitystore create-user \\
  --identity-store-id "$STORE_ID" \\
  --user-name "$EMAIL" \\
  --name "GivenName=$FIRST_NAME,FamilyName=$LAST_NAME" \\
  --emails "Value=$EMAIL,Type=Work,Primary=true" \\
  && echo "✓ User created successfully." \\
  || echo "✗ Failed — user may already exist or permissions are insufficient."`,
  },

  {
    id:          'enable-cost-alerts',
    name:        'Enable monthly cost alerts',
    description: 'Creates a CloudWatch billing alarm, SNS topic, and email subscription to alert when estimated AWS charges exceed your chosen monthly threshold. Billing alarms must live in us-east-1 regardless of the selected region.',
    category:    'cost-optimization',
    danger:      false,
    allRegions:  false,
    params: [
      {
        id:          'threshold',
        label:       'Monthly spend threshold ($)',
        type:        'select',
        options:     ['50', '100', '250', '500', '1000', '2500', '5000'],
        allowCustom: true,
        required:    true,
        defaultValue: '100',
      },
      { id: 'alertEmail', label: 'Alert email address', type: 'email', required: true },
    ],
    scriptBody:
`# Creates a CloudWatch billing alarm + SNS topic + email subscription.
# Billing alarms must be in us-east-1 regardless of default region.
# Env vars: THRESHOLD, ALERT_EMAIL

THRESHOLD="\${THRESHOLD:-100}"
EMAIL="$ALERT_EMAIL"
TOPIC_NAME="maws-billing-alert-\${THRESHOLD}"

if [ -z "$EMAIL" ]; then
  echo "✗ ALERT_EMAIL is required."
  exit 1
fi

echo "Creating SNS topic: $TOPIC_NAME (us-east-1)..."
TOPIC_ARN=$(aws sns create-topic \\
  --name "$TOPIC_NAME" \\
  --region us-east-1 \\
  --query TopicArn --output text)
echo "  ✓ Topic ARN: $TOPIC_ARN"

echo "Subscribing $EMAIL..."
aws sns subscribe \\
  --topic-arn "$TOPIC_ARN" \\
  --protocol email \\
  --notification-endpoint "$EMAIL" \\
  --region us-east-1 > /dev/null
echo "  ✓ Subscription created (check inbox to confirm)"

echo "Creating CloudWatch billing alarm (threshold: \$$THRESHOLD/month)..."
aws cloudwatch put-metric-alarm \\
  --alarm-name "maws-billing-over-\${THRESHOLD}" \\
  --alarm-description "Monthly AWS charges exceed \$$THRESHOLD" \\
  --metric-name EstimatedCharges \\
  --namespace AWS/Billing \\
  --statistic Maximum \\
  --period 86400 \\
  --threshold "$THRESHOLD" \\
  --comparison-operator GreaterThanThreshold \\
  --dimensions Name=Currency,Value=USD \\
  --evaluation-periods 1 \\
  --alarm-actions "$TOPIC_ARN" \\
  --region us-east-1
echo "  ✓ Alarm created"
echo ""
echo "Done. Confirm the subscription email to activate alerts."`,
  },

  {
    id:          'enforce-imdsv2',
    name:        'Enforce IMDSv2 on all EC2 instances (all regions)',
    description: 'Finds every running EC2 instance across all active regions and sets HttpTokens=required, disabling the legacy IMDSv1 endpoint. IMDSv1 is a common attack vector in SSRF exploits used to steal credentials. Test in non-production first — instances relying solely on IMDSv1 may require code changes.',
    category:    'security',
    danger:      true,
    allRegions:  true,
    scriptBody:
`# DANGER: Sets HttpTokens=required on all running EC2 instances in every region.
# Instances relying on IMDSv1 may fail. Test in dev/staging before production.

for REGION in $(aws ec2 describe-regions --query "Regions[*].RegionName" --output text); do
  INSTANCE_IDS=$(aws ec2 describe-instances \\
    --region "$REGION" \\
    --filters "Name=instance-state-name,Values=running" \\
    --query "Reservations[*].Instances[*].InstanceId" \\
    --output text 2>/dev/null)

  if [ -z "$INSTANCE_IDS" ]; then
    echo "[$REGION] No running instances"
    continue
  fi

  for ID in $INSTANCE_IDS; do
    aws ec2 modify-instance-metadata-options \\
      --instance-id "$ID" \\
      --region "$REGION" \\
      --http-tokens required \\
      --http-endpoint enabled \\
      --output text > /dev/null \\
      && echo "[$REGION] ✓ $ID" \\
      || echo "[$REGION] ✗ $ID — failed"
  done
done
echo ""
echo "Done."`,
  },

  {
    id:          'set-log-retention',
    name:        'Set CloudWatch log retention on all log groups',
    description: 'Sets a retention policy on every CloudWatch log group in the selected region. Log groups without a retention policy accumulate data indefinitely, which can lead to unexpectedly high costs. Defaults to 90 days.',
    category:    'operations',
    danger:      false,
    allRegions:  false,
    params: [
      {
        id:          'retentionDays',
        label:       'Retention period',
        type:        'select',
        options:     ['30', '60', '90', '180', '365'],
        allowCustom: true,
        required:    true,
        defaultValue: '90',
        unit:        'days',
      },
    ],
    scriptBody:
`# Sets the retention policy on all CloudWatch log groups in the selected region.
# Env var: RETENTION_DAYS

DAYS="\${RETENTION_DAYS:-90}"

echo "Setting retention to $DAYS days on all log groups in $AWS_DEFAULT_REGION..."
echo ""

COUNT=0
ERRORS=0

while IFS= read -r GROUP; do
  [ -z "$GROUP" ] && continue
  if aws logs put-retention-policy \\
    --log-group-name "$GROUP" \\
    --retention-in-days "$DAYS" 2>/dev/null; then
    echo "  ✓ $GROUP"
    COUNT=$((COUNT + 1))
  else
    echo "  ✗ $GROUP — failed"
    ERRORS=$((ERRORS + 1))
  fi
done < <(aws logs describe-log-groups \\
  --query "logGroups[*].logGroupName" \\
  --output text | tr '\\t' '\\n')

echo ""
echo "Done. Updated: $COUNT   Errors: $ERRORS"`,
  },

  {
    id:          'setup-alb-access-logs',
    name:        'Enable ALB access logs',
    description: 'Lists Application Load Balancers in the selected region, lets you pick one or all, then enables access logging to an S3 bucket you specify. The bucket must already exist and have the ELB service account bucket policy granting write access.',
    category:    'operations',
    danger:      false,
    allRegions:  false,
    params: [
      {
        id:        'albArn',
        label:     'Load Balancer',
        type:      'dynamic-select',
        fetchIpc:  'script-runner:list-albs',
        allOption: 'All ALBs in region',
        required:  true,
      },
      { id: 'bucketName',   label: 'S3 Bucket Name (must already exist)', type: 'text', required: true, placeholder: 'my-alb-logs-bucket' },
      { id: 'bucketPrefix', label: 'S3 Key Prefix (optional)',             type: 'text', required: false, placeholder: 'alb-logs' },
    ],
    scriptBody:
`# Enables access logging on the selected ALB(s).
# Env vars: ALB_ARN, BUCKET_NAME, BUCKET_PREFIX

BUCKET="\${BUCKET_NAME}"
PREFIX="\${BUCKET_PREFIX:-alb-logs}"
TARGET_ARN="\${ALB_ARN}"

if [ -z "$BUCKET" ]; then
  echo "✗ BUCKET_NAME is required."
  exit 1
fi

enable_logs() {
  local ARN="$1"
  local NAME=$(echo "$ARN" | sed 's|.*loadbalancer/||')
  echo "Enabling logs on $NAME..."
  aws elbv2 modify-load-balancer-attributes \\
    --load-balancer-arn "$ARN" \\
    --attributes \\
      "Key=access_logs.s3.enabled,Value=true" \\
      "Key=access_logs.s3.bucket,Value=$BUCKET" \\
      "Key=access_logs.s3.prefix,Value=$PREFIX" \\
    --output text > /dev/null \\
    && echo "  ✓ $NAME" \\
    || echo "  ✗ $NAME — failed (check bucket policy)"
}

if [ "$TARGET_ARN" = "__ALL__" ]; then
  echo "Enabling access logs on all ALBs in $AWS_DEFAULT_REGION..."
  echo ""
  aws elbv2 describe-load-balancers \\
    --query "LoadBalancers[?Type=='application'].LoadBalancerArn" \\
    --output text | tr '\\t' '\\n' | while read -r ARN; do
    [ -n "$ARN" ] && enable_logs "$ARN"
  done
else
  enable_logs "$TARGET_ARN"
fi

echo ""
echo "Logs will be written to s3://\${BUCKET}/\${PREFIX}/"
echo "Note: Bucket must have the ELB service account bucket policy attached."`,
  },

  {
    id:          'check-ec2-tenancy',
    name:        'Check EC2 instance tenancy (dedicated → shared)',
    description: 'Scans all EC2 instances in the selected region for dedicated or host tenancy. Dedicated instances carry a $2/region/hour surcharge plus a per-instance premium. ⚠ In remediate mode this script will STOP running instances to change their tenancy, then restart them — this causes downtime. Host tenancy instances are flagged for manual review and are never touched.',
    category:    'cost-optimization',
    danger:      true,
    allRegions:  false,
    params: [
      {
        id:           'mode',
        label:        'Mode',
        type:         'select',
        options:      ['report', 'remediate'],
        defaultValue: 'report',
        required:     true,
      },
    ],
    scriptBody: `# Checks EC2 tenancy (handled by MAWS SDK runner).`,
  },

  {
    id:          'delete-unused-sgs',
    name:        'Delete unused security groups',
    description: 'Finds security groups in the selected region that are not attached to any network interface (EC2, RDS, Lambda, ELB, etc.) and not referenced as a source/destination in any other security group\'s rules. Default security groups are skipped as AWS does not permit deleting them. Runs a dry-run preview by default.',
    category:    'security',
    danger:      true,
    allRegions:  false,
    params: [
      {
        id:           'dryRun',
        label:        'Mode',
        type:         'select',
        options:      ['dry-run', 'delete'],
        defaultValue: 'dry-run',
        required:     true,
      },
    ],
    scriptBody: `# Deletes unused security groups (handled by MAWS SDK runner).`,
  },

  {
    id:          'delete-orphaned-amis',
    name:        'Delete orphaned AMIs',
    description: 'Finds AMIs owned by this account that are not referenced by any running or stopped instance, or by any launch template version. Deregisters each orphaned AMI and deletes its backing EBS snapshots. Runs a dry-run preview by default.',
    category:    'cost-optimization',
    danger:      true,
    allRegions:  false,
    params: [
      {
        id:           'dryRun',
        label:        'Mode',
        type:         'select',
        options:      ['dry-run', 'delete'],
        defaultValue: 'dry-run',
        required:     true,
      },
    ],
    scriptBody: `# Deletes orphaned AMIs (handled by MAWS SDK runner).`,
  },

  {
    id:          'delete-unused-volumes',
    name:        'Delete unused EBS volumes',
    description: 'Finds EBS volumes in the selected region with state "available" (not attached to any instance) and deletes them. Calculates estimated monthly savings based on volume type and size. Runs a dry-run preview by default.',
    category:    'cost-optimization',
    danger:      true,
    allRegions:  false,
    params: [
      {
        id:           'dryRun',
        label:        'Mode',
        type:         'select',
        options:      ['dry-run', 'delete'],
        defaultValue: 'dry-run',
        required:     true,
      },
    ],
    scriptBody: `# Deletes unused EBS volumes (handled by MAWS SDK runner).`,
  },

  {
    id:          'release-unattached-eips',
    name:        'Release unattached Elastic IPs',
    description: 'Finds every Elastic IP in the selected region that is not associated with a running instance or network interface and releases it. AWS charges ~$0.005/hr per unattached EIP. Runs a dry-run preview first so you can confirm before anything is deleted.',
    category:    'cost-optimization',
    danger:      true,
    allRegions:  false,
    params: [
      {
        id:           'dryRun',
        label:        'Mode',
        type:         'select',
        options:      ['dry-run', 'release'],
        defaultValue: 'dry-run',
        required:     true,
      },
    ],
    scriptBody: `# Releases unattached Elastic IPs (handled by MAWS SDK runner).`,
  },

  {
    id:          'enable-guardduty',
    name:        'Enable Amazon GuardDuty',
    description: 'Enables GuardDuty threat detection in the selected region. If a detector already exists, updates its protection plans. Choose which optional features to activate — S3, EKS, RDS, Lambda, Malware Protection, and Runtime Monitoring are all opt-in.',
    category:    'security',
    danger:      false,
    allRegions:  false,
    params: [
      {
        id: 'features', label: 'Protection plans', type: 'multiselect', required: false,
        options: [
          { value: 'S3_DATA_EVENTS',        label: 'S3 Protection — monitor S3 data events for threats' },
          { value: 'EKS_AUDIT_LOGS',         label: 'EKS Audit Log Monitoring' },
          { value: 'EKS_RUNTIME_MONITORING', label: 'EKS Runtime Monitoring' },
          { value: 'EBS_MALWARE_PROTECTION', label: 'Malware Protection for EC2 (EBS scanning)' },
          { value: 'RDS_LOGIN_EVENTS',       label: 'RDS Login Activity Monitoring' },
          { value: 'LAMBDA_NETWORK_LOGS',    label: 'Lambda Network Activity Monitoring' },
          { value: 'RUNTIME_MONITORING',     label: 'Runtime Monitoring (EC2 / ECS)' },
        ],
      },
    ],
    scriptBody: `# Enables Amazon GuardDuty (handled by MAWS SDK runner).`,
  },

  {
    id:          'enable-macie',
    name:        'Enable Amazon Macie',
    description: 'Enables Amazon Macie in the selected region to automatically discover and protect sensitive data (PII, credentials, financial data) stored in S3. Skips gracefully if Macie is already enabled. Configures the finding publishing frequency.',
    category:    'security',
    danger:      false,
    allRegions:  false,
    params: [
      {
        id:           'publishingFrequency',
        label:        'Finding publishing frequency',
        type:         'select',
        options:      ['FIFTEEN_MINUTES', 'ONE_HOUR', 'SIX_HOURS'],
        defaultValue: 'ONE_HOUR',
        required:     true,
      },
    ],
    scriptBody: `# Enables Amazon Macie (handled by MAWS SDK runner).`,
  },

  {
    id:          'enable-cloudtrail',
    name:        'Enable CloudTrail (multi-region)',
    description: 'Creates a CloudTrail trail that logs management events across all regions to a dedicated S3 bucket. Creates the bucket and attaches the required CloudTrail bucket policy automatically. Skips creation if a multi-region trail already exists. Enables log file validation and global service events.',
    category:    'security',
    danger:      false,
    allRegions:  false,
    params: [
      { id: 'trailName',  label: 'Trail name',      type: 'text', required: true,  defaultValue: 'maws-cloudtrail',   placeholder: 'maws-cloudtrail' },
      { id: 'bucketName', label: 'S3 bucket name',  type: 'text', required: false, placeholder: 'Auto-generated from account ID' },
    ],
    scriptBody: `# Enables CloudTrail multi-region logging (handled by MAWS SDK runner).`,
  },

  {
    id:          'enable-detective',
    name:        'Enable Amazon Detective',
    description: 'Enables Amazon Detective in the selected region by creating a behavior graph. Detective automatically collects log data from GuardDuty, CloudTrail, VPC Flow Logs, and EKS to build a security graph for threat investigation. Skips gracefully if Detective is already enabled. Note: Detective requires GuardDuty to be enabled first.',
    category:    'security',
    danger:      false,
    allRegions:  false,
    params: [
      {
        id:           'enableAutoEnable',
        label:        'Auto-enable for new organization accounts',
        type:         'select',
        options:      ['No', 'Yes'],
        defaultValue: 'No',
        required:     false,
      },
    ],
    scriptBody: `# Enables Amazon Detective (handled by MAWS SDK runner).`,
  },
];

// ── Prebaked SDK runners ─────────────────────────────────────────────────────

async function runConvertGp2Gp3(region) {
  const client = await getEc2Client(region);
  const logs   = [];

  let nextToken;
  const volumes = [];
  do {
    const resp = await client.send(new DescribeVolumesCommand({
      Filters:   [{ Name: 'volume-type', Values: ['gp2'] }],
      NextToken: nextToken,
    }));
    volumes.push(...(resp.Volumes || []));
    nextToken = resp.NextToken;
  } while (nextToken);

  if (!volumes.length) {
    return { ok: true, logs: [`No gp2 volumes found in ${region}. Nothing to do.`] };
  }

  logs.push(`Found ${volumes.length} gp2 volume(s) in ${region}. Converting…`);

  for (const v of volumes) {
    try {
      await client.send(new ModifyVolumeCommand({ VolumeId: v.VolumeId, VolumeType: 'gp3' }));
      const name = (v.Tags || []).find(t => t.Key === 'Name')?.Value;
      logs.push(`  ✓ ${v.VolumeId}${name ? ' (' + name + ')' : ''} → gp3`);
    } catch (err) {
      logs.push(`  ✗ ${v.VolumeId} — ${err.message}`);
    }
  }

  logs.push('');
  logs.push('Done. Note: conversion may take several minutes to complete in AWS.');
  return { ok: true, logs };
}

async function runAuditSecurityGroups(region) {
  const client = await getEc2Client(region);
  const logs   = [];

  let nextToken;
  const sgs = [];
  do {
    const resp = await client.send(new DescribeSecurityGroupsCommand({ NextToken: nextToken }));
    sgs.push(...(resp.SecurityGroups || []));
    nextToken = resp.NextToken;
  } while (nextToken);

  const findings = [];
  for (const sg of sgs) {
    for (const perm of sg.IpPermissions || []) {
      const openV4 = (perm.IpRanges  || []).filter(r => r.CidrIp    === '0.0.0.0/0');
      const openV6 = (perm.Ipv6Ranges || []).filter(r => r.CidrIpv6 === '::/0');
      if (!openV4.length && !openV6.length) continue;

      const proto = perm.IpProtocol === '-1' ? 'ALL TRAFFIC' : perm.IpProtocol?.toUpperCase();
      const port  = perm.FromPort != null
        ? (perm.FromPort === perm.ToPort ? String(perm.FromPort) : `${perm.FromPort}–${perm.ToPort}`)
        : '*';
      const cidrs = [...openV4.map(r => r.CidrIp), ...openV6.map(r => r.CidrIpv6)].join(', ');

      findings.push({ sg, proto, port, cidrs });
    }
  }

  if (!findings.length) {
    return {
      ok:   true,
      logs: [
        `✓ Scanned ${sgs.length} security group(s) in ${region}.`,
        '  No inbound rules open to 0.0.0.0/0 or ::/0 found.',
      ],
    };
  }

  logs.push(`⚠  Scanned ${sgs.length} security group(s) in ${region}.`);
  logs.push(`   Found ${findings.length} rule(s) open to the world:\n`);
  for (const { sg, proto, port, cidrs } of findings) {
    logs.push(`  ${sg.GroupId} (${sg.GroupName})`);
    logs.push(`    ${proto}  port ${port}  from ${cidrs}`);
    if (sg.Description) logs.push(`    Description: ${sg.Description}`);
    logs.push('');
  }

  return { ok: true, logs };
}

async function runLockDefaultSg() {
  const credentials = await getCredentials();
  const logs        = [];
  const ec2Base     = new EC2Client({ credentials, region: 'us-east-1' });

  const regionsResp = await ec2Base.send(new DescribeRegionsCommand({ AllRegions: false }));
  const regions     = (regionsResp.Regions || []).map(r => r.RegionName);
  logs.push(`Scanning ${regions.length} active region(s)…\n`);

  for (const region of regions) {
    try {
      const client = new EC2Client({ credentials, region });
      const resp   = await client.send(new DescribeSecurityGroupsCommand({
        Filters: [{ Name: 'group-name', Values: ['default'] }],
      }));
      const defaultSg = (resp.SecurityGroups || []).find(sg => sg.GroupName === 'default');

      if (!defaultSg) {
        logs.push(`  ${region}: no default SG found`);
        continue;
      }

      const groupId = defaultSg.GroupId;
      const ingress = defaultSg.IpPermissions        || [];
      const egress  = defaultSg.IpPermissionsEgress  || [];
      let changed   = false;

      try {
        if (ingress.length) {
          await client.send(new RevokeSecurityGroupIngressCommand({ GroupId: groupId, IpPermissions: ingress }));
          changed = true;
        }
        if (egress.length) {
          await client.send(new RevokeSecurityGroupEgressCommand({ GroupId: groupId, IpPermissions: egress }));
          changed = true;
        }
        logs.push(changed
          ? `  ${region}: ✓ locked down ${groupId} (removed ${ingress.length} ingress, ${egress.length} egress rule(s))`
          : `  ${region}: ${groupId} already has no rules`);
      } catch (err) {
        logs.push(`  ${region}: ✗ ${err.message}`);
      }
    } catch (err) {
      logs.push(`  ${region}: ✗ ${err.message}`);
    }
  }

  logs.push('\nDone.');
  return { ok: true, logs };
}

async function runEnableEbsEncryption(region) {
  const client = await getEc2Client(region);
  const logs   = [];

  try {
    const resp = await client.send(new EnableEbsEncryptionByDefaultCommand({}));
    if (resp.EbsEncryptionByDefault) {
      logs.push(`✓ EBS encryption by default is now ENABLED in ${region}.`);
    } else {
      logs.push(`⚠  EnableEbsEncryptionByDefault returned an unexpected state. Please verify in the console.`);
    }
    logs.push('');
    logs.push('Note: Existing unencrypted volumes are not affected. Only new volumes and');
    logs.push('snapshot copies created after this point will be automatically encrypted.');
  } catch (err) {
    logs.push(`✗ Failed: ${err.message}`);
  }

  return { ok: true, logs };
}

async function runEnforceImdsv2() {
  const credentials = await getCredentials();
  const logs        = [];
  const ec2Base     = new EC2Client({ credentials, region: 'us-east-1' });

  const regResp = await ec2Base.send(new DescribeRegionsCommand({ AllRegions: false }));
  const regions = (regResp.Regions || []).map(r => r.RegionName);
  logs.push(`Scanning ${regions.length} active region(s) for running instances…\n`);

  let total = 0;
  let updated = 0;

  for (const region of regions) {
    try {
      const client    = new EC2Client({ credentials, region });
      const instances = [];
      let nextToken;
      do {
        const resp = await client.send(new DescribeInstancesCommand({
          Filters:   [{ Name: 'instance-state-name', Values: ['running'] }],
          NextToken: nextToken,
        }));
        for (const r of resp.Reservations || []) instances.push(...(r.Instances || []));
        nextToken = resp.NextToken;
      } while (nextToken);

      if (!instances.length) {
        logs.push(`  ${region}: no running instances`);
        continue;
      }

      logs.push(`  ${region}: ${instances.length} running instance(s)`);
      total += instances.length;

      for (const inst of instances) {
        try {
          await client.send(new ModifyInstanceMetadataOptionsCommand({
            InstanceId:   inst.InstanceId,
            HttpTokens:   'required',
            HttpEndpoint: 'enabled',
          }));
          logs.push(`    ✓ ${inst.InstanceId}`);
          updated++;
        } catch (err) {
          logs.push(`    ✗ ${inst.InstanceId} — ${err.message}`);
        }
      }
    } catch (err) {
      logs.push(`  ${region}: ✗ ${err.message}`);
    }
  }

  logs.push('');
  logs.push(`Done. Updated ${updated} of ${total} running instance(s) to require IMDSv2.`);
  return { ok: true, logs };
}

async function runSetupAlbAccessLogs(region, params) {
  const { albArn, bucketName, bucketPrefix = 'alb-logs' } = params;
  if (!bucketName) return { ok: false, error: 'bucketName is required.' };

  const client = await getElbClient(region);
  const logs   = [];

  const attributes = [
    { Key: 'access_logs.s3.enabled', Value: 'true'       },
    { Key: 'access_logs.s3.bucket',  Value: bucketName   },
    { Key: 'access_logs.s3.prefix',  Value: bucketPrefix },
  ];

  const targets = [];

  if (albArn === '__ALL__') {
    let marker;
    do {
      const resp = await client.send(new DescribeLoadBalancersCommand({ Marker: marker }));
      for (const lb of resp.LoadBalancers || []) {
        if (lb.Type === 'application') targets.push(lb);
      }
      marker = resp.NextMarker;
    } while (marker);

    if (!targets.length) {
      return { ok: true, logs: [`No Application Load Balancers found in ${region}.`] };
    }
    logs.push(`Found ${targets.length} ALB(s) in ${region}. Enabling access logs…\n`);
  } else {
    const resp = await client.send(new DescribeLoadBalancersCommand({
      LoadBalancerArns: [albArn],
    }));
    targets.push(...(resp.LoadBalancers || []));
  }

  for (const lb of targets) {
    try {
      await client.send(new ModifyLoadBalancerAttributesCommand({
        LoadBalancerArn: lb.LoadBalancerArn,
        Attributes:      attributes,
      }));
      logs.push(`  ✓ ${lb.LoadBalancerName}`);
    } catch (err) {
      logs.push(`  ✗ ${lb.LoadBalancerName} — ${err.message}`);
    }
  }

  logs.push('');
  logs.push(`Access logs will be written to s3://${bucketName}/${bucketPrefix}/`);
  logs.push('Note: The S3 bucket must have the ELB service account bucket policy in place.');
  return { ok: true, logs };
}

// ── Custom script runner (shell) ─────────────────────────────────────────────

async function runCustomScript(body, region) {
  const provider = awsAuth.getCredentialProvider();
  if (!provider) return { ok: false, error: 'Not authenticated' };

  const credentials = await provider();

  const userShell = process.env.SHELL || '/bin/zsh';

  const cliCheck = await ensureAwsCli(userShell);
  if (!cliCheck.ok) return cliCheck;

  const tmpFile = path.join(os.tmpdir(), `maws-script-${Date.now()}.sh`);
  fs.writeFileSync(tmpFile, body, { encoding: 'utf8', mode: 0o700 });
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID:     credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_DEFAULT_REGION:    region,
    AWS_REGION:            region,
  };
  if (credentials.sessionToken) env.AWS_SESSION_TOKEN = credentials.sessionToken;

  return new Promise((resolve) => {
    exec(`"${userShell}" -l "${tmpFile}"`, { env, timeout: 120_000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
      const lines    = combined ? combined.split('\n') : [];

      if (err && !stdout.trim()) {
        resolve({ ok: false, error: combined || err.message });
      } else {
        resolve({ ok: true, logs: lines.length ? lines : ['(script produced no output)'] });
      }
    });
  });
}

async function runCreateIdcUser({ firstName, lastName, email, jobFunctions }) {
  const credentials = await getCredentials();
  const session     = awsAuth.getSession();
  const logs        = [];

  // Look up the Identity Center instance
  const ssoClient = new SSOAdminClient({ credentials, region: 'us-east-1' });
  const { Instances } = await ssoClient.send(new ListSSOInstancesCommand({}));
  if (!Instances || Instances.length === 0) {
    return { ok: false, error: 'No IAM Identity Center instance found. Ensure Identity Center is enabled and you have sso-admin:ListInstances permission.' };
  }

  const { InstanceArn, IdentityStoreId } = Instances[0];
  logs.push(`Instance ARN:   ${InstanceArn}`);
  logs.push(`Identity Store: ${IdentityStoreId}`);
  logs.push('');
  logs.push(`Creating user: ${firstName} ${lastName} <${email}>...`);

  const idClient = new IdentitystoreClient({ credentials, region: 'us-east-1' });
  const resp = await idClient.send(new CreateUserCommand({
    IdentityStoreId: IdentityStoreId,
    UserName:        email,
    DisplayName:     `${firstName} ${lastName}`,
    Name:            { GivenName: firstName, FamilyName: lastName },
    Emails:          [{ Value: email, Type: 'Work', Primary: true }],
  }));

  const userId     = resp.UserId;
  const consoleUrl = `https://console.aws.amazon.com/singlesignon/home#!/users`;
  logs.push(`✓ User created. UserId: ${userId}`);
  logs.push('');
  logs.push(`⚠ Email verification required — the API does not auto-send a verification email.`);
  logs.push(`  Find the user in IAM Identity Center and click "Send email verification":`);
  logs.push(`  ${consoleUrl}`);

  // ── Permission set assignment ─────────────────────────────────────────────
  const selectedPolicies = Array.isArray(jobFunctions) ? jobFunctions
    : (jobFunctions ? [jobFunctions] : []);

  if (selectedPolicies.length > 0 && session?.accountId) {
    logs.push('');
    logs.push('Assigning permission sets...');

    // Fetch existing permission sets once so we can reuse them
    const existingSets = {};
    try {
      let nextToken;
      do {
        const r = await ssoClient.send(new ListPermissionSetsCommand({ InstanceArn, NextToken: nextToken }));
        for (const psArn of r.PermissionSets || []) {
          const d = await ssoClient.send(new DescribePermissionSetCommand({ InstanceArn, PermissionSetArn: psArn }));
          existingSets[d.PermissionSet.Name] = psArn;
        }
        nextToken = r.NextToken;
      } while (nextToken);
    } catch (e) {
      logs.push(`  ⚠ Could not list existing permission sets: ${e.message}`);
    }

    for (const policyArn of selectedPolicies) {
      // Derive a friendly name from the policy ARN
      const policyName = policyArn.split('/').pop();
      const psName     = `MAWS-${policyName}`;

      try {
        let psArn = existingSets[psName];

        if (psArn) {
          logs.push(`  ↳ Reusing existing permission set: ${psName}`);
        } else {
          logs.push(`  ↳ Creating permission set: ${psName}...`);
          const created = await ssoClient.send(new CreatePermissionSetCommand({
            InstanceArn,
            Name:            psName,
            Description:     `Managed by MAWS - ${policyName}`,
            SessionDuration: 'PT8H',
          }));
          psArn = created.PermissionSet.PermissionSetArn;
          await ssoClient.send(new AttachManagedPolicyToPermissionSetCommand({
            InstanceArn,
            PermissionSetArn:  psArn,
            ManagedPolicyArn:  policyArn,
          }));
          logs.push(`    ✓ Permission set created and policy attached.`);
        }

        // Assign to user in the current account
        await ssoClient.send(new CreateAccountAssignmentCommand({
          InstanceArn,
          TargetId:         session.accountId,
          TargetType:       'AWS_ACCOUNT',
          PermissionSetArn: psArn,
          PrincipalType:    'USER',
          PrincipalId:      userId,
        }));
        logs.push(`    ✓ Assigned ${psName} to user in account ${session.accountId}.`);

      } catch (e) {
        logs.push(`    ✗ Failed to assign ${policyName}: ${e.message}`);
      }
    }
  }

  return { ok: true, logs };
}

async function runEnableCostAlerts({ threshold, alertEmail }) {
  const credentials = await getCredentials();
  const logs        = [];
  const amount      = String(threshold || '100');
  const topicName   = `maws-billing-alert-${amount}`;

  // SNS — billing alarms must live in us-east-1
  const sns = new SNSClient({ credentials, region: 'us-east-1' });

  logs.push(`Creating SNS topic: ${topicName} (us-east-1)...`);
  const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: topicName }));
  logs.push(`  ✓ Topic ARN: ${TopicArn}`);

  logs.push(`Subscribing ${alertEmail}...`);
  await sns.send(new SubscribeCommand({
    TopicArn: TopicArn,
    Protocol: 'email',
    Endpoint: alertEmail,
  }));
  logs.push('  ✓ Subscription created (check inbox to confirm)');

  // CloudWatch billing alarm
  logs.push(`Creating CloudWatch billing alarm (threshold: $${amount}/month)...`);
  const cw = new CloudWatchClient({ credentials, region: 'us-east-1' });
  await cw.send(new PutMetricAlarmCommand({
    AlarmName:          `maws-billing-over-${amount}`,
    AlarmDescription:   `Monthly AWS charges exceed $${amount}`,
    MetricName:         'EstimatedCharges',
    Namespace:          'AWS/Billing',
    Statistic:          'Maximum',
    Period:             86400,
    Threshold:          Number(amount),
    ComparisonOperator: 'GreaterThanThreshold',
    Dimensions:         [{ Name: 'Currency', Value: 'USD' }],
    EvaluationPeriods:  1,
    AlarmActions:       [TopicArn],
  }));
  logs.push('  ✓ Alarm created');
  logs.push('');
  logs.push('Done. Confirm the subscription email to activate alerts.');
  return { ok: true, logs };
}

async function runSetLogRetention(region, { retentionDays }) {
  const credentials = await getCredentials();
  const logs        = [];
  const days        = Number(retentionDays || 90);
  const cwl         = new CloudWatchLogsClient({ credentials, region });

  logs.push(`Setting retention to ${days} days on all log groups in ${region}...`);
  logs.push('');

  // Paginate through all log groups
  const groups = [];
  let nextToken;
  do {
    const resp = await cwl.send(new DescribeLogGroupsCommand({ nextToken }));
    for (const g of resp.logGroups || []) groups.push(g.logGroupName);
    nextToken = resp.nextToken;
  } while (nextToken);

  if (groups.length === 0) {
    logs.push('No log groups found in this region.');
    return { ok: true, logs };
  }

  let count = 0, errors = 0;
  for (const name of groups) {
    try {
      await cwl.send(new PutRetentionPolicyCommand({ logGroupName: name, retentionInDays: days }));
      logs.push(`  ✓ ${name}`);
      count++;
    } catch (err) {
      logs.push(`  ✗ ${name} — ${err.message}`);
      errors++;
    }
  }

  logs.push('');
  logs.push(`Done. Updated: ${count}   Errors: ${errors}`);
  return { ok: true, logs };
}

async function runBlockS3PublicAccess() {
  const credentials = await getCredentials();
  const logs        = [];

  const s3Base     = new S3Client({ credentials, region: 'us-east-1' });
  const { Buckets } = await s3Base.send(new ListBucketsCommand({}));

  if (!Buckets || Buckets.length === 0) {
    logs.push('No S3 buckets found in this account.');
    return { ok: true, logs };
  }

  logs.push(`Found ${Buckets.length} bucket(s). Enabling Block Public Access on each…\n`);

  const config = {
    BlockPublicAcls:       true,
    IgnorePublicAcls:      true,
    BlockPublicPolicy:     true,
    RestrictPublicBuckets: true,
  };

  for (const { Name: bucket } of Buckets) {
    try {
      // Check current state first so we can report no-ops
      let alreadyBlocked = false;
      try {
        const current = await new S3Client({ credentials, region: 'us-east-1' })
          .send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
        const b = current.PublicAccessBlockConfiguration || {};
        alreadyBlocked = b.BlockPublicAcls && b.IgnorePublicAcls && b.BlockPublicPolicy && b.RestrictPublicBuckets;
      } catch { /* bucket may not have a config yet — treat as not blocked */ }

      if (alreadyBlocked) {
        logs.push(`  ${bucket}: already fully blocked — skipped`);
        continue;
      }

      // S3 is global but bucket operations must hit the bucket's own region
      const locClient  = new S3Client({ credentials, region: 'us-east-1' });
      let   bucketRegion = 'us-east-1';
      try {
        const loc = await locClient.send(new GetBucketLocationCommand({ Bucket: bucket }));
        bucketRegion = loc.LocationConstraint || 'us-east-1';
      } catch { /* fall back to us-east-1 */ }

      const client = new S3Client({ credentials, region: bucketRegion });
      await client.send(new PutPublicAccessBlockCommand({
        Bucket: bucket,
        PublicAccessBlockConfiguration: config,
      }));
      logs.push(`  ${bucket}: ✓ blocked`);
    } catch (err) {
      logs.push(`  ${bucket}: ✗ ${err.message}`);
    }
  }

  logs.push('\nDone.');
  return { ok: true, logs };
}

async function runEnableCloudTrail(region, { trailName, bucketName }) {
  const credentials = await getCredentials();
  const session     = awsAuth.getSession();
  const accountId   = session?.accountId;
  const logs        = [];

  if (!accountId) return { ok: false, error: 'Could not determine account ID from session.' };

  const bucket = bucketName?.trim() || `aws-cloudtrail-logs-${accountId}`;
  const trail  = trailName?.trim()  || 'maws-cloudtrail';

  const {
    CloudTrailClient,
    GetTrailStatusCommand,
    DescribeTrailsCommand,
    CreateTrailCommand,
    StartLoggingCommand,
    PutEventSelectorsCommand,
  } = getCloudTrailSdk();

  // ── Check for an existing multi-region trail ─────────────────────────────
  const ctClient = new CloudTrailClient({ credentials, region });
  const { trailList } = await ctClient.send(new DescribeTrailsCommand({ includeShadowTrails: false }));
  const existing = (trailList || []).find(t => t.IsMultiRegionTrail);
  if (existing) {
    logs.push(`✓ A multi-region trail already exists: ${existing.TrailARN}`);
    const status = await ctClient.send(new GetTrailStatusCommand({ Name: existing.TrailARN }));
    if (status.IsLogging) {
      logs.push('  Logging is active. Nothing to do.');
    } else {
      logs.push('  Logging was stopped - restarting...');
      await ctClient.send(new StartLoggingCommand({ Name: existing.TrailARN }));
      logs.push('  ✓ Logging started.');
    }
    return { ok: true, logs };
  }

  // ── Create the S3 bucket ─────────────────────────────────────────────────
  logs.push(`Creating S3 bucket: ${bucket} (${region})...`);
  const s3 = new S3Client({ credentials, region });
  try {
    const createArgs = { Bucket: bucket };
    if (region !== 'us-east-1') {
      createArgs.CreateBucketConfiguration = { LocationConstraint: region };
    }
    await s3.send(new CreateBucketCommand(createArgs));
    logs.push(`  ✓ Bucket created.`);
  } catch (err) {
    if (err.name === 'BucketAlreadyOwnedByYou' || err.name === 'BucketAlreadyExists') {
      logs.push(`  ✓ Bucket already exists — reusing.`);
    } else {
      throw err;
    }
  }

  // Block public access on the log bucket
  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: bucket,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, IgnorePublicAcls: true,
      BlockPublicPolicy: true, RestrictPublicBuckets: true,
    },
  }));

  // Attach the CloudTrail-required bucket policy
  const bucketPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid:       'AWSCloudTrailAclCheck',
        Effect:    'Allow',
        Principal: { Service: 'cloudtrail.amazonaws.com' },
        Action:    's3:GetBucketAcl',
        Resource:  `arn:aws:s3:::${bucket}`,
      },
      {
        Sid:       'AWSCloudTrailWrite',
        Effect:    'Allow',
        Principal: { Service: 'cloudtrail.amazonaws.com' },
        Action:    's3:PutObject',
        Resource:  `arn:aws:s3:::${bucket}/AWSLogs/${accountId}/*`,
        Condition: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' } },
      },
    ],
  });
  await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: bucketPolicy }));
  logs.push('  ✓ CloudTrail bucket policy attached.');

  // ── Create the trail ─────────────────────────────────────────────────────
  logs.push(`Creating trail: ${trail}...`);
  const createResp = await ctClient.send(new CreateTrailCommand({
    Name:                       trail,
    S3BucketName:               bucket,
    IsMultiRegionTrail:         true,
    IncludeGlobalServiceEvents: true,
    EnableLogFileValidation:    true,
  }));
  logs.push(`  ✓ Trail created: ${createResp.TrailARN}`);

  // Enable management event selectors (read + write)
  await ctClient.send(new PutEventSelectorsCommand({
    TrailName: trail,
    EventSelectors: [{
      ReadWriteType:                 'All',
      IncludeManagementEvents:       true,
      ExcludeManagementEventSources: [],
    }],
  }));
  logs.push('  ✓ Management events (read + write) enabled.');

  // Start logging
  await ctClient.send(new StartLoggingCommand({ Name: trail }));
  logs.push('  ✓ Logging started.');
  logs.push('');
  logs.push(`✓ CloudTrail is now active. Logs will be delivered to s3://${bucket}/AWSLogs/${accountId}/`);

  audit.log({
    category: 'script',
    event:    'SCRIPT_RUN_SUCCESS',
    message:  `CloudTrail enabled — trail "${trail}" logging to s3://${bucket}`,
    actor:    session?.identityArn || null,
    account:  accountId,
    result:   'success',
    details:  { scriptId: 'enable-cloudtrail', trailName: trail, bucket },
  });

  return { ok: true, logs };
}

async function runCheckEc2Tenancy(region, { mode }) {
  const client  = await getEc2Client(region);
  const session = awsAuth.getSession();
  const logs    = [];
  const remediate = mode === 'remediate';

  logs.push(`Scanning EC2 instances for non-shared tenancy in ${region}...`);

  // Collect all instances
  const instances = [];
  let nextToken;
  do {
    const r = await client.send(new DescribeInstancesCommand({ NextToken: nextToken }));
    for (const res of r.Reservations || []) {
      instances.push(...(res.Instances || []));
    }
    nextToken = r.NextToken;
  } while (nextToken);

  // Filter for non-default tenancy (skip terminated)
  const nonShared = instances.filter(i =>
    i.Placement?.Tenancy !== 'default' &&
    i.State?.Name !== 'terminated' &&
    i.State?.Name !== 'shutting-down'
  );

  if (nonShared.length === 0) {
    logs.push(`✓ All ${instances.length} instance(s) are on shared tenancy. No action needed.`);
    return { ok: true, logs };
  }

  const dedicated = nonShared.filter(i => i.Placement?.Tenancy === 'dedicated');
  const hostTenancy = nonShared.filter(i => i.Placement?.Tenancy === 'host');

  logs.push(`Found ${nonShared.length} instance(s) not on shared tenancy:`);
  logs.push('');

  for (const i of nonShared) {
    const name    = i.Tags?.find(t => t.Key === 'Name')?.Value || '';
    const tenancy = i.Placement?.Tenancy;
    const state   = i.State?.Name;
    logs.push(`  ${i.InstanceId}  ${i.InstanceType}  tenancy=${tenancy}  state=${state}${name ? '  [' + name + ']' : ''}`);
  }

  logs.push('');
  logs.push('  Note: Dedicated instances incur a $2/region/hour surcharge plus a per-instance');
  logs.push('  premium of 10-70% depending on instance type.');

  if (hostTenancy.length > 0) {
    logs.push('');
    logs.push(`  ⚠ ${hostTenancy.length} instance(s) on host tenancy — these cannot be automatically`);
    logs.push('  converted and must be migrated manually (snapshot → new instance on shared tenancy).');
  }

  if (!remediate) {
    logs.push('');
    logs.push('  Re-run with mode set to "remediate" to convert dedicated instances to shared tenancy.');
    logs.push('  ⚠ Remediate mode will stop and restart each dedicated instance.');
    return { ok: true, logs };
  }

  if (dedicated.length === 0) {
    logs.push('  No dedicated instances to remediate (host tenancy must be handled manually).');
    return { ok: true, logs };
  }

  logs.push('');
  logs.push(`Remediating ${dedicated.length} dedicated instance(s)...`);

  let converted = 0;
  let failed    = 0;

  for (const inst of dedicated) {
    const id    = inst.InstanceId;
    const name  = inst.Tags?.find(t => t.Key === 'Name')?.Value || id;
    const wasRunning = inst.State?.Name === 'running';

    try {
      // Stop if running
      if (wasRunning) {
        logs.push(`  Stopping ${id} (${name})...`);
        await client.send(new StopInstancesCommand({ InstanceIds: [id] }));

        // Wait for stopped state
        let stopped = false;
        for (let attempts = 0; attempts < 30; attempts++) {
          await new Promise(r => setTimeout(r, 10_000));
          const r = await client.send(new DescribeInstanceStatusCommand({
            InstanceIds:         [id],
            IncludeAllInstances: true,
          }));
          const state = r.InstanceStatuses?.[0]?.InstanceState?.Name;
          if (state === 'stopped') { stopped = true; break; }
          logs.push(`    Waiting for stopped state... (${state})`);
        }
        if (!stopped) throw new Error('Timed out waiting for instance to stop');
      }

      // Change tenancy
      await client.send(new ModifyInstancePlacementCommand({
        InstanceId: id,
        Tenancy:    'default',
      }));
      logs.push(`  ✓ ${id} tenancy changed to shared.`);

      // Restart if it was running
      if (wasRunning) {
        await client.send(new StartInstancesCommand({ InstanceIds: [id] }));
        logs.push(`  ✓ ${id} restarted.`);
      }

      converted++;
    } catch (err) {
      logs.push(`  ✗ ${id} — ${err.message}`);
      failed++;
    }
  }

  logs.push('');
  logs.push(`✓ Done. Converted: ${converted}  Failed: ${failed}`);

  audit.log({
    category: 'script',
    event:    'SCRIPT_RUN_SUCCESS',
    message:  `Converted ${converted} EC2 instance(s) from dedicated to shared tenancy in ${region}`,
    actor:    session?.identityArn || null,
    account:  session?.accountId  || null,
    result:   'success',
    details:  { scriptId: 'check-ec2-tenancy', region, converted, failed },
  });

  return { ok: true, logs };
}

async function runDeleteUnusedSgs(region, { dryRun }) {
  const client  = await getEc2Client(region);
  const session = awsAuth.getSession();
  const isDry   = dryRun !== 'delete';
  const logs    = [];

  logs.push(`Scanning for unused security groups in ${region}...`);

  // ── Collect all security groups ───────────────────────────────────────────
  const allSgs = [];
  let sgToken;
  do {
    const r = await client.send(new DescribeSecurityGroupsCommand({ NextToken: sgToken }));
    allSgs.push(...(r.SecurityGroups || []));
    sgToken = r.NextToken;
  } while (sgToken);

  // ── Collect SG IDs attached to any network interface ─────────────────────
  // ENIs cover: EC2 instances, RDS, Lambda, ELB/ALB, ECS, etc.
  const usedByEni = new Set();
  let eniToken;
  do {
    const r = await client.send(new DescribeNetworkInterfacesCommand({ NextToken: eniToken }));
    for (const eni of r.NetworkInterfaces || []) {
      for (const g of eni.Groups || []) {
        if (g.GroupId) usedByEni.add(g.GroupId);
      }
    }
    eniToken = r.NextToken;
  } while (eniToken);

  // ── Collect SG IDs referenced in other SGs' rules (as source/destination) ─
  const usedAsRef = new Set();
  for (const sg of allSgs) {
    const checkRules = [...(sg.IpPermissions || []), ...(sg.IpPermissionsEgress || [])];
    for (const rule of checkRules) {
      for (const pair of rule.UserIdGroupPairs || []) {
        if (pair.GroupId) usedAsRef.add(pair.GroupId);
      }
    }
  }

  // ── Find unused SGs (skip default — AWS won't allow deleting them) ────────
  const unused = allSgs.filter(sg =>
    sg.GroupName !== 'default' &&
    !usedByEni.has(sg.GroupId) &&
    !usedAsRef.has(sg.GroupId)
  );

  if (unused.length === 0) {
    logs.push('✓ No unused security groups found. Nothing to do.');
    return { ok: true, logs };
  }

  logs.push(`Found ${unused.length} unused security group(s):`);
  logs.push('');
  for (const sg of unused) {
    const name = sg.GroupName !== sg.GroupId ? sg.GroupName : '';
    const desc = sg.Description || '';
    logs.push(`  ${sg.GroupId}${name ? '  ' + name : ''}${desc ? '  — ' + desc : ''}`);
  }

  if (isDry) {
    logs.push('');
    logs.push('⚠ Dry-run mode — no security groups were deleted.');
    logs.push('  Re-run with mode set to "delete" to remove them.');
    return { ok: true, logs };
  }

  logs.push('');
  logs.push('Deleting...');
  let deleted = 0;
  let failed  = 0;

  for (const sg of unused) {
    try {
      await client.send(new DeleteSecurityGroupCommand({ GroupId: sg.GroupId }));
      logs.push(`  ✓ Deleted ${sg.GroupId} (${sg.GroupName})`);
      deleted++;
    } catch (err) {
      logs.push(`  ✗ ${sg.GroupId} — ${err.message}`);
      failed++;
    }
  }

  logs.push('');
  logs.push(`✓ Done. Deleted: ${deleted}  Failed: ${failed}`);

  audit.log({
    category: 'script',
    event:    'SCRIPT_RUN_SUCCESS',
    message:  `Deleted ${deleted} unused security group(s) in ${region}`,
    actor:    session?.identityArn || null,
    account:  session?.accountId  || null,
    result:   'success',
    details:  { scriptId: 'delete-unused-sgs', region, deleted, failed },
  });

  return { ok: true, logs };
}

async function runDeleteOrphanedAmis(region, { dryRun }) {
  const client  = await getEc2Client(region);
  const session = awsAuth.getSession();
  const isDry   = dryRun !== 'delete';
  const logs    = [];

  logs.push(`Scanning for orphaned AMIs in ${region}...`);

  // ── Collect AMIs owned by this account ───────────────────────────────────
  const { Images } = await client.send(new DescribeImagesCommand({ Owners: ['self'] }));
  if (!Images || Images.length === 0) {
    logs.push('✓ No AMIs owned by this account in this region. Nothing to do.');
    return { ok: true, logs };
  }
  const amiMap = new Map(Images.map(i => [i.ImageId, i]));
  logs.push(`  Found ${Images.length} owned AMI(s). Checking for references...`);

  // ── Collect AMI IDs in use by instances ──────────────────────────────────
  const usedByInstances = new Set();
  let nextToken;
  do {
    const r = await client.send(new DescribeInstancesCommand({
      Filters:   [{ Name: 'instance-state-name', Values: ['running', 'stopped', 'stopping', 'pending'] }],
      NextToken: nextToken,
    }));
    for (const res of r.Reservations || []) {
      for (const inst of res.Instances || []) {
        if (inst.ImageId) usedByInstances.add(inst.ImageId);
      }
    }
    nextToken = r.NextToken;
  } while (nextToken);

  // ── Collect AMI IDs in use by launch templates ───────────────────────────
  const usedByTemplates = new Set();
  try {
    let ltToken;
    const templateIds = [];
    do {
      const r = await client.send(new DescribeLaunchTemplatesCommand({ NextToken: ltToken }));
      templateIds.push(...(r.LaunchTemplates || []).map(t => t.LaunchTemplateId));
      ltToken = r.NextToken;
    } while (ltToken);

    for (const ltId of templateIds) {
      let verToken;
      do {
        const r = await client.send(new DescribeLaunchTemplateVersionsCommand({
          LaunchTemplateId: ltId,
          Versions:         ['$All'],
          NextToken:        verToken,
        }));
        for (const v of r.LaunchTemplateVersions || []) {
          const imageId = v.LaunchTemplateData?.ImageId;
          if (imageId) usedByTemplates.add(imageId);
        }
        verToken = r.NextToken;
      } while (verToken);
    }
  } catch { /* non-fatal if no launch templates */ }

  // ── Find orphans ─────────────────────────────────────────────────────────
  const orphans = Images.filter(i =>
    !usedByInstances.has(i.ImageId) && !usedByTemplates.has(i.ImageId)
  );

  if (orphans.length === 0) {
    logs.push('✓ All AMIs are in use. Nothing to do.');
    return { ok: true, logs };
  }

  // Estimate snapshot storage cost ($0.05/GB-month)
  let totalSnapshotGb = 0;
  logs.push('');
  logs.push(`Found ${orphans.length} orphaned AMI(s):`);
  for (const ami of orphans) {
    const name    = ami.Name || '(no name)';
    const created = ami.CreationDate ? new Date(ami.CreationDate).toLocaleDateString() : '?';
    const snaps   = ami.BlockDeviceMappings?.filter(b => b.Ebs?.SnapshotId) || [];
    const gb      = snaps.reduce((sum, b) => sum + (b.Ebs?.VolumeSize || 0), 0);
    totalSnapshotGb += gb;
    logs.push(`  ${ami.ImageId}  ${name}  (created ${created}, ~${gb} GB in snapshots)`);
  }

  const monthlySaving = (totalSnapshotGb * 0.05).toFixed(2);
  logs.push('');
  logs.push(`  Estimated snapshot storage saving: ~$${monthlySaving}/month (${totalSnapshotGb} GB @ $0.05/GB)`);

  if (isDry) {
    logs.push('');
    logs.push('⚠ Dry-run mode — no AMIs were deregistered.');
    logs.push('  Re-run with mode set to "delete" to remove them.');
    return { ok: true, logs };
  }

  // ── Deregister + delete snapshots ────────────────────────────────────────
  logs.push('');
  logs.push('Deregistering AMIs and deleting snapshots...');
  let deregistered = 0;
  let failed       = 0;

  for (const ami of orphans) {
    const snapshotIds = (ami.BlockDeviceMappings || [])
      .filter(b => b.Ebs?.SnapshotId)
      .map(b => b.Ebs.SnapshotId);
    try {
      await client.send(new DeregisterImageCommand({ ImageId: ami.ImageId }));
      logs.push(`  ✓ Deregistered ${ami.ImageId} (${ami.Name || 'no name'})`);
      for (const snapId of snapshotIds) {
        try {
          await client.send(new DeleteSnapshotCommand({ SnapshotId: snapId }));
          logs.push(`    ✓ Deleted snapshot ${snapId}`);
        } catch (e) {
          logs.push(`    ✗ Snapshot ${snapId} — ${e.message}`);
        }
      }
      deregistered++;
    } catch (err) {
      logs.push(`  ✗ ${ami.ImageId} — ${err.message}`);
      failed++;
    }
  }

  logs.push('');
  logs.push(`✓ Done. Deregistered: ${deregistered}  Failed: ${failed}`);

  audit.log({
    category: 'script',
    event:    'SCRIPT_RUN_SUCCESS',
    message:  `Deleted ${deregistered} orphaned AMI(s) in ${region}`,
    actor:    session?.identityArn || null,
    account:  session?.accountId  || null,
    result:   'success',
    details:  { scriptId: 'delete-orphaned-amis', region, deregistered, failed },
  });

  return { ok: true, logs };
}

async function runDeleteUnusedVolumes(region, { dryRun }) {
  const client  = await getEc2Client(region);
  const session = awsAuth.getSession();
  const isDry   = dryRun !== 'delete';
  const logs    = [];

  // GB-month pricing by volume type
  const PRICE = { gp2: 0.10, gp3: 0.08, io1: 0.125, io2: 0.125, st1: 0.045, sc1: 0.025, standard: 0.05 };

  logs.push(`Scanning for unused EBS volumes in ${region}...`);

  const volumes = [];
  let nextToken;
  do {
    const r = await client.send(new DescribeVolumesCommand({
      Filters:   [{ Name: 'status', Values: ['available'] }],
      NextToken: nextToken,
    }));
    volumes.push(...(r.Volumes || []));
    nextToken = r.NextToken;
  } while (nextToken);

  if (volumes.length === 0) {
    logs.push('✓ No unused volumes found. Nothing to do.');
    return { ok: true, logs };
  }

  let totalMonthlyCost = 0;
  logs.push(`Found ${volumes.length} unused volume(s):`);
  logs.push('');

  for (const v of volumes) {
    const name     = v.Tags?.find(t => t.Key === 'Name')?.Value || '';
    const price    = PRICE[v.VolumeType] ?? 0.08;
    const monthly  = (v.Size * price).toFixed(2);
    const created  = v.CreateTime ? new Date(v.CreateTime).toLocaleDateString() : '?';
    totalMonthlyCost += v.Size * price;
    logs.push(`  ${v.VolumeId}  ${v.VolumeType}  ${v.Size} GB  ~$${monthly}/mo${name ? '  [' + name + ']' : ''}  (created ${created})`);
  }

  logs.push('');
  logs.push(`  Total estimated saving: ~$${totalMonthlyCost.toFixed(2)}/month`);

  if (isDry) {
    logs.push('');
    logs.push('⚠ Dry-run mode — no volumes were deleted.');
    logs.push('  Re-run with mode set to "delete" to remove them.');
    return { ok: true, logs };
  }

  logs.push('');
  logs.push('Deleting...');
  let deleted = 0;
  let failed  = 0;

  for (const v of volumes) {
    try {
      await client.send(new DeleteVolumeCommand({ VolumeId: v.VolumeId }));
      logs.push(`  ✓ Deleted ${v.VolumeId} (${v.Size} GB ${v.VolumeType})`);
      deleted++;
    } catch (err) {
      logs.push(`  ✗ ${v.VolumeId} — ${err.message}`);
      failed++;
    }
  }

  logs.push('');
  logs.push(`✓ Done. Deleted: ${deleted}  Failed: ${failed}`);
  if (deleted > 0) {
    logs.push(`  Estimated monthly saving: ~$${totalMonthlyCost.toFixed(2)}`);
  }

  audit.log({
    category: 'script',
    event:    'SCRIPT_RUN_SUCCESS',
    message:  `Deleted ${deleted} unused EBS volume(s) in ${region}`,
    actor:    session?.identityArn || null,
    account:  session?.accountId  || null,
    result:   'success',
    details:  { scriptId: 'delete-unused-volumes', region, deleted, failed },
  });

  return { ok: true, logs };
}

async function runReleaseUnattachedEips(region, { dryRun }) {
  const client  = await getEc2Client(region);
  const session = awsAuth.getSession();
  const isDry   = dryRun !== 'release';
  const logs    = [];

  logs.push(`Scanning for unattached Elastic IPs in ${region}...`);

  const { Addresses } = await client.send(new DescribeAddressesCommand({}));
  const unattached = (Addresses || []).filter(a => !a.AssociationId);

  if (unattached.length === 0) {
    logs.push('✓ No unattached Elastic IPs found. Nothing to do.');
    return { ok: true, logs };
  }

  const hourlyRate = 0.005;
  const monthlyEst = (unattached.length * hourlyRate * 730).toFixed(2);

  logs.push(`Found ${unattached.length} unattached EIP${unattached.length !== 1 ? 's' : ''} (~$${monthlyEst}/month wasted):`);
  logs.push('');

  for (const addr of unattached) {
    const ip    = addr.PublicIp;
    const alloc = addr.AllocationId || '(classic)';
    const name  = addr.Tags?.find(t => t.Key === 'Name')?.Value || '';
    logs.push(`  ${ip}  ${alloc}${name ? '  [' + name + ']' : ''}`);
  }

  if (isDry) {
    logs.push('');
    logs.push(`⚠ Dry-run mode — no EIPs were released.`);
    logs.push('  Re-run with mode set to "release" to delete them.');
    return { ok: true, logs };
  }

  logs.push('');
  logs.push('Releasing...');

  let released = 0;
  let failed   = 0;
  for (const addr of unattached) {
    const ip    = addr.PublicIp;
    const alloc = addr.AllocationId;
    try {
      if (alloc) {
        await client.send(new ReleaseAddressCommand({ AllocationId: alloc }));
      } else {
        await client.send(new ReleaseAddressCommand({ PublicIp: ip }));
      }
      logs.push(`  ✓ Released ${ip}`);
      released++;
    } catch (err) {
      logs.push(`  ✗ ${ip} — ${err.message}`);
      failed++;
    }
  }

  logs.push('');
  logs.push(`✓ Done. Released: ${released}  Failed: ${failed}`);
  if (released > 0) {
    const saved = (released * hourlyRate * 730).toFixed(2);
    logs.push(`  Estimated monthly saving: ~$${saved}`);
  }

  audit.log({
    category: 'script',
    event:    'SCRIPT_RUN_SUCCESS',
    message:  `Released ${released} unattached Elastic IP(s) in ${region}`,
    actor:    session?.identityArn || null,
    account:  session?.accountId  || null,
    result:   'success',
    details:  { scriptId: 'release-unattached-eips', region, released, failed },
  });

  return { ok: true, logs };
}

async function runEnableGuardDuty(region, { features }) {
  const {
    GuardDutyClient,
    ListDetectorsCommand,
    CreateDetectorCommand,
    GetDetectorCommand,
    UpdateDetectorCommand,
  } = getGuardDutySdk();

  const credentials = await getCredentials();
  const session     = awsAuth.getSession();
  const logs        = [];

  const selectedFeatures = Array.isArray(features) ? features
    : (features ? [features] : []);

  // Build feature config objects — all selected features set to ENABLED
  const featureConfig = selectedFeatures.map(name => ({
    Name:   name,
    Status: 'ENABLED',
  }));

  const client = new GuardDutyClient({ credentials, region });

  // Check for an existing detector
  const { DetectorIds } = await client.send(new ListDetectorsCommand({}));

  if (DetectorIds && DetectorIds.length > 0) {
    const detectorId = DetectorIds[0];
    const detector   = await client.send(new GetDetectorCommand({ DetectorId: detectorId }));

    logs.push(`✓ GuardDuty already enabled in ${region}.`);
    logs.push(`  Detector ID: ${detectorId}  Status: ${detector.Status}`);

    if (featureConfig.length > 0) {
      logs.push('');
      logs.push('Updating protection plans...');
      await client.send(new UpdateDetectorCommand({
        DetectorId: detectorId,
        Enable:     true,
        Features:   featureConfig,
      }));
      selectedFeatures.forEach(f => logs.push(`  ✓ ${f} enabled.`));
    } else {
      logs.push('  No additional protection plans selected.');
    }
  } else {
    // Create a new detector
    logs.push(`Enabling GuardDuty in ${region}...`);
    const resp = await client.send(new CreateDetectorCommand({
      Enable:                  true,
      FindingPublishingFrequency: 'ONE_HOUR',
      Features:                featureConfig.length > 0 ? featureConfig : undefined,
    }));

    logs.push(`✓ GuardDuty enabled. Detector ID: ${resp.DetectorId}`);

    if (featureConfig.length > 0) {
      logs.push('');
      logs.push('Protection plans enabled:');
      selectedFeatures.forEach(f => logs.push(`  ✓ ${f}`));
    } else {
      logs.push('  No optional protection plans selected (core threat detection active).');
    }
  }

  logs.push('');
  logs.push('  Review findings in the GuardDuty console:');
  logs.push(`  https://${region}.console.aws.amazon.com/guardduty/home?region=${region}#/findings`);

  audit.log({
    category: 'script',
    event:    'SCRIPT_RUN_SUCCESS',
    message:  `Amazon GuardDuty enabled in ${region}`,
    actor:    session?.identityArn || null,
    account:  session?.accountId  || null,
    result:   'success',
    details:  { scriptId: 'enable-guardduty', region, features: selectedFeatures },
  });

  return { ok: true, logs };
}

async function runEnableMacie(region, { publishingFrequency }) {
  const { Macie2Client, GetMacieSessionCommand, EnableMacieCommand, UpdateMacieSessionCommand } = getMacieSdk();
  const credentials = await getCredentials();
  const session     = awsAuth.getSession();
  const logs        = [];
  const freq        = publishingFrequency || 'ONE_HOUR';

  const client = new Macie2Client({ credentials, region });

  // Check current status
  let alreadyEnabled = false;
  try {
    const status = await client.send(new GetMacieSessionCommand({}));
    alreadyEnabled = status.status === 'ENABLED';
  } catch (err) {
    // AccessDeniedException or ResourceNotFoundException means Macie not yet enabled
    if (!err.name?.includes('AccessDenied') && err.name !== 'ResourceNotFoundException') {
      throw err;
    }
  }

  if (alreadyEnabled) {
    logs.push(`✓ Macie is already enabled in ${region}.`);
    logs.push(`  Updating finding publishing frequency to ${freq}...`);
    await client.send(new UpdateMacieSessionCommand({
      FindingPublishingFrequency: freq,
      Status: 'ENABLED',
    }));
    logs.push('  ✓ Updated.');
    return { ok: true, logs };
  }

  logs.push(`Enabling Amazon Macie in ${region}...`);
  await client.send(new EnableMacieCommand({
    FindingPublishingFrequency: freq,
    Status: 'ENABLED',
  }));
  logs.push(`✓ Macie enabled in ${region}.`);
  logs.push(`  Finding publishing frequency: ${freq}`);
  logs.push('');
  logs.push('  Macie will begin discovering sensitive data in S3 buckets automatically.');
  logs.push('  Review findings in the Macie console:');
  logs.push(`  https://${region}.console.aws.amazon.com/macie/home?region=${region}#summary`);

  audit.log({
    category: 'script',
    event:    'SCRIPT_RUN_SUCCESS',
    message:  `Amazon Macie enabled in ${region}`,
    actor:    session?.identityArn || null,
    account:  session?.accountId  || null,
    result:   'success',
    details:  { scriptId: 'enable-macie', region, publishingFrequency: freq },
  });

  return { ok: true, logs };
}

async function runEnableDetective(region, { enableAutoEnable }) {
  const {
    DetectiveClient,
    ListGraphsCommand,
    CreateGraphCommand,
    UpdateOrganizationConfigurationCommand,
  } = getDetectiveSdk();

  const credentials = await getCredentials();
  const session     = awsAuth.getSession();
  const logs        = [];

  const client = new DetectiveClient({ credentials, region });

  // ── Check for an existing behavior graph ───────────────────────────────────
  const { GraphList } = await client.send(new ListGraphsCommand({}));

  let graphArn;
  if (GraphList && GraphList.length > 0) {
    graphArn = GraphList[0].Arn;
    logs.push(`✓ Amazon Detective is already enabled in ${region}.`);
    logs.push(`  Behavior graph ARN: ${graphArn}`);
  } else {
    // ── Enable Detective by creating a behavior graph ────────────────────────
    logs.push(`Enabling Amazon Detective in ${region}...`);
    logs.push('  (Requires GuardDuty to be active — Detective will report a setup error if GuardDuty is not enabled.)');
    logs.push('');

    const resp = await client.send(new CreateGraphCommand({
      Tags: { ManagedBy: 'MAWS' },
    }));
    graphArn = resp.GraphArn;
    logs.push(`✓ Detective behavior graph created.`);
    logs.push(`  Graph ARN: ${graphArn}`);
  }

  // ── Optional: org-level auto-enable ───────────────────────────────────────
  const autoEnable = enableAutoEnable === 'Yes';
  if (autoEnable) {
    logs.push('');
    logs.push('Configuring auto-enable for new organization accounts...');
    try {
      await client.send(new UpdateOrganizationConfigurationCommand({
        GraphArn:   graphArn,
        AutoEnable: true,
      }));
      logs.push('✓ Auto-enable for new organization accounts is ON.');
    } catch (e) {
      // Only works if the account is the Organizations delegated admin for Detective
      if (e.name === 'AccessDeniedException' || e.name === 'ValidationException') {
        logs.push(`⚠ Could not set org auto-enable: ${e.message}`);
        logs.push('  This option requires the account to be the Detective delegated administrator for AWS Organizations.');
      } else {
        throw e;
      }
    }
  }

  logs.push('');
  logs.push('  Detective will start ingesting data from GuardDuty, CloudTrail, VPC Flow Logs, and EKS.');
  logs.push('  It may take up to 24 hours to build the initial security graph.');
  logs.push('  Review investigations in the Detective console:');
  logs.push(`  https://${region}.console.aws.amazon.com/detective/home?region=${region}#summary`);

  audit.log({
    category: 'script',
    event:    'SCRIPT_RUN_SUCCESS',
    message:  `Amazon Detective enabled in ${region}`,
    actor:    session?.identityArn || null,
    account:  session?.accountId  || null,
    result:   'success',
    details:  { scriptId: 'enable-detective', region, autoEnable },
  });

  return { ok: true, logs };
}

// ── Module export ────────────────────────────────────────────────────────────

module.exports = {
  id:          'script-runner',
  name:        'Script Runner',
  icon:        '⚡',
  description: 'Run prebaked or custom shell scripts against your AWS account with Touch ID / password protection.',
  version:     '1.0.0',

  handlers: {
    'script-runner:list': async () => {
      const favs = loadFavorites();
      return { ok: true, prebaked: PREBAKED, custom: loadCustom(), favorites: [...favs] };
    },

    'script-runner:toggle-favorite': async (_e, { id }) => {
      const favs = loadFavorites();
      if (favs.has(id)) favs.delete(id); else favs.add(id);
      saveFavorites(favs);
      return { ok: true, favorites: [...favs] };
    },

    'script-runner:run': async (_e, { scriptId, region, params }) => {
      const runId  = genId();
      const script = PREBAKED.find(s => s.id === scriptId);
      const scriptName = script?.name || scriptId;
      let result;

      try {
        // SDK-based runners
        if (scriptId === 'convert-gp2-gp3')                   result = await runConvertGp2Gp3(region);
        else if (scriptId === 'audit-security-groups')         result = await runAuditSecurityGroups(region);
        else if (scriptId === 'lock-default-sg')               result = await runLockDefaultSg();
        else if (scriptId === 'enable-ebs-encryption-by-default') result = await runEnableEbsEncryption(region);
        else if (scriptId === 'enforce-imdsv2')                result = await runEnforceImdsv2();
        else if (scriptId === 'setup-alb-access-logs')         result = await runSetupAlbAccessLogs(region, params || {});
        else if (scriptId === 'block-s3-public-access') result = await runBlockS3PublicAccess();
        else if (scriptId === 'create-idc-user')        result = await runCreateIdcUser(params || {});
        else if (scriptId === 'enable-cost-alerts')     result = await runEnableCostAlerts(params || {});
        else if (scriptId === 'set-log-retention')      result = await runSetLogRetention(region, params || {});
        else if (scriptId === 'enable-cloudtrail')      result = await runEnableCloudTrail(region, params || {});
        else if (scriptId === 'enable-macie')           result = await runEnableMacie(region, params || {});
        else if (scriptId === 'enable-guardduty')       result = await runEnableGuardDuty(region, params || {});
        else if (scriptId === 'enable-detective')       result = await runEnableDetective(region, params || {});
        else if (scriptId === 'release-unattached-eips') result = await runReleaseUnattachedEips(region, params || {});
        else if (scriptId === 'check-ec2-tenancy')        result = await runCheckEc2Tenancy(region, params || {});
        else if (scriptId === 'delete-unused-sgs')       result = await runDeleteUnusedSgs(region, params || {});
        else if (scriptId === 'delete-orphaned-amis')    result = await runDeleteOrphanedAmis(region, params || {});
        else if (scriptId === 'delete-unused-volumes')   result = await runDeleteUnusedVolumes(region, params || {});
        else return { ok: false, error: `Unknown prebaked script: ${scriptId}` };
      } catch (err) {
        result = { ok: false, error: err.message, logs: [err.message] };
      }

      const logPath = writeScriptLog(runId, scriptName, result.logs || (result.error ? [result.error] : []));
      auditScriptRun({ runId, scriptId, scriptName, region, result: result.ok ? 'success' : 'failure', logPath });
      return { ...result, runId, logPath };
    },

    'script-runner:run-custom': async (_e, { body, region, name }) => {
      const runId      = genId();
      const scriptName = name || 'Custom script';
      let result;

      try {
        result = await runCustomScript(body, region);
      } catch (err) {
        result = { ok: false, error: err.message, logs: [err.message] };
      }

      const logPath = writeScriptLog(runId, scriptName, result.logs || (result.error ? [result.error] : []));
      auditScriptRun({ runId, scriptId: 'custom', scriptName, region, result: result.ok ? 'success' : 'failure', logPath });
      return { ...result, runId, logPath };
    },

    'script-runner:save-custom': async (_e, { id, name, description, body, category, danger }) => {
      const entries = loadCustom();
      const cat     = category || 'custom';
      const isDanger = Boolean(danger);
      if (id) {
        const idx = entries.findIndex(e => e.id === id);
        if (idx !== -1) {
          // Auto-save previous version before overwriting
          if (entries[idx].body && entries[idx].body !== body) {
            addVersion(id, entries[idx].body, `Auto-saved before edit on ${new Date().toLocaleString()}`);
          }
          entries[idx] = { ...entries[idx], name, description: description || '', body, category: cat, danger: isDanger, updatedAt: new Date().toISOString() };
        } else {
          entries.unshift({ id, name, description: description || '', body, category: cat, danger: isDanger, allRegions: false, addedAt: new Date().toISOString() });
        }
      } else {
        entries.unshift({
          id:          genId(),
          name:        name || 'Untitled Script',
          description: description || '',
          body,
          category:    cat,
          danger:      isDanger,
          allRegions:  false,
          addedAt:     new Date().toISOString(),
        });
      }
      saveCustom(entries);
      return { ok: true, entries };
    },

    'script-runner:delete-custom': async (_e, { id }) => {
      const entries = loadCustom().filter(e => e.id !== id);
      saveCustom(entries);
      return { ok: true, entries };
    },

    // ── Version history handlers ─────────────────────────────────────────────

    'script-runner:versions-list': async (_e, { scriptId }) => {
      const data     = loadVersions();
      const versions = (data[scriptId] || []).slice().reverse(); // newest first
      return { ok: true, versions };
    },

    'script-runner:versions-save': async (_e, { scriptId, content, label }) => {
      addVersion(scriptId, content, label || '');
      const data     = loadVersions();
      const versions = (data[scriptId] || []).slice().reverse();
      return { ok: true, versions };
    },

    'script-runner:versions-delete': async (_e, { scriptId, versionId }) => {
      const data     = loadVersions();
      data[scriptId] = (data[scriptId] || []).filter(v => v.id !== versionId);
      saveVersions(data);
      const versions = data[scriptId].slice().reverse();
      return { ok: true, versions };
    },

    'script-runner:versions-set-default': async (_e, { scriptId, versionId }) => {
      const data = loadVersions();
      for (const v of (data[scriptId] || [])) {
        v.isDefault = (v.id === versionId);
      }
      saveVersions(data);
      const versions = data[scriptId].slice().reverse();
      return { ok: true, versions };
    },

    // ── Helper: list ALBs for the dynamic-select param ───────────────────────

    'script-runner:list-albs': async (_e, { region }) => {
      try {
        const client  = await getElbClient(region);
        const options = [];
        let marker;
        do {
          const resp = await client.send(new DescribeLoadBalancersCommand({ Marker: marker }));
          for (const lb of resp.LoadBalancers || []) {
            if (lb.Type === 'application') {
              options.push({ value: lb.LoadBalancerArn, label: lb.LoadBalancerName });
            }
          }
          marker = resp.NextMarker;
        } while (marker);
        return { ok: true, options };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  },
};
