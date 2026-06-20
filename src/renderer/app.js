'use strict';

/* ── State ─────────────────────────────────────────────────────────────── */
let currentView = 'auth';
let session = null;
let profiles = [];
let features = [];

/* ── Boot ──────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  setVersionLabel();
  await loadProfiles();
  await loadFeatures();

  // Resume session if credentials are already active
  const existingSession = await window.aws.getSession();
  if (existingSession) {
    session = existingSession;
    onAuthenticated(session);
  }

  startUTCClock();
  bindHealthTooltip();
  startHealthPolling();
  bindAuthUI();
  bindConsoleView();
  bindCloudShell();
  bindAuditLog();
  bindSettings();
  bindNav();
  loadPublicIP();
  initLockScreen();
});

/* ── AWS Health indicator ────────────────────────────────────────────────── */
const HEALTH_POLL_MS = 10 * 60 * 1000; // match main-process interval

function bindHealthTooltip() {
  const wrap    = document.getElementById('health-dot-wrap');
  const tooltip = document.getElementById('health-tooltip');
  if (!wrap || !tooltip) return;

  wrap.addEventListener('mouseenter', () => {
    const rect = wrap.getBoundingClientRect();
    tooltip.style.left = (rect.right + 10) + 'px';
    tooltip.style.top  = Math.max(8, rect.top - 4) + 'px';
    tooltip.style.display = 'block';
  });

  wrap.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });
}

function startHealthPolling() {
  // First call is likely too early — main process fetch takes a few seconds.
  // Check at 0s, 8s (fetch done by then), then every 10 minutes.
  updateHealthDot();
  setTimeout(updateHealthDot, 8000);
  setInterval(updateHealthDot, HEALTH_POLL_MS);
}

async function updateHealthDot() {
  const dot     = document.getElementById('health-dot');
  const tooltip = document.getElementById('health-tooltip');
  if (!dot || !tooltip) return;

  const data   = await window.aws.healthGetStatus();
  const status = data.status || 'unknown';

  dot.className = `health-${status}`;

  let text;
  if (status === 'green') {
    text = `✓ All AWS services operational\n\nLast checked: ${fmtTime(data.lastChecked)}`;
  } else if (status === 'yellow' || status === 'red') {
    const icon  = status === 'red' ? '✗' : '⚠';
    const lines = (data.events || []).slice(0, 5)
      .map(e => `${icon} ${e.region ? e.region + ' — ' : ''}${e.service}: ${e.summary}`)
      .join('\n');
    text = `AWS Health: ${status.toUpperCase()} — ${data.events.length} active event(s)\n\n${lines}\n\nLast checked: ${fmtTime(data.lastChecked)}`;
  } else {
    text = `AWS health unknown${data.error ? '\n' + data.error : ''}\n\nLast checked: ${fmtTime(data.lastChecked) || '—'}`;
  }

  tooltip.textContent = text;
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toUTCString();
}

/* ── UTC Clock ───────────────────────────────────────────────────────────── */
function startUTCClock() {
  const dateEl = document.getElementById('utc-date');
  const timeEl = document.getElementById('utc-time');

  function tick() {
    const now = new Date();
    dateEl.textContent = now.toISOString().slice(0, 10);
    timeEl.textContent = now.toISOString().slice(11, 19);
  }

  tick();
  setInterval(tick, 1000);
}

/* ── Console federation ──────────────────────────────────────────────────── */
async function federateConsoleSession() {
  // Get a sign-in URL that sets browser cookies for the full AWS Console session.
  // Both the Console and CloudShell webviews share these cookies automatically.
  const result = await window.aws.invoke('auth:get-console-federation-url', 'https://console.aws.amazon.com');
  if (!result.ok) return; // silently skip — webviews will just show login

  const consoleView   = document.getElementById('console-webview');
  const cloudshellView = document.getElementById('cloudshell-webview');

  // Load the federation URL into the console webview to create the session.
  // Once it sets cookies and redirects to the console, CloudShell will also
  // be authenticated because it shares the same Electron session.
  if (consoleView) consoleView.loadURL(result.url);

  // For CloudShell, wait a moment for the cookies to land then navigate.
  if (cloudshellView) {
    setTimeout(() => {
      cloudshellView.loadURL('https://console.aws.amazon.com/cloudshell/home');
    }, 2000);
  }
}

/* ── Current month cost ──────────────────────────────────────────────────── */
async function loadCurrentCost() {
  const cardEl   = document.getElementById('card-cost');
  const badgeEl  = document.getElementById('identity-cost');
  if (cardEl) cardEl.textContent = 'Loading…';

  const result = await window.aws.invoke('billing:get-current-month-cost');

  if (!result.ok) {
    const msg = result.error?.includes('AccessDenied') || result.error?.includes('not authorized')
      ? 'No cost access'
      : '—';
    if (cardEl)  cardEl.textContent = msg;
    if (badgeEl) badgeEl.classList.add('hidden');
    return;
  }

  const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: result.unit || 'USD', minimumFractionDigits: 2 });
  const display = fmt.format(result.amount);
  const now = new Date();
  const monthName = now.toLocaleString('default', { month: 'long' });

  if (cardEl)  cardEl.textContent = `${display} (${monthName})`;
  if (badgeEl) {
    badgeEl.textContent = `${display} this month`;
    badgeEl.classList.remove('hidden');
  }
}

