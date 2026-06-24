'use strict';

/**
 * aws-auth.js
 * Handles AWS authentication via:
 *   1. SSO / IAM Identity Center (recommended — no long-lived credentials)
 *   2. Named profiles (~/.aws/credentials + ~/.aws/config)
 *
 * Credentials are stored in the macOS Keychain via keytar so they never
 * touch disk as plain text. On first launch after an upgrade from the old
 * file-based cache, the legacy session.json is migrated then deleted.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const keytar = require('keytar');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const { SSOOIDCClient, RegisterClientCommand, StartDeviceAuthorizationCommand, CreateTokenCommand } = require('@aws-sdk/client-sso-oidc');
const { SSOClient, GetRoleCredentialsCommand, ListAccountsCommand, ListAccountRolesCommand } = require('@aws-sdk/client-sso');
const { fromIni } = require('@aws-sdk/credential-providers');
const { EventEmitter } = require('events');
const audit = require('./audit-logger');

// Emits 'session-expired' when credentials expire while the app is running
const authEvents = new EventEmitter();

// In-memory session state
let _session      = null;
let _expiryTimer  = null;

// Keychain identifiers
const KC_SERVICE = 'maws';
const KC_ACCOUNT = 'aws-session';

// Legacy file path — only used for one-time migration on first launch
const LEGACY_SESSION_FILE = path.join(os.homedir(), 'Library', 'Application Support', 'maws', 'session.json');

async function _persistSession() {
  if (!_session?.credentials) return;
  try {
    const data = {
      credentials: {
        accessKeyId:     _session.credentials.accessKeyId,
        secretAccessKey: _session.credentials.secretAccessKey,
        sessionToken:    _session.credentials.sessionToken,
        expiration:      _session.credentials.expiration instanceof Date
          ? _session.credentials.expiration.toISOString()
          : _session.credentials.expiration,
      },
      profile:     _session.profile,
      method:      _session.method,
      accountId:   _session.accountId,
      userId:      _session.userId,
      identityArn: _session.identityArn,
      region:      _session.region,
    };
    await keytar.setPassword(KC_SERVICE, KC_ACCOUNT, JSON.stringify(data));
  } catch (e) {
    console.warn('[auth] Could not persist session to Keychain:', e.message);
  }
}

async function _clearPersistedSession() {
  try { await keytar.deletePassword(KC_SERVICE, KC_ACCOUNT); } catch {}
}

/**
 * Called at app startup. Restores a cached session if credentials haven't expired.
 * On first run after upgrade, migrates the legacy session.json to the Keychain
 * then deletes the plain-text file.
 * Returns true if a valid session was restored.
 */
async function restoreSession() {
  try {
    // ── One-time migration from legacy plain-text file ──────────────────────
    if (fs.existsSync(LEGACY_SESSION_FILE)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(LEGACY_SESSION_FILE, 'utf-8'));
        await keytar.setPassword(KC_SERVICE, KC_ACCOUNT, JSON.stringify(legacy));
        console.log('[auth] Migrated session from file to Keychain');
      } catch {}
      try { fs.unlinkSync(LEGACY_SESSION_FILE); } catch {}
    }

    // ── Read from Keychain ───────────────────────────────────────────────────
    const json = await keytar.getPassword(KC_SERVICE, KC_ACCOUNT);
    if (!json) return false;

    const data = JSON.parse(json);

    // Reject if expired (with a 2-minute buffer)
    if (data.credentials.expiration) {
      const exp = new Date(data.credentials.expiration);
      if (exp.getTime() - Date.now() < 2 * 60 * 1000) {
        await _clearPersistedSession();
        return false;
      }
    }

    const credentials = {
      ...data.credentials,
      expiration: data.credentials.expiration ? new Date(data.credentials.expiration) : undefined,
    };

    _session = {
      credentials,
      provider:    () => Promise.resolve(credentials),
      profile:     data.profile,
      method:      data.method,
      accountId:   data.accountId,
      userId:      data.userId,
      identityArn: data.identityArn,
      region:      data.region,
    };

    _scheduleExpiryWarning(credentials.expiration);

    audit.log({
      category: 'auth',
      event:    'AUTH_SESSION_RESTORED',
      message:  `Session restored from Keychain for profile "${data.profile}"`,
      actor:    data.identityArn,
      account:  data.accountId,
      profile:  data.profile,
      result:   'info',
    });

    return true;
  } catch (e) {
    console.warn('[auth] Could not restore session:', e.message);
    await _clearPersistedSession();
    return false;
  }
}

