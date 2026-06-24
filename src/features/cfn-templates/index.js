'use strict';

/**
 * cfn-templates feature
 *
 * Prebaked + custom CloudFormation templates that can be deployed to the
 * authenticated AWS account.  Auth gate (Touch ID / password) is enforced in
 * the renderer before any deployment, matching the script-runner pattern.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  DescribeStackEventsCommand,
} = require('@aws-sdk/client-cloudformation');

const awsAuth = require('../../main/aws-auth');
const audit   = require('../../main/audit-logger');

function genId() {
  try { return require('crypto').randomUUID(); } catch { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
}

const DATA_DIR       = path.join(os.homedir(), 'Library', 'Application Support', 'maws');
const CUSTOM_FILE    = path.join(DATA_DIR, 'custom-cfn-templates.json');
const FAVORITES_FILE = path.join(DATA_DIR, 'cfn-favorites.json');

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

// ── Production VPC template ──────────────────────────────────────────────────

const PRODUCTION_VPC_TEMPLATE = `AWSTemplateFormatVersion: '2010-09-09'
Description: >
  Production-grade VPC with 2 public + 2 private subnets across 2 AZs, HA NAT
  Gateways (one per AZ), Internet Gateway, VPC Flow Logs (90-day retention),
  and a default security group with no inbound access. Managed by MAWS.

Parameters:

  VpcCidr:
    Type: String
    Default: 10.0.0.0/16
    Description: CIDR block for the VPC
    AllowedPattern: "^(\\\\d{1,3}\\\\.){3}\\\\d{1,3}/\\\\d{1,2}$"
    ConstraintDescription: Must be a valid IPv4 CIDR block.

  EnvironmentName:
    Type: String
    Default: production
    Description: Environment name used in resource names and tags
    AllowedValues: [production, staging, development]

  EnableFlowLogs:
    Type: String
    Default: 'true'
    AllowedValues: ['true', 'false']
    Description: Whether to enable VPC Flow Logs to CloudWatch Logs

Conditions:
  FlowLogsEnabled: !Equals [!Ref EnableFlowLogs, 'true']

Resources:

  # ── VPC ──────────────────────────────────────────────────────────────────────

  VPC:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: !Ref VpcCidr
      EnableDnsHostnames: true
      EnableDnsSupport: true
      Tags:
        - { Key: Name,        Value: !Sub '\${EnvironmentName}-vpc' }
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }

  # ── Internet Gateway ──────────────────────────────────────────────────────────

  InternetGateway:
    Type: AWS::EC2::InternetGateway
    Properties:
      Tags:
        - { Key: Name,        Value: !Sub '\${EnvironmentName}-igw' }
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }

  InternetGatewayAttachment:
    Type: AWS::EC2::VPCGatewayAttachment
    Properties:
      VpcId: !Ref VPC
      InternetGatewayId: !Ref InternetGateway

  # ── Public Subnets ────────────────────────────────────────────────────────────

  PublicSubnet1:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: 10.0.1.0/24
      AvailabilityZone: !Select [0, !GetAZs '']
      MapPublicIpOnLaunch: true
      Tags:
        - { Key: Name,        Value: !Sub '\${EnvironmentName}-public-subnet-1' }
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }
        - { Key: Type,        Value: Public }

  PublicSubnet2:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: 10.0.2.0/24
      AvailabilityZone: !Select [1, !GetAZs '']
      MapPublicIpOnLaunch: true
      Tags:
        - { Key: Name,        Value: !Sub '\${EnvironmentName}-public-subnet-2' }
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }
        - { Key: Type,        Value: Public }

  # ── Private Subnets ───────────────────────────────────────────────────────────

  PrivateSubnet1:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: 10.0.10.0/24
      AvailabilityZone: !Select [0, !GetAZs '']
      MapPublicIpOnLaunch: false
      Tags:
        - { Key: Name,        Value: !Sub '\${EnvironmentName}-private-subnet-1' }
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }
        - { Key: Type,        Value: Private }

  PrivateSubnet2:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: 10.0.20.0/24
      AvailabilityZone: !Select [1, !GetAZs '']
      MapPublicIpOnLaunch: false
      Tags:
        - { Key: Name,        Value: !Sub '\${EnvironmentName}-private-subnet-2' }
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }
        - { Key: Type,        Value: Private }

  # ── Elastic IPs for NAT Gateways ─────────────────────────────────────────────

  NatGateway1EIP:
    Type: AWS::EC2::EIP
    DependsOn: InternetGatewayAttachment
    Properties:
      Domain: vpc
      Tags:
        - { Key: Name,        Value: !Sub '\${EnvironmentName}-nat-eip-1' }
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }

  NatGateway2EIP:
    Type: AWS::EC2::EIP
    DependsOn: InternetGatewayAttachment
    Properties:
      Domain: vpc
      Tags:
        - { Key: Name,        Value: !Sub '\${EnvironmentName}-nat-eip-2' }
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }

  # ── NAT Gateways (one per AZ for HA) ─────────────────────────────────────────

  NatGateway1:
    Type: AWS::EC2::NatGateway
    Properties:
      AllocationId: !GetAtt NatGateway1EIP.AllocationId
      SubnetId: !Ref PublicSubnet1
      Tags:
        - { Key: Name,        Value: !Sub '\${EnvironmentName}-nat-gw-1' }
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }

  NatGateway2:
    Type: AWS::EC2::NatGateway
    Properties:
      AllocationId: !GetAtt NatGateway2EIP.AllocationId
      SubnetId: !Ref PublicSubnet2
      Tags:
        - { Key: Name,        Value: !Sub '\${EnvironmentName}-nat-gw-2' }
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }

  # ── Public Route Table ────────────────────────────────────────────────────────

  PublicRouteTable:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref VPC
      Tags:
        - { Key: Name,        Value: !Sub '\${EnvironmentName}-public-rt' }
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }

  DefaultPublicRoute:
    Type: AWS::EC2::Route
    DependsOn: InternetGatewayAttachment
    Properties:
      RouteTableId: !Ref PublicRouteTable
      DestinationCidrBlock: 0.0.0.0/0
      GatewayId: !Ref InternetGateway

  PublicSubnet1RouteTableAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      RouteTableId: !Ref PublicRouteTable
      SubnetId: !Ref PublicSubnet1

  PublicSubnet2RouteTableAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      RouteTableId: !Ref PublicRouteTable
      SubnetId: !Ref PublicSubnet2

  # ── Private Route Tables (one per AZ) ────────────────────────────────────────

  PrivateRouteTable1:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref VPC
      Tags:
        - { Key: Name,        Value: !Sub '\${EnvironmentName}-private-rt-1' }
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }

  DefaultPrivateRoute1:
    Type: AWS::EC2::Route
    Properties:
      RouteTableId: !Ref PrivateRouteTable1
      DestinationCidrBlock: 0.0.0.0/0
      NatGatewayId: !Ref NatGateway1

  PrivateSubnet1RouteTableAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      RouteTableId: !Ref PrivateRouteTable1
      SubnetId: !Ref PrivateSubnet1

  PrivateRouteTable2:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref VPC
      Tags:
        - { Key: Name,        Value: !Sub '\${EnvironmentName}-private-rt-2' }
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }

  DefaultPrivateRoute2:
    Type: AWS::EC2::Route
    Properties:
      RouteTableId: !Ref PrivateRouteTable2
      DestinationCidrBlock: 0.0.0.0/0
      NatGatewayId: !Ref NatGateway2

  PrivateSubnet2RouteTableAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      RouteTableId: !Ref PrivateRouteTable2
      SubnetId: !Ref PrivateSubnet2

  # ── Default Security Group — no inbound, allow all outbound ──────────────────

  DefaultSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: Default SG - no inbound rules, all outbound allowed
      VpcId: !Ref VPC
      SecurityGroupIngress: []
      SecurityGroupEgress:
        - IpProtocol: '-1'
          CidrIp: 0.0.0.0/0
          Description: All outbound traffic
      Tags:
        - { Key: Name,        Value: !Sub '\${EnvironmentName}-default-sg' }
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }

  # ── VPC Flow Logs ─────────────────────────────────────────────────────────────

  FlowLogsLogGroup:
    Type: AWS::Logs::LogGroup
    Condition: FlowLogsEnabled
    Properties:
      LogGroupName: !Sub '/aws/vpc/flow-logs/\${EnvironmentName}'
      RetentionInDays: 90
      Tags:
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }

  FlowLogsRole:
    Type: AWS::IAM::Role
    Condition: FlowLogsEnabled
    Properties:
      RoleName: !Sub '\${EnvironmentName}-vpc-flow-logs-role'
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: vpc-flow-logs.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: VpcFlowLogsPolicy
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action:
                  - logs:CreateLogGroup
                  - logs:CreateLogStream
                  - logs:PutLogEvents
                  - logs:DescribeLogGroups
                  - logs:DescribeLogStreams
                Resource: '*'
      Tags:
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }

  VpcFlowLog:
    Type: AWS::EC2::FlowLog
    Condition: FlowLogsEnabled
    Properties:
      ResourceId: !Ref VPC
      ResourceType: VPC
      TrafficType: ALL
      LogDestinationType: cloud-watch-logs
      LogGroupName: !Ref FlowLogsLogGroup
      DeliverLogsPermissionArn: !GetAtt FlowLogsRole.Arn
      Tags:
        - { Key: Environment, Value: !Ref EnvironmentName }
        - { Key: ManagedBy,   Value: MAWS }

Outputs:

  VpcId:
    Description: VPC ID
    Value: !Ref VPC
    Export: { Name: !Sub '\${EnvironmentName}-VpcId' }

  PublicSubnet1Id:
    Description: Public Subnet 1 ID (AZ 1)
    Value: !Ref PublicSubnet1
    Export: { Name: !Sub '\${EnvironmentName}-PublicSubnet1Id' }

  PublicSubnet2Id:
    Description: Public Subnet 2 ID (AZ 2)
    Value: !Ref PublicSubnet2
    Export: { Name: !Sub '\${EnvironmentName}-PublicSubnet2Id' }

  PrivateSubnet1Id:
    Description: Private Subnet 1 ID (AZ 1)
    Value: !Ref PrivateSubnet1
    Export: { Name: !Sub '\${EnvironmentName}-PrivateSubnet1Id' }

  PrivateSubnet2Id:
    Description: Private Subnet 2 ID (AZ 2)
    Value: !Ref PrivateSubnet2
    Export: { Name: !Sub '\${EnvironmentName}-PrivateSubnet2Id' }

  NatGateway1Id:
    Description: NAT Gateway 1 ID
    Value: !Ref NatGateway1
    Export: { Name: !Sub '\${EnvironmentName}-NatGateway1Id' }

  NatGateway2Id:
    Description: NAT Gateway 2 ID
    Value: !Ref NatGateway2
    Export: { Name: !Sub '\${EnvironmentName}-NatGateway2Id' }
`;

// ── Prebaked template definitions ─────────────────────────────────────────────

const PREBAKED = [
  {
    id:          'production-vpc',
    name:        'Production VPC',
    description: 'Industry-standard VPC with 2 public + 2 private subnets across 2 AZs, HA NAT Gateways (one per AZ with dedicated Elastic IPs), Internet Gateway, public + private route tables, a no-inbound default security group, and VPC Flow Logs to CloudWatch (90-day retention). All resources tagged with Name, Environment, and ManagedBy=MAWS.',
    category:    'networking',
    danger:      false,
    deployParams: [
      { id: 'environmentName', label: 'Environment',     type: 'select', options: ['production', 'staging', 'development'], defaultValue: 'production', required: true },
      { id: 'vpcCidr',         label: 'VPC CIDR',        type: 'text',   placeholder: '10.0.0.0/16',                        defaultValue: '10.0.0.0/16', required: false },
      { id: 'enableFlowLogs',  label: 'Flow Logs',       type: 'select', options: ['true', 'false'],                        defaultValue: 'true',        required: false },
    ],
    templateBody: PRODUCTION_VPC_TEMPLATE,
  },
];

// ── Deploy via SDK ────────────────────────────────────────────────────────────

const PARAM_MAP = {
  environmentName: 'EnvironmentName',
  vpcCidr:         'VpcCidr',
  enableFlowLogs:  'EnableFlowLogs',
};

function makeCfnClient(credentials, region) {
  return new CloudFormationClient({
    region,
    credentials: {
      accessKeyId:     credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken:    credentials.sessionToken,
    },
  });
}

async function deployTemplate({ templateBody, stackName, region, params, templateName }) {
  const provider = awsAuth.getCredentialProvider();
  if (!provider) return { ok: false, error: 'Not authenticated' };
  const credentials = await provider();
  const session = awsAuth.getSession();
  const cfn = makeCfnClient(credentials, region);

  const parameters = Object.entries(params || {})
    .filter(([k, v]) => PARAM_MAP[k] && v != null && v !== '')
    .map(([k, v]) => ({ ParameterKey: PARAM_MAP[k], ParameterValue: String(v) }));

  let resp;
  try {
    resp = await cfn.send(new CreateStackCommand({
      StackName:    stackName,
      TemplateBody: templateBody,
      Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
      Parameters:   parameters.length ? parameters : undefined,
    }));
  } catch (err) {
    audit.log({
      category: 'cfn',
      event:    'CFN_DEPLOY_FAILED',
      message:  `Stack "${stackName}" creation failed: ${err.message}`,
      actor:    session?.identityArn || null,
      account:  session?.accountId  || null,
      result:   'failure',
      details:  { stackName, region, templateName, error: err.message },
    });
    throw err;
  }

  audit.log({
    category: 'cfn',
    event:    'CFN_DEPLOY_INITIATED',
    message:  `Stack "${stackName}" creation initiated in ${region}`,
    actor:    session?.identityArn || null,
    account:  session?.accountId  || null,
    result:   'info',
    details:  { stackName, stackId: resp.StackId, region, templateName, parameters },
  });

  return {
    ok:        true,
    stackId:   resp.StackId,
    stackName,
    region,
    logs: [
      `✓ Stack "${stackName}" creation initiated in ${region}.`,
      `  Stack ID: ${resp.StackId}`,
      '',
      '  Polling for status…',
    ],
  };
}

// ── Status polling ────────────────────────────────────────────────────────────

// Terminal states — polling stops when any of these is reached
const TERMINAL_STATES = new Set([
  'CREATE_COMPLETE', 'CREATE_FAILED',
  'ROLLBACK_COMPLETE', 'ROLLBACK_FAILED',
  'UPDATE_COMPLETE', 'UPDATE_FAILED',
  'UPDATE_ROLLBACK_COMPLETE', 'UPDATE_ROLLBACK_FAILED',
  'DELETE_COMPLETE', 'DELETE_FAILED',
]);

async function getStackStatus({ stackName, region, lastEventId }) {
  const provider = awsAuth.getCredentialProvider();
  if (!provider) return { ok: false, error: 'Not authenticated' };
  const credentials = await provider();
  const cfn = makeCfnClient(credentials, region);

  // Fetch stack status
  let status, statusReason;
  try {
    const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = r.Stacks?.[0];
    status       = stack?.StackStatus;
    statusReason = stack?.StackStatusReason;
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // Fetch new events since last poll
  const newEvents = [];
  try {
    const r = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
    const events = r.StackEvents || [];
    // Events are newest-first; collect those newer than lastEventId
    for (const ev of events) {
      if (lastEventId && ev.EventId === lastEventId) break;
      newEvents.unshift({ // reverse back to chronological
        eventId:      ev.EventId,
        resourceType: ev.ResourceType,
        logicalId:    ev.LogicalResourceId,
        status:       ev.ResourceStatus,
        reason:       ev.ResourceStatusReason || '',
        timestamp:    ev.Timestamp ? new Date(ev.Timestamp).toLocaleTimeString() : '',
      });
    }
  } catch { /* non-fatal */ }

  const terminal  = TERMINAL_STATES.has(status);
  const succeeded = status === 'CREATE_COMPLETE' || status === 'UPDATE_COMPLETE';

  if (terminal) {
    const session = awsAuth.getSession();
    audit.log({
      category: 'cfn',
      event:    succeeded ? 'CFN_DEPLOY_COMPLETE' : 'CFN_DEPLOY_FAILED',
      message:  succeeded
        ? `Stack "${stackName}" created successfully in ${region}`
        : `Stack "${stackName}" ended with status ${status} in ${region}`,
      actor:   session?.identityArn || null,
      account: session?.accountId  || null,
      result:  succeeded ? 'success' : 'failure',
      details: { stackName, region, status, statusReason: statusReason || '' },
    });
  }

  return {
    ok:           true,
    status,
    statusReason: statusReason || '',
    terminal,
    succeeded,
    newEvents,
    lastEventId:  newEvents.length ? newEvents[newEvents.length - 1].eventId : lastEventId,
  };
}