/* ── Public IP ───────────────────────────────────────────────────────────── */
async function loadPublicIP() {
  const el    = document.getElementById('public-ip');
  const valEl = document.getElementById('public-ip-value');
  if (!el || !valEl) return;

  const result = await window.aws.invoke('util:get-public-ip');
  if (result.ok && result.ip) {
    valEl.textContent = result.ip;
    el.title = `Public IP: ${result.ip} — click to copy`;
  } else {
    valEl.textContent = 'unavailable';
  }

  el.addEventListener('click', () => {
    const ip = valEl.textContent;
    if (!ip || ip === '…' || ip === 'unavailable') return;
    navigator.clipboard.writeText(ip).then(() => {
      valEl.textContent = '✓ Copied';
      setTimeout(() => { valEl.textContent = ip; }, 1600);
    });
  });
}

/* ── Version ────────────────────────────────────────────────────────────── */
function setVersionLabel() {
  const el = document.getElementById('version-label');
  if (el) el.textContent = 'v0.1.0';

  const donateBtn = document.getElementById('donate-btn');
  if (donateBtn) {
    donateBtn.addEventListener('click', () => {
      window.aws.openExternal('https://buymeacoffee.com/r41n403');
    });
  }
}

/* ── Profile picker ─────────────────────────────────────────────────────── */
async function loadProfiles() {
  profiles = await window.aws.listProfiles();
  const select = document.getElementById('profile-select');
  select.innerHTML = '';

  if (!profiles.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No AWS profiles found';
    opt.disabled = true;
    select.appendChild(opt);
    return;
  }

  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    select.appendChild(opt);
  }

  select.addEventListener('change', updateProfileHint);
  updateProfileHint();

  // Auto-expand SSO setup if no SSO profiles exist
  const hasSso = profiles.some(p => p.type === 'sso');
  if (!hasSso) {
    document.getElementById('sso-setup-panel').classList.remove('hidden');
    document.getElementById('sso-setup-toggle').classList.add('active');
  }
}

function updateProfileHint() {
  const select = document.getElementById('profile-select');
  const hint = document.getElementById('profile-type-hint');
  const btnSSO = document.getElementById('btn-sso');
  const btnProfile = document.getElementById('btn-profile');

  const profile = profiles.find((p) => p.name === select.value);
  if (!profile) return;

  if (profile.type === 'sso') {
    hint.textContent = `✅ SSO profile${profile.ssoStartUrl ? ` — ${profile.ssoStartUrl}` : ''}`;
    btnSSO.disabled = false;
    btnProfile.disabled = true;
  } else {
    hint.textContent = `🗂 Static credential profile${profile.region ? ` — ${profile.region}` : ''}`;
    btnSSO.disabled = true;
    btnProfile.disabled = false;
  }
}

/* ── Auth UI ────────────────────────────────────────────────────────────── */
function bindAuthUI() {
  document.getElementById('btn-sso').addEventListener('click', () => {
    const profile = document.getElementById('profile-select').value;
    doAuth(() => window.aws.loginSSO(profile), 'Opening browser for SSO login…');
  });

  document.getElementById('btn-profile').addEventListener('click', () => {
    const profile = document.getElementById('profile-select').value;
    doAuth(() => window.aws.loginProfile(profile), 'Loading profile credentials…');
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await window.aws.logout();
    session = null;
    onLoggedOut();
  });

  // Access key setup panel toggle
  document.getElementById('key-setup-toggle').addEventListener('click', () => {
    const panel = document.getElementById('key-setup-panel');
    const isHidden = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !isHidden);
    document.getElementById('key-setup-toggle').classList.toggle('active', isHidden);
  });

  document.getElementById('key-setup-save').addEventListener('click', async () => {
    const profileName     = document.getElementById('key-profile-name').value.trim();
    const accessKeyId     = document.getElementById('key-access-key-id').value.trim();
    const secretAccessKey = document.getElementById('key-secret-key').value.trim();
    const region          = document.getElementById('key-region').value.trim();

    const errEl     = document.getElementById('key-setup-error');
    const successEl = document.getElementById('key-setup-success');
    errEl.classList.add('hidden');
    successEl.classList.add('hidden');

    const result = await window.aws.invoke('auth:create-access-key-profile', { profileName, accessKeyId, secretAccessKey, region });
    if (!result.ok) {
      errEl.textContent = result.error;
      errEl.classList.remove('hidden');
      return;
    }

    successEl.textContent = `✓ Profile "${result.profileName}" saved to ~/.aws/credentials. Reloading profiles…`;
    successEl.classList.remove('hidden');

    setTimeout(async () => {
      await loadProfiles();
      document.getElementById('key-setup-panel').classList.add('hidden');
      document.getElementById('key-setup-toggle').classList.remove('active');
      successEl.classList.add('hidden');
      // Clear sensitive fields
      document.getElementById('key-access-key-id').value = '';
      document.getElementById('key-secret-key').value = '';
    }, 1800);
  });

  // SSO setup panel toggle
  document.getElementById('sso-setup-toggle').addEventListener('click', () => {
    const panel = document.getElementById('sso-setup-panel');
    const isHidden = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !isHidden);
    document.getElementById('sso-setup-toggle').classList.toggle('active', isHidden);
  });

  document.getElementById('sso-setup-save').addEventListener('click', async () => {
    const profileName   = document.getElementById('sso-profile-name').value.trim();
    const ssoStartUrl   = document.getElementById('sso-start-url').value.trim();
    const ssoRegion     = document.getElementById('sso-region').value.trim();
    const defaultRegion = document.getElementById('sso-default-region').value.trim();

    const errEl     = document.getElementById('sso-setup-error');
    const successEl = document.getElementById('sso-setup-success');
    errEl.classList.add('hidden');
    successEl.classList.add('hidden');

    const result = await window.aws.invoke('auth:create-sso-profile', { profileName, ssoStartUrl, ssoRegion, defaultRegion });
    if (!result.ok) {
      errEl.textContent = result.error;
      errEl.classList.remove('hidden');
      return;
    }

    successEl.textContent = `✓ Profile "${result.profileName}" saved to ~/.aws/config. Reloading profiles…`;
    successEl.classList.remove('hidden');

    setTimeout(async () => {
      await loadProfiles();
      document.getElementById('sso-setup-panel').classList.add('hidden');
      document.getElementById('sso-setup-toggle').classList.remove('active');
      successEl.classList.add('hidden');
    }, 1800);
  });
}