// ── Config file helpers ───────────────────────────────────────────────────────

function readAwsConfig() {
  const configPath = path.join(os.homedir(), '.aws', 'config');
  if (!fs.existsSync(configPath)) return {};
  const ini = require('ini');
  return ini.parse(fs.readFileSync(configPath, 'utf-8'));
}

function readAwsCredentials() {
  const credPath = path.join(os.homedir(), '.aws', 'credentials');
  if (!fs.existsSync(credPath)) return {};
  const ini = require('ini');
  return ini.parse(fs.readFileSync(credPath, 'utf-8'));
}

/**
 * Returns a list of profiles with metadata about their type.
 * @returns {{ name: string, type: 'sso' | 'static', ssoStartUrl?: string, region?: string }[]}
 */
function listProfiles() {
  const config = readAwsConfig();
  const creds = readAwsCredentials();
  const profiles = [];

  for (const [section, values] of Object.entries(config)) {
    // config sections are "profile <name>" except [default]; skip [sso-session …] blocks
    if (section.startsWith('sso-session')) continue;
    const name = section === 'default' ? 'default' : section.replace(/^profile\s+/, '');

    const isSso = values.sso_start_url || values.sso_session || values.sso_account_id;
    if (isSso) {
      // Modern SSO config stores sso_start_url inside the [sso-session <name>] block
      let ssoStartUrl = values.sso_start_url;
      if (!ssoStartUrl && values.sso_session) {
        const sessionBlock = config[`sso-session ${values.sso_session}`] || {};
        ssoStartUrl = sessionBlock.sso_start_url;
      }
      profiles.push({
        name,
        type: 'sso',
        ssoStartUrl,
        region: values.region || values.sso_region,
      });
    } else if (values.role_arn || values.aws_access_key_id) {
      profiles.push({ name, type: 'static', region: values.region });
    } else if (values.region || values.output) {
      profiles.push({ name, type: 'static', region: values.region });
    }
  }

  // Also include profiles only in credentials file (not in config)
  for (const [name, values] of Object.entries(creds)) {
    if (!profiles.find((p) => p.name === name) && values.aws_access_key_id) {
      profiles.push({ name, type: 'static' });
    }
  }

  return profiles;
}

/**
 * Resolve SSO params for a profile, handling both old (sso_start_url in profile)
 * and new (sso_session block) config formats.
 */
function resolveSSOParams(profileName) {
  const config = readAwsConfig();
  const sectionKey = profileName === 'default' ? 'default' : `profile ${profileName}`;
  const prof = config[sectionKey] || {};

  let ssoStartUrl  = prof.sso_start_url;
  let ssoRegion    = prof.sso_region || prof.region;
  const ssoAccountId = prof.sso_account_id;
  const ssoRoleName  = prof.sso_role_name;

  // Modern sso-session format — look up the referenced block
  if (!ssoStartUrl && prof.sso_session) {
    const sessionBlock = config[`sso-session ${prof.sso_session}`] || {};
    ssoStartUrl = sessionBlock.sso_start_url;
    ssoRegion   = ssoRegion || sessionBlock.sso_region;
  }

  return { ssoStartUrl, ssoRegion, ssoAccountId, ssoRoleName, ssoSession: prof.sso_session };
}

/**
 * Login via AWS SSO using the OIDC device-authorization flow directly.
 * This opens the browser for the user, polls for the token, then fetches
 * role credentials — no dependency on cached tokens or the SDK profile parser.
 */