// ── Module export ────────────────────────────────────────────────────────────

module.exports = {
  id:          'cfn-templates',
  name:        'CFN Templates',
  icon:        '📐',
  description: 'Deploy production-ready CloudFormation stacks with auth gate protection.',
  version:     '1.0.0',

  handlers: {
    'cfn-templates:list': async () => {
      const favs = loadFavorites();
      return { ok: true, prebaked: PREBAKED, custom: loadCustom(), favorites: [...favs] };
    },

    'cfn-templates:toggle-favorite': async (_e, { id }) => {
      const favs = loadFavorites();
      if (favs.has(id)) favs.delete(id); else favs.add(id);
      saveFavorites(favs);
      return { ok: true, favorites: [...favs] };
    },

    'cfn-templates:deploy': async (_e, { templateId, templateBody, stackName, region, params }) => {
      try {
        let body = templateBody;
        let templateName = templateId || 'custom';
        if (!body && templateId) {
          const prebaked = PREBAKED.find(t => t.id === templateId);
          if (prebaked) {
            body = prebaked.templateBody;
            templateName = prebaked.name;
          } else {
            const ct = loadCustom().find(t => t.id === templateId);
            body = ct?.body;
            templateName = ct?.name || templateId;
          }
        }
        if (!body) return { ok: false, error: 'Template body not found.' };
        if (!stackName) return { ok: false, error: 'Stack name is required.' };
        return await deployTemplate({ templateBody: body, stackName, region, params, templateName });
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    'cfn-templates:poll-status': async (_e, { stackName, region, lastEventId }) => {
      try {
        return await getStackStatus({ stackName, region, lastEventId });
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    'cfn-templates:save-custom': async (_e, { id, name, description, body, category, danger }) => {
      const entries  = loadCustom();
      const cat      = category || 'custom';
      const isDanger = Boolean(danger);
      if (id) {
        const idx = entries.findIndex(e => e.id === id);
        if (idx !== -1) {
          entries[idx] = { ...entries[idx], name, description: description || '', body, category: cat, danger: isDanger, updatedAt: new Date().toISOString() };
        } else {
          entries.unshift({ id, name, description: description || '', body, category: cat, danger: isDanger, addedAt: new Date().toISOString() });
        }
      } else {
        entries.unshift({
          id:          genId(),
          name:        name || 'Untitled Template',
          description: description || '',
          body,
          category:    cat,
          danger:      isDanger,
          addedAt:     new Date().toISOString(),
        });
      }
      saveCustom(entries);
      return { ok: true, entries };
    },

    'cfn-templates:delete-custom': async (_e, { id }) => {
      const entries = loadCustom().filter(e => e.id !== id);
      saveCustom(entries);
      return { ok: true, entries };
    },
  },
};