async function doAuth(authFn, statusText) {
  showAuthStatus(statusText);
  hideError();

  try {
    const result = await authFn();
    if (!result.ok) {
      throw new Error(result.error || 'Authentication failed');
    }
    session = result;
    onAuthenticated(session);
  } catch (err) {
    showError(err.message);
  } finally {
    hideAuthStatus();
  }
}

function showAuthStatus(text) {
  const el = document.getElementById('auth-status');
  document.getElementById('auth-status-text').textContent = text;
  el.classList.remove('hidden');
  document.getElementById('btn-sso').disabled = true;
  document.getElementById('btn-profile').disabled = true;
}

function hideAuthStatus() {
  document.getElementById('auth-status').classList.add('hidden');
  updateProfileHint(); // re-enables the right button
}

function showError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = `⚠️  ${msg}`;
  el.classList.remove('hidden');
}

function hideError() {
  document.getElementById('auth-error').classList.add('hidden');
}

/* ── Post-auth state ────────────────────────────────────────────────────── */
function onAuthenticated(s) {
  // Update sidebar badge
  const badge = document.getElementById('identity-badge');
  document.getElementById('identity-account').textContent = `Account: ${s.accountId || '—'}`;
  const roleMatch = (s.identityArn || '').match(/(?:assumed-role|user)\/(.+)/);
  document.getElementById('identity-role').textContent = roleMatch ? roleMatch[1] : (s.identityArn || '');
  badge.classList.remove('hidden');

  // Update dashboard cards
  document.getElementById('card-account').textContent = s.accountId || '—';
  document.getElementById('card-arn').textContent = s.identityArn || '—';
  document.getElementById('card-region').textContent = s.region || '—';
  document.getElementById('card-method').textContent = s.method === 'sso' ? '🔐 IAM Identity Center (SSO)' : '🗂 Profile Credentials';

  // Fetch and display current month cost
  loadCurrentCost();

  // Federate API credentials into a web console session so the Console
  // and CloudShell webviews don't show the sign-in page
  federateConsoleSession();

  // Show logout button, hide auth nav item
  document.getElementById('logout-btn').classList.remove('hidden');
  document.querySelector('.nav-item[data-view="auth"]').classList.add('hidden');

  // Navigate to home/dashboard
  showView('home');
}

function onLoggedOut() {
  document.getElementById('identity-badge').classList.add('hidden');
  document.getElementById('logout-btn').classList.add('hidden');
  document.querySelector('.nav-item[data-view="auth"]').classList.remove('hidden');
  showView('auth');
  setActiveNav('auth');
}

/* ── Feature loading ────────────────────────────────────────────────────── */
async function loadFeatures() {
  features = await window.aws.listFeatures();
  const navList = document.getElementById('nav-list');
  const content = document.getElementById('content');

  // Built-in home nav item (insert after auth)
  const homeItem = document.createElement('li');
  homeItem.className = 'nav-item';
  homeItem.dataset.view = 'home';
  homeItem.innerHTML = '<span class="nav-icon">🏠</span><span class="nav-label">Dashboard</span>';
  navList.appendChild(homeItem);

  for (const feature of features) {
    // Sidebar item
    const li = document.createElement('li');
    li.className = 'nav-item';
    li.dataset.view = `feature-${feature.id}`;
    li.title = feature.description;
    li.innerHTML = `<span class="nav-icon">${feature.icon}</span><span class="nav-label">${feature.name}</span>`;
    navList.appendChild(li);

    // View section
    const section = document.createElement('section');
    section.id = `view-feature-${feature.id}`;
    section.className = 'view hidden';
    section.innerHTML = buildFeatureView(feature);
    content.appendChild(section);

    // Bind feature-specific actions
    bindFeatureActions(feature, section);
  }
}