async function loginSSO(profileName) {
  try {
    const { ssoStartUrl, ssoRegion, ssoAccountId, ssoRoleName } = resolveSSOParams(profileName);

    if (!ssoStartUrl || !ssoRegion) {
      return { ok: false, error: 'Could not find sso_start_url or sso_region in profile config.' };
    }

    const { shell } = require('electron');

    // ── 1. Register this app as an OIDC client ──────────────────────────────
    const oidc = new SSOOIDCClient({ region: ssoRegion });
    const reg  = await oidc.send(new RegisterClientCommand({ clientName: 'maws', clientType: 'public' }));

    // ── 2. Start device authorization → get browser URL ────────────────────
    const device = await oidc.send(new StartDeviceAuthorizationCommand({
      clientId:     reg.clientId,
      clientSecret: reg.clientSecret,
      startUrl:     ssoStartUrl,
    }));

    // Open the AWS SSO browser page for the user
    shell.openExternal(device.verificationUriComplete);

    // ── 3. Poll until the user approves in the browser ──────────────────────
    const interval = (device.interval || 5) * 1000;
    const expires  = Date.now() + (device.expiresIn || 600) * 1000;
    let tokenResp;
    while (Date.now() < expires) {
      await new Promise(r => setTimeout(r, interval));
      try {
        tokenResp = await oidc.send(new CreateTokenCommand({
          clientId:     reg.clientId,
          clientSecret: reg.clientSecret,
          grantType:    'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode:   device.deviceCode,
        }));
        break;
      } catch (e) {
        if (e.name === 'AuthorizationPendingException') continue;
        if (e.name === 'SlowDownException') { await new Promise(r => setTimeout(r, 3000)); continue; }
        throw e;
      }
    }
    if (!tokenResp) return { ok: false, error: 'SSO login timed out. Please try again.' };

    // ── 4. Resolve account + role ────────────────────────────────────────────
    const sso = new SSOClient({ region: ssoRegion });
    let accountId = ssoAccountId;
    let roleName  = ssoRoleName;

    if (!accountId) {
      const accounts = await sso.send(new ListAccountsCommand({ accessToken: tokenResp.accessToken }));
      if (!accounts.accountList?.length) return { ok: false, error: 'No AWS accounts found for this SSO user.' };
      accountId = accounts.accountList[0].accountId;
    }
    if (!roleName) {
      const roles = await sso.send(new ListAccountRolesCommand({ accessToken: tokenResp.accessToken, accountId }));
      if (!roles.roleList?.length) return { ok: false, error: 'No roles found for account ' + accountId };
      roleName = roles.roleList[0].roleName;
    }

    // ── 5. Get role credentials ──────────────────────────────────────────────
    const roleResp = await sso.send(new GetRoleCredentialsCommand({
      accessToken: tokenResp.accessToken,
      accountId,
      roleName,
    }));
    const rc = roleResp.roleCredentials;
    const credentials = {
      accessKeyId:     rc.accessKeyId,
      secretAccessKey: rc.secretAccessKey,
      sessionToken:    rc.sessionToken,
      expiration:      rc.expiration ? new Date(rc.expiration) : undefined,
    };
    // Wrap in a provider function for later refreshes
    const provider = () => Promise.resolve(credentials);
    _session = { credentials, provider, profile: profileName, method: 'sso' };

    const identity = await _fetchIdentity(credentials);
    _session = { ..._session, ...identity };

    _scheduleExpiryWarning(credentials.expiration);

    audit.log({
      category: 'auth',
      event: 'AUTH_LOGIN_SUCCESS',
      message: `SSO login succeeded for profile "${profileName}"`,
      actor: identity.identityArn,
      account: identity.accountId,
      profile: profileName,
      result: 'success',
      details: { method: 'sso', region: identity.region },
    });

    await _persistSession();
    return { ok: true, method: 'sso', ...identity };
  } catch (err) {
    audit.log({
      category: 'auth',
      event: 'AUTH_LOGIN_FAILED',
      message: `SSO login failed for profile "${profileName}": ${err.message}`,
      profile: profileName,
      result: 'failure',
      details: { method: 'sso', error: err.message },
    });
    return { ok: false, error: err.message };
  }
}

/**
 * Login using a named profile (static credentials or assumed role).
 */
async function loginProfile(profileName) {
  try {
    const provider = fromIni({ profile: profileName });
    const credentials = await provider();
    _session = { credentials, provider, profile: profileName, method: 'profile' };

    const identity = await _fetchIdentity(credentials);
    _session = { ..._session, ...identity };

    _scheduleExpiryWarning(credentials.expiration);

    audit.log({
      category: 'auth',
      event: 'AUTH_LOGIN_SUCCESS',
      message: `Profile login succeeded for "${profileName}"`,
      actor: identity.identityArn,
      account: identity.accountId,
      profile: profileName,
      result: 'success',
      details: { method: 'profile', region: identity.region },
    });

    await _persistSession();
    return { ok: true, method: 'profile', ...identity };
  } catch (err) {
    audit.log({
      category: 'auth',
      event: 'AUTH_LOGIN_FAILED',
      message: `Profile login failed for "${profileName}": ${err.message}`,
      profile: profileName,
      result: 'failure',
      details: { method: 'profile', error: err.message },
    });
    return { ok: false, error: err.message };
  }
}

/**
 * Calls STS GetCallerIdentity to validate credentials and get identity info.
 */