function buildFeatureView(feature) {
  if (feature.id === 'resource-lister') {
    return `
      <div class="view-header">
        <h2>${feature.icon} ${feature.name}</h2>
      </div>
      <div class="feature-toolbar">
        <button class="btn btn-primary btn-sm" id="resource-lister-refresh">Refresh</button>
        <span id="resource-lister-count" style="color:var(--text-muted);font-size:12px;"></span>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;">
        <table class="feature-table">
          <thead>
            <tr>
              <th>Bucket Name</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody id="resource-lister-tbody">
            <tr><td colspan="2" style="color:var(--text-muted)">Click Refresh to load buckets.</td></tr>
          </tbody>
        </table>
      </div>
    `;
  }

  if (feature.id === 'arn-scratchpad') {
    return `
      <div class="view-header" style="display:flex;align-items:center;justify-content:space-between;">
        <h2>📌 ARN Scratchpad</h2>
        <span id="arn-count" style="font-size:11px;color:var(--text-muted)"></span>
      </div>

      <div id="arn-add-form">
        <div id="arn-add-inputs">
          <input id="arn-input" type="text" placeholder="arn:aws:…  — paste an ARN" spellcheck="false" autocomplete="off" />
          <input id="arn-label-input" type="text" placeholder="Label (optional)" />
          <button id="arn-add-btn" class="btn btn-primary btn-sm">Add</button>
        </div>
        <div id="arn-add-error" class="hidden" style="color:var(--error);font-size:11px;margin-top:5px;"></div>
      </div>

      <div id="arn-list"></div>
    `;
  }

  // Default generic view for unknown features
  return `
    <div class="view-header">
      <h2>${feature.icon} ${feature.name}</h2>
    </div>
    <p style="color:var(--text-secondary)">${feature.description}</p>
    <div class="hint-box" style="margin-top:16px">
      Add a renderer view for this feature in <code>src/renderer/app.js</code> → <code>buildFeatureView()</code>.
    </div>
  `;
}

function bindFeatureActions(feature, section) {
  if (feature.id === 'resource-lister') {
    section.querySelector('#resource-lister-refresh').addEventListener('click', async () => {
      const tbody = section.querySelector('#resource-lister-tbody');
      const count = section.querySelector('#resource-lister-count');
      tbody.innerHTML = '<tr><td colspan="2"><div class="spinner" style="margin:8px auto"></div></td></tr>';
      count.textContent = '';

      const result = await window.aws.invoke('resource-lister:list-buckets');
      if (!result.ok) {
        tbody.innerHTML = `<tr><td colspan="2" style="color:var(--error)">${result.error}</td></tr>`;
        return;
      }
      if (!result.buckets.length) {
        tbody.innerHTML = '<tr><td colspan="2" style="color:var(--text-muted)">No buckets found.</td></tr>';
        return;
      }
      count.textContent = `${result.buckets.length} bucket${result.buckets.length !== 1 ? 's' : ''}`;
      tbody.innerHTML = result.buckets
        .map(
          (b) =>
            `<tr><td>${b.name}</td><td>${b.created ? new Date(b.created).toLocaleDateString() : '—'}</td></tr>`
        )
        .join('');
    });
  }

  if (feature.id === 'arn-scratchpad') {
    bindArnScratchpad(section);
  }
}

/* ── ARN Scratchpad ─────────────────────────────────────────────────────── */

const ARN_SERVICE_ICONS = {
  s3: '🪣', iam: '👤', lambda: '⚡', ec2: '🖥', rds: '🗄',
  ecs: '📦', eks: '☸', sns: '📢', sqs: '📨', dynamodb: '🗃',
  secretsmanager: '🔐', kms: '🔑', logs: '📋', cloudwatch: '📊',
  cloudformation: '📐', codecommit: '📝', codepipeline: '🔁',
  elasticloadbalancing: '⚖', apigateway: '🚪', route53: '🌐',
  cognito: '🪪', states: '🔀', glue: '🔧', athena: '🔍',
};

function arnServiceIcon(arn) {
  const svc = (arn.split(':')[2] || '').toLowerCase();
  return ARN_SERVICE_ICONS[svc] || '☁️';
}

function arnServiceLabel(arn) {
  const parts = arn.split(':');
  const svc = (parts[2] || '').toUpperCase();
  const region = parts[3] || '';
  return region ? `${svc} · ${region}` : svc;
}

function bindArnScratchpad(section) {
  const arnInput   = section.querySelector('#arn-input');
  const labelInput = section.querySelector('#arn-label-input');
  const addBtn     = section.querySelector('#arn-add-btn');
  const errEl      = section.querySelector('#arn-add-error');
  const listEl     = section.querySelector('#arn-list');
  const countEl    = section.querySelector('#arn-count');

  async function loadAndRender() {
    const result = await window.aws.invoke('arn-scratchpad:list');
    renderArns(result.entries || []);
  }

  function renderArns(entries) {
    countEl.textContent = entries.length ? `${entries.length} saved` : '';
    if (!entries.length) {
      listEl.innerHTML = `<div class="arn-empty">No ARNs saved yet. Paste one above to get started.</div>`;
      return;
    }
    listEl.innerHTML = entries.map(e => `
      <div class="arn-row" data-id="${e.id}">
        <span class="arn-icon">${arnServiceIcon(e.arn)}</span>
        <div class="arn-body">
          <div class="arn-meta">
            <span class="arn-service-badge">${arnServiceLabel(e.arn)}</span>
            ${e.label ? `<span class="arn-label-text">${escHtml(e.label)}</span>` : ''}
            <span class="arn-date">${new Date(e.addedAt).toLocaleDateString()}</span>
          </div>
          <div class="arn-text" title="${escHtml(e.arn)}">${escHtml(e.arn)}</div>
        </div>
        <div class="arn-actions">
          <button class="arn-copy-btn" title="Copy ARN">Copy</button>
          <button class="arn-delete-btn" title="Remove">✕</button>
        </div>
      </div>
    `).join('');

    // Copy buttons
    listEl.querySelectorAll('.arn-copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = btn.closest('.arn-row');
        const arn = entries.find(en => en.id === row.dataset.id)?.arn;
        if (!arn) return;
        navigator.clipboard.writeText(arn).then(() => {
          btn.textContent = '✓ Copied';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1800);
        });
      });
    });

    // Click entire row to copy too
    listEl.querySelectorAll('.arn-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const arn = entries.find(en => en.id === row.dataset.id)?.arn;
        if (!arn) return;
        navigator.clipboard.writeText(arn).then(() => {
          row.classList.add('arn-flash');
          setTimeout(() => row.classList.remove('arn-flash'), 500);
        });
      });
    });

    // Delete buttons
    listEl.querySelectorAll('.arn-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.closest('.arn-row').dataset.id;
        await window.aws.invoke('arn-scratchpad:delete', { id });
        loadAndRender();
      });
    });
  }

  async function addArn() {
    const arn   = (arnInput.value || '').trim();
    const label = (labelInput.value || '').trim();
    errEl.classList.add('hidden');
    errEl.textContent = '';

    const result = await window.aws.invoke('arn-scratchpad:add', { arn, label });
    if (!result.ok) {
      errEl.textContent = result.error;
      errEl.classList.remove('hidden');
      arnInput.focus();
      return;
    }
    arnInput.value  = '';
    labelInput.value = '';
    loadAndRender();
  }

  addBtn.addEventListener('click', addArn);
  arnInput.addEventListener('keydown', e => { if (e.key === 'Enter') addArn(); });

  // Paste handler — auto-extract first ARN from clipboard if text is pasted into the field
  arnInput.addEventListener('paste', (e) => {
    const pasted = (e.clipboardData || window.clipboardData).getData('text');
    const match  = pasted.match(/arn:[^\s"']+/);
    if (match && match[0] !== pasted.trim()) {
      e.preventDefault();
      arnInput.value = match[0];
    }
  });

  loadAndRender();
}

/* ── Lock screen ─────────────────────────────────────────────────────────── */
let _lockSettings   = null;
let _lastActivity   = Date.now();
let _lockTimer      = null;
let _locked         = false;

function resetActivity() { _lastActivity = Date.now(); }

async function initLockScreen() {
  _lockSettings = await window.aws.invoke('settings:get');
  if (!_lockSettings.lockEnabled) return;

  // If password method is selected but no password has ever been set,
  // that's a truly unconfigured state — disable and skip rather than locking.
  if (_lockSettings.lockMethod === 'password' && !_lockSettings.hasPassword) {
    await window.aws.invoke('settings:save', { lockEnabled: false });
    _lockSettings = await window.aws.invoke('settings:get');
    return;
  }

  // Show lock screen immediately on launch
  showLockScreen();

  // Activity tracking for timeout
  if (_lockSettings.lockTimeout > 0) {
    ['mousemove','mousedown','keydown','scroll','touchstart'].forEach(ev =>
      document.addEventListener(ev, resetActivity, { passive: true })
    );
    _lockTimer = setInterval(() => {
      if (_locked) return;
      const idle = (Date.now() - _lastActivity) / 1000 / 60;
      if (idle >= _lockSettings.lockTimeout) showLockScreen();
    }, 30_000);
  }
}

async function showLockScreen() {
  if (_locked) return;
  _locked = true;
  const screen = document.getElementById('lock-screen');
  const tidBtn = document.getElementById('lock-touchid-btn');
  const pwWrap = document.getElementById('lock-password-wrap');
  const errEl  = document.getElementById('lock-error');

  screen.classList.remove('hidden');
  errEl.classList.add('hidden');

  const method = _lockSettings?.lockMethod || 'touchid';

  if (method === 'touchid') {
    const { available } = await window.aws.invoke('settings:touchid-available');
    if (available) {
      tidBtn.classList.remove('hidden');
      pwWrap.classList.add('hidden');
      setTimeout(tryTouchID, 400);
    } else if (_lockSettings?.hasPassword) {
      // Touch ID unavailable right now — fall back to password
      tidBtn.classList.add('hidden');
      pwWrap.classList.remove('hidden');
      errEl.textContent = 'Touch ID unavailable — enter your password.';
      errEl.classList.remove('hidden');
      setTimeout(() => document.getElementById('lock-password-input')?.focus(), 100);
    } else {
      // No usable method at all — unlock without blocking
      dismissLockScreen();
    }
  } else {
    tidBtn.classList.add('hidden');
    pwWrap.classList.remove('hidden');
    setTimeout(() => document.getElementById('lock-password-input')?.focus(), 100);
  }
}

function dismissLockScreen() {
  _locked = false;
  _lastActivity = Date.now();
  document.getElementById('lock-screen').classList.add('hidden');
  document.getElementById('lock-password-input').value = '';
  document.getElementById('lock-error').classList.add('hidden');
}

async function tryTouchID() {
  const result = await window.aws.invoke('settings:prompt-touchid');
  if (result.ok) { dismissLockScreen(); return; }
  // Fall back to password input if Touch ID fails
  const errEl = document.getElementById('lock-error');
  document.getElementById('lock-touchid-btn').classList.add('hidden');
  document.getElementById('lock-password-wrap').classList.remove('hidden');
  if (result.error && !result.error.includes('cancelled')) {
    errEl.textContent = result.error;
    errEl.classList.remove('hidden');
  }
  document.getElementById('lock-password-input').focus();
}

// Bind lock screen button events (called once at boot)
(function bindLockScreen() {
  document.getElementById('lock-touchid-btn').addEventListener('click', tryTouchID);

  async function submitPassword() {
    const pw    = document.getElementById('lock-password-input').value;
    const errEl = document.getElementById('lock-error');
    errEl.classList.add('hidden');
    const result = await window.aws.invoke('settings:verify-password', pw);
    if (result.ok) { dismissLockScreen(); }
    else {
      errEl.textContent = 'Incorrect password.';
      errEl.classList.remove('hidden');
      document.getElementById('lock-password-input').select();
    }
  }

  document.getElementById('lock-submit-btn').addEventListener('click', submitPassword);
  document.getElementById('lock-password-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitPassword();
  });
})();