async function _fetchIdentity(credentials) {
  // Derive region from session profile config
  const config = readAwsConfig();
  const profileSection =
    _session?.profile === 'default'
      ? config['default']
      : config[`profile ${_session?.profile}`] || {};
  const region = profileSection?.region || 'us-east-1';

  const sts = new STSClient({ credentials, region });
  const resp = await sts.send(new GetCallerIdentityCommand({}));
  return {
    accountId: resp.Account,
    userId: resp.UserId,
    identityArn: resp.Arn,
    region,
  };
}

/**
 * Re-fetch identity with current session credentials (e.g. after startup).
 */
async function getIdentity() {
  if (!_session) return { ok: false, error: 'Not authenticated' };
  try {
    // Refresh credentials in case they expired
    const credentials = await _session.provider();
    _session.credentials = credentials;
    const identity = await _fetchIdentity(credentials);
    _session = { ..._session, ...identity };
    return { ok: true, ...identity };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getSession() {
  if (!_session) return null;
  const exp = _session.credentials?.expiration;
  return {
    profile:     _session.profile,
    method:      _session.method,
    accountId:   _session.accountId,
    userId:      _session.userId,
    identityArn: _session.identityArn,
    region:      _session.region,
    expiration:  exp instanceof Date ? exp.toISOString() : (exp ?? null),
  };
}

/**
 * Returns the live credential provider for use by feature modules.
 * Feature modules should call this rather than holding credentials directly,
 * so they always get refreshed credentials.
 */
function getCredentialProvider() {
  return _session?.provider ?? null;
}

/**
 * Re-authenticates using the same profile and method as the current session.
 * For SSO: re-runs the device-auth flow (opens browser).
 * For profile: re-reads static credentials from ~/.aws/credentials.
 * Returns the same shape as loginSSO / loginProfile.
 */
async function refreshSession() {
  if (!_session) return { ok: false, error: 'No active session to refresh.' };
  const { profile, method } = _session;
  if (method === 'sso') {
    return loginSSO(profile);
  } else {
    return loginProfile(profile);
  }
}

/**
 * Schedules an event 60 seconds before credentials expire so the renderer
 * can prompt the user to re-authenticate before API calls start failing.
 * Called whenever a session is established (login or restore).
 */
function _scheduleExpiryWarning(expiration) {
  if (_expiryTimer) { clearTimeout(_expiryTimer); _expiryTimer = null; }
  if (!expiration) return;

  const msUntilExpiry  = new Date(expiration).getTime() - Date.now();
  const msUntilWarning = msUntilExpiry - 60_000; // warn 60 s before

  if (msUntilWarning <= 0) {
    // Already expired or about to — fire immediately
    setImmediate(() => authEvents.emit('session-expired'));
    return;
  }

  _expiryTimer = setTimeout(() => {
    authEvents.emit('session-expired');
  }, msUntilWarning);
}

function getRegion() {
  return _session?.region ?? 'us-east-1';
}

/**
 * Exchanges the current session's temporary credentials for an AWS Console
 * federation sign-in URL. Loading this URL in a webview creates a full browser
 * session (cookies), so all subsequent AWS Console / CloudShell navigation
 * in that session will be authenticated.
 */
async function getConsoleFederationUrl(destination = 'https://console.aws.amazon.com') {
  if (!_session?.credentials) return { ok: false, error: 'Not authenticated' };

  const { accessKeyId, secretAccessKey, sessionToken } = _session.credentials;
  const sessionJson = JSON.stringify({
    sessionId:    accessKeyId,
    sessionKey:   secretAccessKey,
    sessionToken: sessionToken,
  });

  // Step 1 — get a sign-in token from the federation endpoint
  const tokenUrl = 'https://signin.aws.amazon.com/federation'
    + '?Action=getSigninToken'
    + '&SessionDuration=43200'
    + '&Session=' + encodeURIComponent(sessionJson);

  const tokenResp = await new Promise((resolve, reject) => {
    const https = require('https');
    https.get(tokenUrl, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Failed to parse federation token response')); }
      });
    }).on('error', reject);
  });

  if (!tokenResp.SigninToken) return { ok: false, error: 'No SigninToken in federation response' };

  // Step 2 — build the login URL that sets the browser session
  const loginUrl = 'https://signin.aws.amazon.com/federation'
    + '?Action=login'
    + '&Issuer=maws'
    + '&Destination=' + encodeURIComponent(destination)
    + '&SigninToken=' + encodeURIComponent(tokenResp.SigninToken);

  return { ok: true, url: loginUrl };
}