/* ── Settings view ───────────────────────────────────────────────────────── */
async function bindSettings() {
  const s = await window.aws.invoke('settings:get');
  const tidAvailable = (await window.aws.invoke('settings:touchid-available')).available;

  const toggle     = document.getElementById('lock-enabled-toggle');
  const options    = document.getElementById('lock-options');
  const tidBtn     = document.getElementById('method-touchid');
  const pwBtn      = document.getElementById('method-password');
  const timeoutSel = document.getElementById('lock-timeout-select');
  const pwWrap     = document.getElementById('password-setup-wrap');

  // Initialise from saved settings
  toggle.checked = s.lockEnabled;
  options.classList.toggle('hidden', !s.lockEnabled);
  timeoutSel.value = String(s.lockTimeout);

  if (!tidAvailable) {
    tidBtn.disabled = true;
    tidBtn.title = 'Touch ID not available on this device';
    if (s.lockMethod === 'touchid') {
      // Fall back to password if Touch ID was set but isn't available
      await window.aws.invoke('settings:save', { lockMethod: 'password' });
      s.lockMethod = 'password';
    }
  }

  // Inline notice shown when lock can't be enabled yet
  let lockNotice = document.getElementById('lock-not-ready-notice');
  if (!lockNotice) {
    lockNotice = document.createElement('p');
    lockNotice.id = 'lock-not-ready-notice';
    lockNotice.className = 'settings-warning hidden';
    toggle.closest('.settings-row').insertAdjacentElement('afterend', lockNotice);
  }

  function isMethodReady(method, hasPw) {
    return method === 'touchid' ? tidAvailable : hasPw;
  }

  function refreshReadiness(method, hasPw) {
    const ready = isMethodReady(method, hasPw);
    if (!ready) {
      const hint = method === 'touchid'
        ? 'Touch ID is not available on this device. Switch to Password and set one first.'
        : 'Set a password below before enabling the lock.';
      lockNotice.textContent = '⚠ ' + hint;
      lockNotice.classList.remove('hidden');
    } else {
      lockNotice.classList.add('hidden');
    }
    return ready;
  }

  function setActiveMethod(method) {
    tidBtn.classList.toggle('active', method === 'touchid');
    pwBtn.classList.toggle('active', method === 'password');
    pwWrap.classList.toggle('hidden', method !== 'password');
  }
  setActiveMethod(s.lockMethod);
  refreshReadiness(s.lockMethod, s.hasPassword);

  // Enable / disable lock — only allow enabling when method is configured
  toggle.addEventListener('change', async () => {
    const latest = await window.aws.invoke('settings:get');
    if (toggle.checked && !isMethodReady(latest.lockMethod, latest.hasPassword)) {
      toggle.checked = false;   // revert
      refreshReadiness(latest.lockMethod, latest.hasPassword);
      return;
    }
    options.classList.toggle('hidden', !toggle.checked);
    await window.aws.invoke('settings:save', { lockEnabled: toggle.checked });
    _lockSettings = await window.aws.invoke('settings:get');
    lockNotice.classList.add('hidden');
  });

  // Method buttons
  [tidBtn, pwBtn].forEach(btn => {
    btn.addEventListener('click', async () => {
      const method = btn.dataset.method;
      setActiveMethod(method);
      await window.aws.invoke('settings:save', { lockMethod: method });
      _lockSettings = await window.aws.invoke('settings:get');
      // If lock is on and method isn't ready yet, auto-disable
      if (_lockSettings.lockEnabled && !isMethodReady(method, _lockSettings.hasPassword)) {
        await window.aws.invoke('settings:save', { lockEnabled: false });
        _lockSettings = await window.aws.invoke('settings:get');
        toggle.checked = false;
      }
      refreshReadiness(method, _lockSettings.hasPassword);
    });
  });

  // Timeout
  timeoutSel.addEventListener('change', async () => {
    await window.aws.invoke('settings:save', { lockTimeout: Number(timeoutSel.value) });
    _lockSettings = await window.aws.invoke('settings:get');
    // Restart activity timer with new interval
    if (_lockTimer) clearInterval(_lockTimer);
    if (_lockSettings.lockEnabled && _lockSettings.lockTimeout > 0) {
      _lockTimer = setInterval(() => {
        if (_locked) return;
        const idle = (Date.now() - _lastActivity) / 1000 / 60;
        if (idle >= _lockSettings.lockTimeout) showLockScreen();
      }, 30_000);
    }
  });

  // Password setup
  document.getElementById('save-password-btn').addEventListener('click', async () => {
    const pw1   = document.getElementById('new-password').value;
    const pw2   = document.getElementById('confirm-password').value;
    const errEl = document.getElementById('password-error');
    const okEl  = document.getElementById('password-success');
    errEl.classList.add('hidden');
    okEl.classList.add('hidden');

    if (pw1 !== pw2) { errEl.textContent = 'Passwords do not match.'; errEl.classList.remove('hidden'); return; }
    const result = await window.aws.invoke('settings:set-password', pw1);
    if (!result.ok) { errEl.textContent = result.error; errEl.classList.remove('hidden'); return; }

    okEl.textContent = '✓ Password saved. You can now enable the lock above.';
    okEl.classList.remove('hidden');
    document.getElementById('new-password').value = '';
    document.getElementById('confirm-password').value = '';
    // Re-check readiness now that a password exists
    refreshReadiness('password', true);
  });
}

function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Navigation ─────────────────────────────────────────────────────────── */
function bindNav() {
  // Both nav lists (workspace + system)
  document.addEventListener('click', (e) => {
    const item = e.target.closest('.nav-item');
    if (!item) return;
    const view = item.dataset.view;
    if (!view) return;

    // Views accessible without auth
    const noAuthRequired = ['auth', 'console', 'cloudshell', 'audit', 'settings', 'feature-arn-scratchpad'];
    if (!noAuthRequired.includes(view) && !session) return;

    setActiveNav(view);
    showView(view);
  });
}

function setActiveNav(view) {
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === view);
  });
}


function showView(viewId) {
  document.querySelectorAll('.view').forEach((el) => {
    el.classList.remove('active');
    el.classList.add('hidden');
  });
  const target = document.getElementById(`view-${viewId}`);
  if (target) {
    target.classList.remove('hidden');
    target.classList.add('active');
  }
  currentView = viewId;
  setActiveNav(viewId);

  // Auto-load audit entries when switching to that view
  if (viewId === 'audit') loadAuditEntries();
}

/* ── AWS Console embedded browser ───────────────────────────────────────── */
const AWS_CONSOLE_HOME = 'https://console.aws.amazon.com';

function bindConsoleView() {
  const webview = document.getElementById('console-webview');
  const urlText = document.getElementById('console-url-text');
  const loadingBar = document.getElementById('console-loading-bar');
  const btnBack = document.getElementById('console-back');
  const btnForward = document.getElementById('console-forward');
  const btnRefresh = document.getElementById('console-refresh');
  const btnHome = document.getElementById('console-home');
  const btnPopout = document.getElementById('console-popout');

  if (!webview) return;

  // Toolbar controls
  btnBack.addEventListener('click', () => webview.goBack());
  btnForward.addEventListener('click', () => webview.goForward());
  btnRefresh.addEventListener('click', () => webview.reload());
  btnHome.addEventListener('click', () => webview.loadURL(AWS_CONSOLE_HOME));
  btnPopout.addEventListener('click', () => window.aws.openExternal(webview.getURL()));

  // URL bar updates
  webview.addEventListener('did-navigate', (e) => {
    urlText.textContent = e.url;
    btnBack.disabled = !webview.canGoBack();
    btnForward.disabled = !webview.canGoForward();
  });

  webview.addEventListener('did-navigate-in-page', (e) => {
    urlText.textContent = e.url;
  });


  // Loading indicator
  webview.addEventListener('did-start-loading', () => {
    loadingBar.classList.remove('hidden');
  });

  webview.addEventListener('did-stop-loading', () => {
    loadingBar.classList.add('hidden');
    btnBack.disabled = !webview.canGoBack();
    btnForward.disabled = !webview.canGoForward();
  });

  // Disable buttons initially
  btnBack.disabled = true;
  btnForward.disabled = true;
}