function logout() {
  audit.log({
    category: 'auth',
    event: 'AUTH_LOGOUT',
    message: `User signed out${_session?.profile ? ` (profile: ${_session.profile})` : ''}`,
    actor: _session?.identityArn || null,
    account: _session?.accountId || null,
    profile: _session?.profile || null,
    result: 'info',
  });
  _session = null;
  if (_expiryTimer) { clearTimeout(_expiryTimer); _expiryTimer = null; }
  _clearPersistedSession(); // fire-and-forget; async but non-critical
  return { ok: true };
}

/**
 * Writes a new static credential profile to ~/.aws/credentials (and region to ~/.aws/config).
 */
function createAccessKeyProfile({ profileName, accessKeyId, secretAccessKey, region }) {
  if (!profileName || !accessKeyId || !secretAccessKey) {
    return { ok: false, error: 'Profile name, Access Key ID, and Secret Access Key are required.' };
  }
  if (!accessKeyId.match(/^[A-Z0-9]{16,}$/)) {
    return { ok: false, error: 'Access Key ID looks invalid — it should be uppercase letters and numbers.' };
  }

  const credPath = path.join(os.homedir(), '.aws', 'credentials');
  const cfgPath  = path.join(os.homedir(), '.aws', 'config');

  let existingCreds = '';
  let existingCfg   = '';
  try { existingCreds = fs.readFileSync(credPath, 'utf-8'); } catch {}
  try { existingCfg   = fs.readFileSync(cfgPath,  'utf-8'); } catch {}

  const credHeader = `[${profileName}]`;
  if (existingCreds.includes(credHeader)) {
    return { ok: false, error: `Profile "${profileName}" already exists in ~/.aws/credentials` };
  }

  const credBlock = [
    '',
    credHeader,
    `aws_access_key_id = ${accessKeyId.trim()}`,
    `aws_secret_access_key = ${secretAccessKey.trim()}`,
    '',
  ].join('\n');

  fs.mkdirSync(path.join(os.homedir(), '.aws'), { recursive: true });
  fs.appendFileSync(credPath, credBlock, 'utf-8');

  // Write region to config if provided
  if (region) {
    const cfgHeader = profileName === 'default' ? '[default]' : `[profile ${profileName}]`;
    if (!existingCfg.includes(cfgHeader)) {
      const cfgBlock = ['', cfgHeader, `region = ${region}`, `output = json`, ''].join('\n');
      fs.appendFileSync(cfgPath, cfgBlock, 'utf-8');
    }
  }

  return { ok: true, profileName };
}

/**
 * Writes a new SSO profile to ~/.aws/config using the modern sso-session format.
 */
function createSSOProfile({ profileName, ssoStartUrl, ssoRegion, defaultRegion }) {
  if (!profileName || !ssoStartUrl || !ssoRegion) {
    return { ok: false, error: 'Profile name, SSO start URL, and SSO region are required.' };
  }
  if (!ssoStartUrl.startsWith('https://')) {
    return { ok: false, error: 'SSO start URL must start with https://' };
  }

  const configPath = path.join(os.homedir(), '.aws', 'config');
  let existing = '';
  try { existing = fs.readFileSync(configPath, 'utf-8'); } catch {}

  const sectionHeader = profileName === 'default' ? '[default]' : `[profile ${profileName}]`;
  const sessionName   = `${profileName}-sso`;

  if (existing.includes(sectionHeader)) {
    return { ok: false, error: `Profile "${profileName}" already exists in ~/.aws/config` };
  }

  const block = [
    '',
    sectionHeader,
    `sso_session = ${sessionName}`,
    `region = ${defaultRegion || ssoRegion}`,
    `output = json`,
    '',
    `[sso-session ${sessionName}]`,
    `sso_start_url = ${ssoStartUrl.trim()}`,
    `sso_region = ${ssoRegion}`,
    `sso_registration_scopes = sso:account:access`,
    '',
  ].join('\n');

  fs.mkdirSync(path.join(os.homedir(), '.aws'), { recursive: true });
  fs.appendFileSync(configPath, block, 'utf-8');

  return { ok: true, profileName };
}

module.exports = {
  authEvents,
  listProfiles,
  loginSSO,
  loginProfile,
  refreshSession,
  getIdentity,
  getSession,
  getCredentialProvider,
  getRegion,
  logout,
  createSSOProfile,
  createAccessKeyProfile,
  getConsoleFederationUrl,
  restoreSession,
};