/* ── CloudShell embedded terminal ───────────────────────────────────────── */
const CLOUDSHELL_URL = 'https://console.aws.amazon.com/cloudshell/home';

function bindCloudShell() {
  const webview    = document.getElementById('cloudshell-webview');
  const loadingBar = document.getElementById('cloudshell-loading-bar');
  const btnRefresh = document.getElementById('cloudshell-refresh');
  const btnPopout  = document.getElementById('cloudshell-popout');

  if (!webview) return;

  btnRefresh.addEventListener('click', () => webview.reload());
  btnPopout.addEventListener('click',  () => window.aws.openExternal(webview.getURL()));

  webview.addEventListener('did-start-loading', () => loadingBar.classList.remove('hidden'));
  webview.addEventListener('did-stop-loading',  () => loadingBar.classList.add('hidden'));

}

/* ── Audit Log viewer ───────────────────────────────────────────────────── */
let _auditEntries = [];

function bindAuditLog() {
  const searchEl   = document.getElementById('audit-search');
  const catEl      = document.getElementById('audit-filter-category');
  const resultEl   = document.getElementById('audit-filter-result');
  const refreshBtn = document.getElementById('audit-refresh');
  const csvBtn     = document.getElementById('audit-export-csv');
  const jsonBtn    = document.getElementById('audit-export-json');
  const detailClose = document.getElementById('audit-detail-close');

  if (!refreshBtn) return;

  refreshBtn.addEventListener('click', loadAuditEntries);
  searchEl.addEventListener('input', renderAuditTable);
  catEl.addEventListener('change', renderAuditTable);
  resultEl.addEventListener('change', renderAuditTable);

  csvBtn.addEventListener('click', async () => {
    const csv = await window.aws.auditExportCSV();
    downloadText(csv, 'maws-audit-log.csv', 'text/csv');
  });

  jsonBtn.addEventListener('click', async () => {
    const json = await window.aws.auditExportJSON();
    downloadText(json, 'maws-audit-log.json', 'application/json');
  });

  detailClose.addEventListener('click', () => {
    document.getElementById('audit-detail').classList.add('hidden');
  });
}

async function loadAuditEntries() {
  const tbody = document.getElementById('audit-tbody');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px"><div class="spinner" style="margin:0 auto"></div></td></tr>';

  _auditEntries = await window.aws.auditGetEntries({ limit: 1000 });

  const info = await window.aws.auditGetInfo();
  const infoEl = document.getElementById('audit-info');
  if (infoEl) infoEl.textContent = `${info.count} events · ${info.sizeKB} KB`;

  renderAuditTable();
}

function renderAuditTable() {
  const search = (document.getElementById('audit-search')?.value || '').toLowerCase();
  const cat    = document.getElementById('audit-filter-category')?.value || '';
  const result = document.getElementById('audit-filter-result')?.value || '';

  let entries = _auditEntries;

  if (cat)    entries = entries.filter(e => e.category === cat);
  if (result) entries = entries.filter(e => e.result === result);
  if (search) entries = entries.filter(e =>
    (e.message||'').toLowerCase().includes(search) ||
    (e.event||'').toLowerCase().includes(search) ||
    (e.actor||'').toLowerCase().includes(search) ||
    (e.account||'').toLowerCase().includes(search)
  );

  const tbody = document.getElementById('audit-tbody');
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-muted);text-align:center;padding:24px">No entries match the current filter.</td></tr>';
    return;
  }

  tbody.innerHTML = entries.map(e => {
    const time = new Date(e.timestamp).toLocaleString();
    const resultClass = `audit-result-${e.result}`;
    const catClass = `badge-${e.category}`;
    const resultLabel = e.result === 'success' ? '✓ Success' : e.result === 'failure' ? '✗ Failure' : '· Info';
    return `<tr data-id="${e.id}" style="cursor:pointer">
      <td style="white-space:nowrap;font-family:var(--mono);font-size:11px">${time}</td>
      <td><span class="audit-category-badge ${catClass}">${e.category}</span></td>
      <td style="font-family:var(--mono);font-size:11px">${e.event}</td>
      <td>${e.message || '—'}</td>
      <td style="font-family:var(--mono);font-size:11px">${e.account || '—'}</td>
      <td class="${resultClass}">${resultLabel}</td>
    </tr>`;
  }).join('');

  // Row click → show detail drawer
  tbody.querySelectorAll('tr[data-id]').forEach(row => {
    row.addEventListener('click', () => {
      const entry = _auditEntries.find(e => e.id === row.dataset.id);
      if (!entry) return;
      document.getElementById('audit-detail-event').textContent = `${entry.event} — ${entry.message}`;
      document.getElementById('audit-detail-body').textContent = JSON.stringify(entry, null, 2);
      document.getElementById('audit-detail').classList.remove('hidden');
    });
  });
}

function downloadText(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
