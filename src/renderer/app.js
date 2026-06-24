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
  initSidebarDnd();  // must run after loadFeatures so all nav items exist

  // Resume session if credentials are already active
  const existingSession = await window.aws.getSession();
  if (existingSession) {
    session = existingSession;
    onAuthenticated(session);
  }

  startUTCClock();
  if (existingSession?.expiration) {
    window._setSessionExpiration(existingSession.expiration);
  }
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
  initSessionExpiryOverlay();
});

/* ── AWS Health indicator ────────────────────────────────────────────────── */
const HEALTH_POLL_MS = 10 * 60 * 1000; // match main-process interval

/* ── Health indicator ────────────────────────────────────────────────────── */
let _dismissedHealthFp = null; // fingerprint of dismissed event set
let _lastHealthData    = null; // cached for tooltip render

function _healthFingerprint(events) {
  if (!events || !events.length) return '';
  return events.map(e => `${e.service}|${e.summary}|${e.region||''}`).sort().join(';;');
}

function bindHealthTooltip() {
  const wrap    = document.getElementById('health-dot-wrap');
  const tooltip = document.getElementById('health-tooltip');
  const dot     = document.getElementById('health-dot');
  if (!wrap || !tooltip) return;

  let _pinned    = false; // true when clicked open
  let _hideTimer = null;

  function scheduleHide() {
    clearTimeout(_hideTimer);
    _hideTimer = setTimeout(() => { if (!_pinned) hideTooltip(); }, 200);
  }

  function cancelHide() {
    clearTimeout(_hideTimer);
    _hideTimer = null;
  }

  function showTooltip() {
    renderHealthTooltip();
    const rect = wrap.getBoundingClientRect();
    tooltip.style.left    = (rect.right + 10) + 'px';
    tooltip.style.top     = Math.max(8, rect.top - 4) + 'px';
    tooltip.style.display = 'block';
  }

  function hideTooltip() {
    tooltip.style.display = 'none';
    _pinned = false;
  }

  // Click dot: pin open / unpin
  wrap.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_pinned) {
      hideTooltip();
    } else {
      cancelHide();
      showTooltip();
      _pinned = true;
    }
  });

  // Hover: show/hide with delay so cursor can reach the tooltip
  wrap.addEventListener('mouseenter', () => { cancelHide(); showTooltip(); });
  wrap.addEventListener('mouseleave', () => { if (!_pinned) scheduleHide(); });
  tooltip.addEventListener('mouseenter', () => cancelHide());
  tooltip.addEventListener('mouseleave', () => { if (!_pinned) scheduleHide(); });

  // Click outside unpins and closes
  document.addEventListener('click', (e) => {
    if (_pinned && !wrap.contains(e.target) && !tooltip.contains(e.target)) {
      hideTooltip();
    }
  });

  window._refreshHealthTooltip = () => {
    if (tooltip.style.display !== 'none') renderHealthTooltip();
  };
}

function renderHealthTooltip() {
  const tooltip = document.getElementById('health-tooltip');
  const dot     = document.getElementById('health-dot');
  if (!tooltip) return;

  const data   = _lastHealthData;
  if (!data) { tooltip.textContent = 'Loading…'; return; }

  const trueStatus = data.status || 'unknown';
  const fp         = _healthFingerprint(data.events);
  const dismissed  = trueStatus !== 'green' && fp && fp === _dismissedHealthFp;
  const visStatus  = dismissed ? 'green' : trueStatus;

  // Update dot
  if (dot) dot.className = `health-${visStatus}`;

  // Clear and rebuild tooltip HTML
  tooltip.innerHTML = '';

  const header = document.createElement('div');
  header.style.cssText = 'font-weight:600;margin-bottom:8px;font-size:12px;';

  if (visStatus === 'green') {
    header.textContent = dismissed
      ? '✓ Alerts dismissed — AWS services may still have events'
      : '✓ All AWS services operational';
  } else if (visStatus === 'yellow' || visStatus === 'red') {
    header.textContent = `AWS Health: ${visStatus.toUpperCase()} — ${(data.events||[]).length} active event(s)`;
  } else {
    header.textContent = 'AWS health unknown';
  }
  tooltip.appendChild(header);

  // Events list
  if ((trueStatus === 'yellow' || trueStatus === 'red') && (data.events||[]).length) {
    const icon = trueStatus === 'red' ? '✗' : '⚠';
    const list = document.createElement('div');
    list.style.cssText = 'margin-bottom:8px;';
    data.events.slice(0, 5).forEach(e => {
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom:4px;font-size:11px;color:var(--text-secondary);';
      row.textContent = `${icon} ${e.region ? e.region + ' — ' : ''}${e.service}: ${e.summary}`;
      list.appendChild(row);
    });
    tooltip.appendChild(list);
  }

  // Error
  if (trueStatus === 'unknown' && data.error) {
    const err = document.createElement('div');
    err.style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:8px;';
    err.textContent = data.error;
    tooltip.appendChild(err);
  }

  // Footer row: last checked + dismiss button
  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;';

  const checked = document.createElement('span');
  checked.style.cssText = 'font-size:10px;color:var(--text-muted);';
  checked.textContent = `Last checked: ${fmtTime(data.lastChecked)}`;
  footer.appendChild(checked);

  if ((trueStatus === 'yellow' || trueStatus === 'red') && !dismissed) {
    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.style.cssText = 'font-size:10px;padding:2px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text-secondary);cursor:pointer;';
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _dismissedHealthFp = fp;
      if (dot) dot.className = 'health-green';
      renderHealthTooltip();
    });
    footer.appendChild(dismissBtn);
  } else if (dismissed) {
    const undoBtn = document.createElement('button');
    undoBtn.textContent = 'Restore';
    undoBtn.style.cssText = 'font-size:10px;padding:2px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text-secondary);cursor:pointer;';
    undoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _dismissedHealthFp = null;
      if (dot) dot.className = `health-${trueStatus}`;
      renderHealthTooltip();
    });
    footer.appendChild(undoBtn);
  }

  tooltip.appendChild(footer);
}

function startHealthPolling() {
  // First call is likely too early — main process fetch takes a few seconds.
  // Check at 0s, 8s (fetch done by then), then every 10 minutes.
  updateHealthDot();
  setTimeout(updateHealthDot, 8000);
  setInterval(updateHealthDot, HEALTH_POLL_MS);
}

async function updateHealthDot() {
  const dot = document.getElementById('health-dot');
  if (!dot) return;

  const data = await window.aws.healthGetStatus();
  _lastHealthData = data;

  const trueStatus = data.status || 'unknown';
  const fp         = _healthFingerprint(data.events);

  // If new events differ from dismissed set, clear the dismissal
  if (trueStatus !== 'green' && fp !== _dismissedHealthFp) {
    _dismissedHealthFp = null;
  }

  const visStatus = (_dismissedHealthFp && trueStatus !== 'green') ? 'green' : trueStatus;
  dot.className = `health-${visStatus}`;

  if (window._refreshHealthTooltip) window._refreshHealthTooltip();
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toUTCString();
}

/* ── Import error toast ──────────────────────────────────────────────────── */
function showImportError(message) {
  let toast = document.getElementById('import-error-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'import-error-toast';
    toast.style.cssText = [
      'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
      'background:#2a1a1a', 'border:1px solid var(--error)', 'color:var(--error)',
      'border-radius:6px', 'padding:10px 16px', 'font-size:12px', 'max-width:420px',
      'z-index:99999', 'box-shadow:0 4px 16px rgba(0,0,0,0.5)', 'line-height:1.5',
      'text-align:center',
    ].join(';');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.display = 'block';
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => { toast.style.display = 'none'; }, 6000);
}

/* ── UTC Clock ───────────────────────────────────────────────────────────── */
function startUTCClock() {
  const dateEl      = document.getElementById('utc-date');
  const timeEl      = document.getElementById('utc-time');
  const ttlWrap     = document.getElementById('session-ttl-wrap');
  const ttlEl       = document.getElementById('session-ttl');
  const refreshBtn  = document.getElementById('session-refresh-btn');

  let _sessionExpiration  = null; // ISO string
  let _sessionStartedAt   = null; // Date.now() when session began
  let _autoRefreshEnabled = false;
  let _autoRefreshMs      = 0;    // max total auto-refresh window in ms
  let _refreshing         = false;

  async function doRefresh() {
    if (_refreshing) return;
    _refreshing = true;
    if (refreshBtn) { refreshBtn.textContent = '…'; refreshBtn.disabled = true; }
    try {
      const result = await window.aws.refreshSession();
      if (result?.ok !== false) {
        const fresh = await window.aws.getSession();
        if (fresh?.expiration) window._setSessionExpiration(fresh.expiration);
        const s = fresh || {};
        // Update identity badge fields without re-running full onAuthenticated
        if (s.accountId) document.getElementById('identity-account').textContent = `Account: ${s.accountId}`;
      }
    } catch (e) {
      // silently ignore — expiry overlay will catch it if creds are really gone
    } finally {
      _refreshing = false;
      if (refreshBtn) { refreshBtn.textContent = '↻'; refreshBtn.disabled = false; }
    }
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => doRefresh());
  }

  let _clockOffsetMs = 0; // difference between trusted server time and Date.now()

  // Fetch authoritative time once on startup and compute offset
  window.aws.invoke('util:get-server-time').then(result => {
    if (!result.ok || !result.serverMs) return;
    // Account for the round-trip: use midpoint between request sent and response received
    const roundTripMs = Date.now() - result.localMs;
    _clockOffsetMs = result.serverMs - result.localMs + Math.round(roundTripMs / 2);

    const driftSec = Math.round(Math.abs(_clockOffsetMs) / 1000);
    const driftEl  = document.getElementById('utc-drift-warn');
    if (driftSec >= 5 && driftEl) {
      driftEl.textContent = `⚠ System clock is ${driftSec}s ${_clockOffsetMs > 0 ? 'behind' : 'ahead'}`;
      driftEl.classList.remove('hidden');
    }
    tick(); // re-render immediately with corrected time
  }).catch(() => {}); // network unavailable — fall back to system clock silently

  function now() { return new Date(Date.now() + _clockOffsetMs); }

  function tick() {
    const n = now();
    dateEl.textContent = n.toISOString().slice(0, 10);
    timeEl.textContent = n.toISOString().slice(11, 19);

    if (_sessionExpiration) {
      const msLeft = new Date(_sessionExpiration).getTime() - n.getTime();
      if (msLeft <= 0) {
        ttlEl.textContent = 'Expired';
        ttlWrap.className = 'session-ttl-expired';
      } else {
        const totalMin = Math.floor(msLeft / 60000);
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        ttlEl.textContent = h > 0
          ? `${h}h ${String(m).padStart(2,'0')}m`
          : `${m}m`;
        if (msLeft < 2 * 60 * 1000) {
          ttlWrap.className = 'session-ttl-danger';
          // Auto-refresh: fire when < 2 min left if within the allowed window
          if (_autoRefreshEnabled && _sessionStartedAt) {
            const totalElapsed = (Date.now() + _clockOffsetMs) - _sessionStartedAt;
            if (totalElapsed < _autoRefreshMs) {
              doRefresh();
            }
          }
        } else if (msLeft < 10 * 60 * 1000) {
          ttlWrap.className = 'session-ttl-warning';
        } else {
          ttlWrap.className = 'session-ttl-ok';
        }
      }
    }
  }

  tick();
  setInterval(tick, 1000);

  // Called after login or session restore to start the countdown
  window._setSessionExpiration = function(isoOrNull) {
    _sessionExpiration = isoOrNull || null;
    if (_sessionExpiration && !_sessionStartedAt) {
      _sessionStartedAt = Date.now() + _clockOffsetMs;
    }
    if (_sessionExpiration) {
      ttlWrap.classList.remove('hidden');
    } else {
      ttlWrap.classList.add('hidden');
      _sessionStartedAt = null;
    }
    tick();
  };

  // Called from bindSettings to keep auto-refresh config in sync
  window._setAutoRefresh = function(enabled, hours) {
    _autoRefreshEnabled = enabled;
    _autoRefreshMs      = (hours || 0) * 3600 * 1000;
  };
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
  if (el) el.textContent = `v${window.aws.getAppVersion ? window.aws.getAppVersion() : ''}`.trim();

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
async function onAuthenticated(s) {
  // Refresh session to get expiration (not present on initial login result)
  const fullSession = await window.aws.getSession();
  if (window._setSessionExpiration) {
    window._setSessionExpiration(fullSession?.expiration ?? null);
  }

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

  // Fetch and display current month cost, then refresh every 20 minutes
  loadCurrentCost();
  if (window._costRefreshInterval) clearInterval(window._costRefreshInterval);
  window._costRefreshInterval = setInterval(loadCurrentCost, 20 * 60 * 1000);

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
  if (window._costRefreshInterval) {
    clearInterval(window._costRefreshInterval);
    window._costRefreshInterval = null;
  }
  if (window._setSessionExpiration) window._setSessionExpiration(null);
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

/* ── Sidebar drag-and-drop ───────────────────────────────────────────────── */

const NAV_ORDER_KEY  = 'maws-nav-order';
const NAV_LOCKED_KEY = 'maws-nav-locked';

const DEFAULT_NAV_ORDER = [
  'auth',
  'home',
  'console',
  'cloudshell',
  'feature-arn-scratchpad',
  'feature-ip-scratchpad',
  'feature-script-runner',
  'feature-cfn-templates',
  'feature-resource-lister',
  'feature-route53',
  'feature-timestamp-converter',
];

function initSidebarDnd() {
  const navList = document.getElementById('nav-list');
  const lockBtn = document.getElementById('nav-lock-btn');
  let draggedEl = null;

  // Default: locked. Only unlock if user has explicitly unlocked before.
  const savedLocked = localStorage.getItem(NAV_LOCKED_KEY);
  let locked = savedLocked === null ? true : savedLocked === 'true';

  function setLocked(val) {
    locked = val;
    localStorage.setItem(NAV_LOCKED_KEY, String(locked));
    lockBtn.textContent = locked ? '🔒' : '🔓';
    lockBtn.title       = locked ? 'Unlock to reorder workspace items' : 'Lock order';
    navList.classList.toggle('nav-unlocked', !locked);
    navList.querySelectorAll('.nav-item').forEach(el => {
      el.draggable = !locked;
    });
  }

  lockBtn.addEventListener('click', () => setLocked(!locked));

  // ── Drag events ───────────────────────────────────────────────────────────

  navList.addEventListener('dragstart', e => {
    draggedEl = e.target.closest('.nav-item');
    if (!draggedEl) return;
    e.dataTransfer.effectAllowed = 'move';
    // Delay adding class so the drag image captures the un-dimmed version
    requestAnimationFrame(() => draggedEl.classList.add('nav-dragging'));
  });

  navList.addEventListener('dragover', e => {
    e.preventDefault();
    if (!draggedEl) return;
    const target = e.target.closest('.nav-item');
    if (!target || target === draggedEl) return;

    const rect = target.getBoundingClientRect();
    const insertBefore = e.clientY < rect.top + rect.height / 2;
    navList.insertBefore(draggedEl, insertBefore ? target : target.nextSibling);
  });

  navList.addEventListener('dragend', () => {
    if (draggedEl) draggedEl.classList.remove('nav-dragging');
    draggedEl = null;
    saveNavOrder();
  });

  // Apply saved order, then apply lock state (which sets draggable attr)
  applySavedNavOrder(navList);
  setLocked(locked);
}

function saveNavOrder() {
  const navList = document.getElementById('nav-list');
  const order = [...navList.querySelectorAll('.nav-item')].map(el => el.dataset.view);
  localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(order));
}

function applySavedNavOrder(navList) {
  const saved = localStorage.getItem(NAV_ORDER_KEY);
  const order = saved ? (() => { try { return JSON.parse(saved); } catch { return null; } })() : DEFAULT_NAV_ORDER;
  if (!order) return;
  // Re-append items in order; items not in the list (e.g. new features added
  // after the order was saved) remain at their natural insertion position.
  for (const viewId of order) {
    const el = navList.querySelector(`.nav-item[data-view="${viewId}"]`);
    if (el) navList.appendChild(el);
  }
}

function buildFeatureView(feature) {
  if (feature.id === 'resource-lister') {
    return `
      <div class="view-header">
        <h2>${feature.icon} ${feature.name}</h2>
      </div>
      <div class="feature-toolbar" style="flex-wrap:wrap;gap:6px;">
        <button class="btn btn-sm rl-type-btn active" data-type="s3">🪣 S3</button>
        <button class="btn btn-sm rl-type-btn" data-type="ec2">🖥 EC2</button>
        <button class="btn btn-sm rl-type-btn" data-type="rds">🗄 RDS</button>
        <button class="btn btn-sm rl-type-btn" data-type="albs">⚖️ ALBs</button>
        <button class="btn btn-sm rl-type-btn" data-type="asg">📈 Auto Scaling</button>
        <button class="btn btn-sm rl-type-btn" data-type="cloudfront">☁️ CloudFront</button>
        <button class="btn btn-sm rl-type-btn" data-type="dynamodb">🗃 DynamoDB</button>
        <button class="btn btn-sm rl-type-btn" data-type="sns">📣 SNS</button>
        <button class="btn btn-sm rl-type-btn" data-type="iam-roles">🧑‍💼 IAM Roles</button>
        <button class="btn btn-sm rl-type-btn" data-type="security-groups">🔒 Security Groups</button>
        <button class="btn btn-sm rl-type-btn" data-type="vpcs">🌐 VPCs</button>
        <button class="btn btn-sm rl-type-btn" data-type="acm">📜 ACM Certs</button>
        <span style="flex:1"></span>
        <span id="resource-lister-count" style="color:var(--text-muted);font-size:12px;align-self:center;"></span>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;">
        <table class="feature-table">
          <thead>
            <tr>
              <th>Name / ID</th>
              <th>Details</th>
              <th style="width:180px">Actions</th>
            </tr>
          </thead>
          <tbody id="resource-lister-tbody">
            <tr><td colspan="3" style="color:var(--text-muted)">Select a resource type above.</td></tr>
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

  if (feature.id === 'ip-scratchpad') {
    return `
      <div class="view-header" style="display:flex;align-items:center;justify-content:space-between;">
        <h2>🌐 IP Scratchpad</h2>
        <span id="ip-count" style="font-size:11px;color:var(--text-muted)"></span>
      </div>

      <div id="ip-add-form">
        <div id="ip-add-inputs">
          <input id="ip-input" type="text" placeholder="192.168.1.1  or  10.0.0.0/24  — paste an IP" spellcheck="false" autocomplete="off" />
          <input id="ip-label-input" type="text" placeholder="Label (optional)" />
          <button id="ip-add-btn" class="btn btn-primary btn-sm">Add</button>
        </div>
        <div id="ip-add-error" class="hidden" style="color:var(--error);font-size:11px;margin-top:5px;"></div>
      </div>

      <div id="ip-list"></div>
    `;
  }

  if (feature.id === 'route53') {
    return `
      <div class="view-header">
        <h2>${feature.icon} ${feature.name}</h2>
      </div>
      <div id="r53-layout">
        <div id="r53-zones-panel">
          <div class="r53-panel-header">
            <span>Hosted Zones</span>
            <button class="btn btn-sm" id="r53-refresh-zones">Refresh</button>
          </div>
          <div id="r53-zones-list"><div class="r53-empty">Click Refresh to load zones.</div></div>
        </div>
        <div id="r53-records-panel">
          <div class="r53-panel-header">
            <span id="r53-zone-title" style="color:var(--text-muted)">Select a zone</span>
            <span id="r53-record-count" style="font-size:11px;color:var(--text-muted)"></span>
          </div>
          <div id="r53-records-list"><div class="r53-empty">Select a hosted zone to view its records.</div></div>
        </div>
      </div>
    `;
  }

  if (feature.id === 'timestamp-converter') {
    return `
      <div class="view-header">
        <h2>${feature.icon} ${feature.name}</h2>
      </div>
      <div id="ts-converter">
        <div id="ts-input-row">
          <input id="ts-input" type="text" placeholder="2024-08-22T03:53:07.298Z  or  1724291587" spellcheck="false" autocomplete="off" />
          <button class="btn btn-sm" id="ts-clear">Clear</button>
          <button class="btn btn-sm" id="ts-now">Now</button>
        </div>
        <div id="ts-error" class="hidden"></div>
        <div id="ts-results" class="hidden">
          <div class="ts-row" id="ts-row-local">
            <span class="ts-label">Local Time</span>
            <span class="ts-value" id="ts-local"></span>
            <button class="ts-copy-btn">Copy</button>
          </div>
          <div class="ts-row" id="ts-row-utc">
            <span class="ts-label">UTC</span>
            <span class="ts-value" id="ts-utc"></span>
            <button class="ts-copy-btn">Copy</button>
          </div>
          <div class="ts-row" id="ts-row-iso">
            <span class="ts-label">ISO 8601</span>
            <span class="ts-value" id="ts-iso"></span>
            <button class="ts-copy-btn">Copy</button>
          </div>
          <div class="ts-row" id="ts-row-unix">
            <span class="ts-label">Unix (seconds)</span>
            <span class="ts-value" id="ts-unix"></span>
            <button class="ts-copy-btn">Copy</button>
          </div>
          <div class="ts-row" id="ts-row-unix-ms">
            <span class="ts-label">Unix (ms)</span>
            <span class="ts-value" id="ts-unix-ms"></span>
            <button class="ts-copy-btn">Copy</button>
          </div>
          <div class="ts-row" id="ts-row-relative">
            <span class="ts-label">Relative</span>
            <span class="ts-value" id="ts-relative"></span>
          </div>
          <div class="ts-row" id="ts-row-tz">
            <span class="ts-label">Timezone</span>
            <span class="ts-value" id="ts-tz"></span>
          </div>
        </div>
      </div>
    `;
  }

  if (feature.id === 'script-runner') {
    return `
      <div class="view-header" style="display:flex;align-items:center;justify-content:space-between;">
        <h2>⚡ Script Runner</h2>
        <div style="display:flex;gap:6px;">
          <button id="sr-import-file-btn" class="btn btn-sm btn-secondary">⬆ Import</button>
          <button id="sr-new-btn" class="btn btn-sm btn-secondary">＋ New Script</button>
        </div>
      </div>

      <div id="sr-layout">
        <!-- Left: script list -->
        <div id="sr-list-panel">
          <div id="sr-list-controls">
            <input id="sr-search" type="text" placeholder="Search scripts…" autocomplete="off" spellcheck="false" />
            <select id="sr-category-filter">
              <option value="">All categories</option>
              <option value="favorites">⭐ Favorites</option>
              <option value="security">Security</option>
              <option value="cost-optimization">Cost Optimization</option>
              <option value="iam">IAM</option>
              <option value="operations">Operations</option>
              <option value="danger">Danger</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div id="sr-favorites-section" style="margin-bottom:12px;display:none;">
            <div class="sr-list-section-label">FAVORITES</div>
            <div id="sr-favorites-list"></div>
          </div>
          <div id="sr-prebaked-section">
            <div class="sr-list-section-label">PREBAKED</div>
            <div id="sr-prebaked-list"></div>
          </div>
          <div id="sr-custom-section" style="margin-top:12px">
            <div class="sr-list-section-label">CUSTOM</div>
            <div id="sr-custom-list"></div>
          </div>
        </div>

        <!-- Right: detail / run panel -->
        <div id="sr-detail-panel">
          <div id="sr-detail-empty" style="color:var(--text-muted);margin:auto;text-align:center;">
            <div style="font-size:36px;margin-bottom:12px">⚡</div>
            <div>Select a script from the list</div>
          </div>
          <div id="sr-detail-content" class="hidden">
            <div id="sr-detail-header">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span id="sr-detail-name" style="font-size:16px;font-weight:600;color:var(--text-primary)"></span>
                <span id="sr-detail-category-badge" class="sr-cat-badge"></span>
                <span id="sr-detail-danger-badge" class="sr-danger-badge hidden">⚠ DANGER</span>
              </div>
              <p id="sr-detail-description" style="margin-top:8px;font-size:12px;color:var(--text-secondary);line-height:1.6;"></p>
            </div>

            <div style="margin-top:16px;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                <span style="font-size:11px;font-weight:600;color:var(--text-muted);letter-spacing:0.5px;text-transform:uppercase;">Script Body</span>
                <span id="sr-readonly-hint" style="font-size:10px;color:var(--text-muted)">Prebaked script — view only. Run it as-is or copy to a custom script to edit.</span>
              </div>
              <textarea id="sr-script-body" class="sr-script-body" spellcheck="false"></textarea>
            </div>

            <div id="sr-custom-actions" class="hidden" style="display:flex;gap:8px;margin-top:8px;align-items:center;">
              <button id="sr-save-btn" class="btn btn-sm btn-secondary">Save Changes</button>
              <button id="sr-import-btn" class="btn btn-sm btn-secondary">⬆ Import File</button>
              <button id="sr-delete-btn" class="btn btn-sm" style="color:var(--error);border-color:rgba(255,107,107,0.3);background:rgba(255,107,107,0.05);">Delete Script</button>
              <button id="sr-versions-btn" class="btn btn-sm btn-secondary" style="margin-left:auto;">📋 History</button>
            </div>

            <div id="sr-run-section" style="margin-top:20px;border-top:1px solid var(--border);padding-top:16px;">
              <div id="sr-region-row" style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
                <label style="font-size:11px;font-weight:600;color:var(--text-secondary);white-space:nowrap;">Target Region</label>
                <input id="sr-region-input" type="text" placeholder="e.g. us-east-1" spellcheck="false"
                  style="background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:var(--radius);padding:6px 10px;font-size:12px;font-family:var(--mono);outline:none;width:200px;" />
                <span id="sr-all-regions-note" class="hidden" style="font-size:12px;color:var(--text-muted);font-style:italic;">Runs across all active regions</span>
              </div>
              <button id="sr-run-btn" class="btn btn-primary btn-sm" style="min-width:160px;">▶ Run Script</button>
            </div>

            <!-- Output -->
            <div id="sr-output-wrap" class="hidden" style="margin-top:20px;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                <span style="font-size:11px;font-weight:600;color:var(--text-muted);letter-spacing:0.5px;text-transform:uppercase;">Output</span>
                <button id="sr-clear-output-btn" class="btn btn-sm" style="font-size:11px;padding:2px 8px;">Clear</button>
              </div>
              <div id="sr-output" class="sr-output"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- New / Edit custom script modal -->
      <div id="sr-new-modal" class="sr-modal-overlay hidden">
        <div class="sr-modal-box">
          <div class="sr-modal-header">
            <span id="sr-new-modal-title" style="font-weight:600;font-size:14px;">New Custom Script</span>
            <button id="sr-new-modal-close" class="sr-modal-close">✕</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:12px;padding:16px;">
            <div>
              <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:5px;">Script Name <span style="color:var(--error)">*</span></label>
              <input id="sr-new-name" type="text" placeholder="e.g. Rotate old EC2 snapshots" style="width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:var(--radius);padding:8px 10px;font-size:13px;outline:none;" />
            </div>
            <div>
              <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:5px;">Description</label>
              <input id="sr-new-desc" type="text" placeholder="Optional one-liner" style="width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:var(--radius);padding:8px 10px;font-size:13px;outline:none;" />
            </div>
            <div style="display:flex;gap:10px;">
              <div style="flex:1;">
                <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:5px;">Category</label>
                <select id="sr-new-category" style="width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:var(--radius);padding:7px 10px;font-size:13px;outline:none;">
                  <option value="custom">Custom</option>
                  <option value="security">Security</option>
                  <option value="cost-optimization">Cost Optimization</option>
                  <option value="operations">Operations</option>
                  <option value="iam">IAM</option>
                </select>
              </div>
              <div style="display:flex;align-items:flex-end;padding-bottom:2px;">
                <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-primary);cursor:pointer;white-space:nowrap;">
                  <input id="sr-new-danger" type="checkbox" style="accent-color:var(--error);width:14px;height:14px;" />
                  <span>Mark as dangerous</span>
                </label>
              </div>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:5px;">Script Body (shell script)</label>
              <textarea id="sr-new-body" class="sr-script-body" placeholder="#!/bin/bash&#10;# AWS credentials are injected automatically as env vars:&#10;# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_DEFAULT_REGION&#10;&#10;aws s3 ls" style="height:200px;"></textarea>
            </div>
            <div id="sr-new-error" class="hidden" style="color:var(--error);font-size:12px;"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
              <button id="sr-new-cancel" class="btn btn-sm btn-secondary">Cancel</button>
              <button id="sr-new-save" class="btn btn-sm btn-primary">Save Script</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Auth gate modal -->
      <div id="sr-auth-modal" class="sr-modal-overlay hidden">
        <div class="sr-modal-box" style="max-width:340px;text-align:center;">
          <div style="padding:24px 24px 8px;">
            <div style="font-size:40px;margin-bottom:10px;" id="sr-auth-icon">🔐</div>
            <div style="font-size:15px;font-weight:600;margin-bottom:6px;">Authenticate to Run Script</div>
            <div id="sr-auth-subtitle" style="font-size:12px;color:var(--text-muted);margin-bottom:18px;line-height:1.6;">
              Verify your identity before executing.
            </div>

            <!-- Not configured state -->
            <div id="sr-auth-not-configured" class="hidden">
              <div class="error-box" style="text-align:left;margin-bottom:14px;">
                ⚠ Authentication is not configured.<br><br>
                To run scripts, enable Touch ID or Password in
                <strong><span class="sr-settings-link" style="color:var(--accent);cursor:pointer;">Settings → Security</span></strong>.
              </div>
              <button id="sr-auth-go-settings" class="btn btn-sm btn-secondary" style="width:100%;">Go to Settings</button>
            </div>

            <!-- Touch ID state -->
            <div id="sr-auth-touchid-wrap" class="hidden">
              <button id="sr-auth-touchid-btn" class="btn btn-primary" style="width:100%;margin-bottom:10px;">
                👆 Use Touch ID
              </button>
              <button id="sr-auth-switch-pw" class="btn btn-sm btn-secondary" style="width:100%;font-size:11px;">Use Password Instead</button>
            </div>

            <!-- Password state -->
            <div id="sr-auth-pw-wrap" class="hidden" style="display:flex;flex-direction:column;gap:8px;">
              <input id="sr-auth-pw-input" type="password" placeholder="Enter password"
                style="width:100%;padding:9px 12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:13px;text-align:center;outline:none;" />
              <button id="sr-auth-pw-submit" class="btn btn-primary btn-sm" style="width:100%;">Unlock</button>
            </div>

            <div id="sr-auth-error" class="hidden" style="color:var(--error);font-size:12px;margin-top:10px;"></div>
          </div>
          <div style="border-top:1px solid var(--border);padding:12px 24px;display:flex;justify-content:center;">
            <button id="sr-auth-cancel" class="btn btn-sm btn-secondary">Cancel</button>
          </div>
        </div>
      </div>

      <!-- Confirm & run modal -->
      <div id="sr-confirm-modal" class="sr-modal-overlay hidden">
        <div class="sr-modal-box" style="max-width:400px;">
          <div class="sr-modal-header">
            <span style="font-weight:600;font-size:14px;">Confirm Execution</span>
            <button id="sr-confirm-close" class="sr-modal-close">✕</button>
          </div>
          <div style="padding:16px;">
            <div id="sr-confirm-danger-warn" class="hidden" style="background:rgba(255,59,48,0.1);border:1px solid rgba(255,59,48,0.3);border-radius:var(--radius);padding:10px 14px;margin-bottom:14px;color:#ff3b30;font-size:12px;line-height:1.6;">
              ⚠ <strong>This is a DANGER script.</strong> The action may be <strong>irreversible</strong>. Double-check your target account before continuing.
            </div>
            <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;margin-bottom:14px;font-size:12px;line-height:1.8;">
              <div><span style="color:var(--text-muted)">Script:</span> <strong id="sr-confirm-name"></strong></div>
              <div><span style="color:var(--text-muted)">Account:</span> <span id="sr-confirm-account" style="font-family:var(--mono)"></span></div>
              <div><span style="color:var(--text-muted)">Region:</span> <span id="sr-confirm-region" style="font-family:var(--mono)"></span></div>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
              <button id="sr-confirm-cancel-btn" class="btn btn-sm btn-secondary">Cancel</button>
              <button id="sr-confirm-run-btn" class="btn btn-sm btn-primary">Yes, Run It</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Script parameters modal (for prebaked scripts with interactive inputs) -->
      <div id="sr-params-modal" class="sr-modal-overlay hidden">
        <div class="sr-modal-box" style="max-width:420px;">
          <div class="sr-modal-header">
            <span id="sr-params-modal-title" style="font-weight:600;font-size:14px;">Script Parameters</span>
            <button id="sr-params-modal-close" class="sr-modal-close">✕</button>
          </div>
          <div id="sr-params-fields" style="padding:16px;display:flex;flex-direction:column;gap:12px;max-height:420px;overflow-y:auto;"></div>
          <div id="sr-params-error" class="hidden" style="padding:0 16px 8px;color:var(--error);font-size:12px;"></div>
          <div style="border-top:1px solid var(--border);padding:12px 16px;display:flex;gap:8px;justify-content:flex-end;">
            <button id="sr-params-cancel-btn" class="btn btn-sm btn-secondary">Cancel</button>
            <button id="sr-params-continue-btn" class="btn btn-sm btn-primary">Continue →</button>
          </div>
        </div>
      </div>

      <!-- Version history modal -->
      <div id="sr-versions-modal" class="sr-modal-overlay hidden">
        <div class="sr-modal-box" style="max-width:600px;max-height:520px;display:flex;flex-direction:column;">
          <div class="sr-modal-header">
            <span style="font-weight:600;font-size:14px;">Version History</span>
            <button id="sr-versions-modal-close" class="sr-modal-close">✕</button>
          </div>
          <div style="border-bottom:1px solid var(--border);padding:10px 14px;display:flex;gap:8px;align-items:center;">
            <input id="sr-version-label-input" type="text" placeholder="Label for snapshot (optional)"
              style="flex:1;background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:var(--radius);padding:6px 10px;font-size:12px;outline:none;" />
            <button id="sr-version-snapshot-btn" class="btn btn-sm btn-secondary">+ Save Snapshot</button>
          </div>
          <div style="display:flex;flex:1;overflow:hidden;min-height:0;">
            <div id="sr-versions-list" style="width:210px;flex-shrink:0;border-right:1px solid var(--border);overflow-y:auto;padding:6px 0;">
              <div style="color:var(--text-muted);font-size:12px;padding:16px;text-align:center;">No versions saved yet.</div>
            </div>
            <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;padding:12px;">
              <div id="sr-version-preview-empty" style="margin:auto;text-align:center;color:var(--text-muted);font-size:12px;">Select a version to preview</div>
              <div id="sr-version-preview-content" class="hidden" style="display:flex;flex-direction:column;flex:1;gap:8px;">
                <textarea id="sr-version-preview-body" class="sr-script-body" style="flex:1;min-height:120px;resize:none;" readonly></textarea>
                <div style="display:flex;gap:6px;flex-shrink:0;">
                  <button id="sr-version-revert-btn" class="btn btn-sm btn-primary">↩ Revert to This</button>
                  <button id="sr-version-default-btn" class="btn btn-sm btn-secondary">★ Set Default</button>
                  <button id="sr-version-delete-btn" class="btn btn-sm" style="color:var(--error);border-color:rgba(255,107,107,0.3);background:rgba(255,107,107,0.05);margin-left:auto;">✕ Delete</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  if (feature.id === 'cfn-templates') {
    return `
      <div class="view-header" style="display:flex;align-items:center;justify-content:space-between;">
        <h2>📐 CFN Templates</h2>
        <div style="display:flex;gap:6px;">
          <button id="cfn-import-file-btn" class="btn btn-sm btn-secondary">⬆ Import</button>
          <button id="cfn-new-btn" class="btn btn-sm btn-secondary">＋ Add Template</button>
        </div>
      </div>

      <div id="cfn-layout">
        <!-- Left: template list -->
        <div id="cfn-list-panel">
          <div id="cfn-list-controls">
            <input id="cfn-search" type="text" placeholder="Search templates…" autocomplete="off" spellcheck="false" />
            <select id="cfn-category-filter">
              <option value="">All categories</option>
              <option value="favorites">⭐ Favorites</option>
              <option value="networking">Networking</option>
              <option value="security">Security</option>
              <option value="storage">Storage</option>
              <option value="compute">Compute</option>
              <option value="danger">Danger</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div id="cfn-favorites-section" style="margin-bottom:12px;display:none;">
            <div class="sr-list-section-label">FAVORITES</div>
            <div id="cfn-favorites-list"></div>
          </div>
          <div id="cfn-prebaked-section">
            <div class="sr-list-section-label">PREBAKED</div>
            <div id="cfn-prebaked-list"></div>
          </div>
          <div id="cfn-custom-section" style="margin-top:12px">
            <div class="sr-list-section-label">CUSTOM</div>
            <div id="cfn-custom-list"></div>
          </div>
        </div>

        <!-- Right: detail / deploy panel -->
        <div id="cfn-detail-panel">
          <div id="cfn-detail-empty" style="color:var(--text-muted);margin:auto;text-align:center;">
            <div style="font-size:36px;margin-bottom:12px">📐</div>
            <div>Select a template from the list</div>
          </div>
          <div id="cfn-detail-content" class="hidden">
            <div id="cfn-detail-header">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span id="cfn-detail-name" style="font-size:16px;font-weight:600;color:var(--text-primary)"></span>
                <span id="cfn-detail-category-badge" class="sr-cat-badge"></span>
                <span id="cfn-detail-danger-badge" class="sr-danger-badge hidden">⚠ DANGER</span>
              </div>
              <p id="cfn-detail-description" style="margin-top:8px;font-size:12px;color:var(--text-secondary);line-height:1.6;"></p>
            </div>

            <div style="margin-top:16px;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                <span style="font-size:11px;font-weight:600;color:var(--text-muted);letter-spacing:0.5px;text-transform:uppercase;">Template Body (YAML)</span>
                <span id="cfn-readonly-hint" style="font-size:10px;color:var(--text-muted)">Prebaked template — view only.</span>
              </div>
              <textarea id="cfn-template-body" class="sr-script-body" spellcheck="false"></textarea>
            </div>

            <div id="cfn-custom-actions" class="hidden" style="display:flex;gap:8px;margin-top:8px;">
              <button id="cfn-save-btn" class="btn btn-sm btn-secondary">Save Changes</button>
              <button id="cfn-import-btn" class="btn btn-sm btn-secondary">⬆ Import File</button>
              <button id="cfn-delete-btn" class="btn btn-sm" style="color:var(--error);border-color:rgba(255,107,107,0.3);background:rgba(255,107,107,0.05);">Delete Template</button>
            </div>

            <div id="cfn-deploy-section" style="margin-top:20px;border-top:1px solid var(--border);padding-top:16px;">
              <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
                <label style="font-size:11px;font-weight:600;color:var(--text-secondary);white-space:nowrap;">Target Region</label>
                <input id="cfn-region-input" type="text" placeholder="e.g. us-east-1" spellcheck="false"
                  style="background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:var(--radius);padding:6px 10px;font-size:12px;font-family:var(--mono);outline:none;width:200px;" />
              </div>
              <button id="cfn-deploy-btn" class="btn btn-primary btn-sm" style="min-width:160px;">🚀 Deploy Stack</button>
            </div>

            <!-- Output -->
            <div id="cfn-output-wrap" class="hidden" style="margin-top:20px;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                <span style="font-size:11px;font-weight:600;color:var(--text-muted);letter-spacing:0.5px;text-transform:uppercase;">Output</span>
                <button id="cfn-clear-output-btn" class="btn btn-sm" style="font-size:11px;padding:2px 8px;">Clear</button>
              </div>
              <div id="cfn-output" class="sr-output"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Add / Edit custom template modal -->
      <div id="cfn-new-modal" class="sr-modal-overlay hidden">
        <div class="sr-modal-box">
          <div class="sr-modal-header">
            <span id="cfn-new-modal-title" style="font-weight:600;font-size:14px;">Add Custom Template</span>
            <button id="cfn-new-modal-close" class="sr-modal-close">✕</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:12px;padding:16px;">
            <div>
              <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:5px;">Template Name <span style="color:var(--error)">*</span></label>
              <input id="cfn-new-name" type="text" placeholder="e.g. My S3 Data Lake" style="width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:var(--radius);padding:8px 10px;font-size:13px;outline:none;" />
            </div>
            <div>
              <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:5px;">Description</label>
              <input id="cfn-new-desc" type="text" placeholder="Optional one-liner" style="width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:var(--radius);padding:8px 10px;font-size:13px;outline:none;" />
            </div>
            <div style="display:flex;gap:10px;">
              <div style="flex:1;">
                <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:5px;">Category</label>
                <select id="cfn-new-category" style="width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:var(--radius);padding:7px 10px;font-size:13px;outline:none;">
                  <option value="custom">Custom</option>
                  <option value="networking">Networking</option>
                  <option value="security">Security</option>
                  <option value="storage">Storage</option>
                  <option value="compute">Compute</option>
                </select>
              </div>
              <div style="display:flex;align-items:flex-end;padding-bottom:2px;">
                <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-primary);cursor:pointer;white-space:nowrap;">
                  <input id="cfn-new-danger" type="checkbox" style="accent-color:var(--error);width:14px;height:14px;" />
                  <span>Mark as dangerous</span>
                </label>
              </div>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:5px;">Template Body (CloudFormation YAML)</label>
              <textarea id="cfn-new-body" class="sr-script-body" placeholder="AWSTemplateFormatVersion: '2010-09-09'&#10;Description: My template" style="height:200px;"></textarea>
            </div>
            <div id="cfn-new-error" class="hidden" style="color:var(--error);font-size:12px;"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
              <button id="cfn-new-cancel" class="btn btn-sm btn-secondary">Cancel</button>
              <button id="cfn-new-save" class="btn btn-sm btn-primary">Save Template</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Auth gate modal -->
      <div id="cfn-auth-modal" class="sr-modal-overlay hidden">
        <div class="sr-modal-box" style="max-width:340px;text-align:center;">
          <div style="padding:24px 24px 8px;">
            <div style="font-size:40px;margin-bottom:10px;">🔐</div>
            <div style="font-size:15px;font-weight:600;margin-bottom:6px;">Authenticate to Deploy</div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:18px;line-height:1.6;">
              Verify your identity before deploying a CloudFormation stack.
            </div>
            <div id="cfn-auth-not-configured" class="hidden">
              <div class="error-box" style="text-align:left;margin-bottom:14px;">
                ⚠ Authentication is not configured.<br><br>
                Enable Touch ID or Password in
                <strong><span class="cfn-settings-link" style="color:var(--accent);cursor:pointer;">Settings → Security</span></strong>.
              </div>
              <button id="cfn-auth-go-settings" class="btn btn-sm btn-secondary" style="width:100%;">Go to Settings</button>
            </div>
            <div id="cfn-auth-touchid-wrap" class="hidden">
              <button id="cfn-auth-touchid-btn" class="btn btn-primary" style="width:100%;margin-bottom:10px;">👆 Use Touch ID</button>
              <button id="cfn-auth-switch-pw" class="btn btn-sm btn-secondary" style="width:100%;font-size:11px;">Use Password Instead</button>
            </div>
            <div id="cfn-auth-pw-wrap" class="hidden" style="display:flex;flex-direction:column;gap:8px;">
              <input id="cfn-auth-pw-input" type="password" placeholder="Enter password"
                style="width:100%;padding:9px 12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:13px;text-align:center;outline:none;" />
              <button id="cfn-auth-pw-submit" class="btn btn-primary btn-sm" style="width:100%;">Unlock</button>
            </div>
            <div id="cfn-auth-error" class="hidden" style="color:var(--error);font-size:12px;margin-top:10px;"></div>
          </div>
          <div style="border-top:1px solid var(--border);padding:12px 24px;display:flex;justify-content:center;">
            <button id="cfn-auth-cancel" class="btn btn-sm btn-secondary">Cancel</button>
          </div>
        </div>
      </div>

      <!-- Deploy confirm modal (stack name + template params + confirmation) -->
      <div id="cfn-deploy-modal" class="sr-modal-overlay hidden">
        <div class="sr-modal-box" style="max-width:460px;">
          <div class="sr-modal-header">
            <span style="font-weight:600;font-size:14px;">Deploy Stack</span>
            <button id="cfn-deploy-modal-close" class="sr-modal-close">✕</button>
          </div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:12px;">
            <div id="cfn-deploy-danger-warn" class="hidden" style="background:rgba(255,59,48,0.1);border:1px solid rgba(255,59,48,0.3);border-radius:var(--radius);padding:10px 14px;color:#ff3b30;font-size:12px;line-height:1.6;">
              ⚠ <strong>This is a DANGER template.</strong> The action may be <strong>irreversible</strong>. Double-check your target account before continuing.
            </div>
            <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;font-size:12px;line-height:1.8;">
              <div><span style="color:var(--text-muted)">Template:</span> <strong id="cfn-deploy-template-name"></strong></div>
              <div><span style="color:var(--text-muted)">Account:</span> <span id="cfn-deploy-account" style="font-family:var(--mono)"></span></div>
              <div><span style="color:var(--text-muted)">Region:</span> <span id="cfn-deploy-region-display" style="font-family:var(--mono)"></span></div>
            </div>
            <div>
              <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:5px;">Stack Name <span style="color:var(--error)">*</span></label>
              <input id="cfn-stack-name-input" type="text" placeholder="e.g. prod-vpc"
                style="width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:var(--radius);padding:7px 10px;font-size:13px;font-family:var(--mono);outline:none;" />
            </div>
            <div id="cfn-deploy-params"></div>
            <div id="cfn-deploy-error" class="hidden" style="color:var(--error);font-size:12px;"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
              <button id="cfn-deploy-cancel-btn" class="btn btn-sm btn-secondary">Cancel</button>
              <button id="cfn-deploy-confirm-btn" class="btn btn-sm btn-primary">🚀 Deploy</button>
            </div>
          </div>
        </div>
      </div>
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
    const RESOURCE_TYPES = {
      's3':              { label: 'S3 bucket',             ipc: 'resource-lister:list-s3' },
      'ec2':             { label: 'EC2 instance',          ipc: 'resource-lister:list-ec2' },
      'rds':             { label: 'RDS instance',          ipc: 'resource-lister:list-rds' },
      'albs':            { label: 'load balancer',         ipc: 'resource-lister:list-albs' },
      'asg':             { label: 'Auto Scaling group',    ipc: 'resource-lister:list-asg' },
      'cloudfront':      { label: 'CloudFront distribution', ipc: 'resource-lister:list-cloudfront' },
      'dynamodb':        { label: 'DynamoDB table',        ipc: 'resource-lister:list-dynamodb' },
      'sns':             { label: 'SNS topic',             ipc: 'resource-lister:list-sns' },
      'iam-roles':       { label: 'IAM role',              ipc: 'resource-lister:list-iam-roles' },
      'security-groups': { label: 'security group',        ipc: 'resource-lister:list-security-groups' },
      'vpcs':            { label: 'VPC',                   ipc: 'resource-lister:list-vpcs' },
      'acm':             { label: 'ACM certificate',       ipc: 'resource-lister:list-acm' },
    };

    let activeType = 's3';

    async function loadResourceType(type, attempt = 0) {
      activeType = type;
      const tbody = section.querySelector('#resource-lister-tbody');
      const count = section.querySelector('#resource-lister-count');
      tbody.innerHTML = '<tr><td colspan="3"><div class="spinner" style="margin:8px auto"></div></td></tr>';
      count.textContent = '';

      const { label, ipc } = RESOURCE_TYPES[type];
      const result = await window.aws.invoke(ipc);

      if (!result.ok) {
        // Auth not ready yet at startup — retry silently until session is restored
        if (result.error === 'Not authenticated' && attempt < 20) {
          setTimeout(() => loadResourceType(type, attempt + 1), 500);
          return;
        }
        tbody.innerHTML = `<tr><td colspan="3" style="color:var(--error)">${result.error}</td></tr>`;
        return;
      }
      if (!result.resources.length) {
        tbody.innerHTML = `<tr><td colspan="3" style="color:var(--text-muted)">No ${label}s found in this region.</td></tr>`;
        return;
      }

      count.textContent = `${result.resources.length} ${label}${result.resources.length !== 1 ? 's' : ''}`;
      tbody.innerHTML = result.resources.map((r) => `
        <tr>
          <td style="font-family:monospace;font-size:12px">${r.name}</td>
          <td style="color:var(--text-muted);font-size:12px">${r.meta}</td>
          <td>
            <div style="display:flex;gap:4px">
              <button class="btn btn-sm rl-copy-btn" data-arn="${r.arn}" title="${r.arn}">Copy ARN</button>
              <button class="btn btn-sm rl-scratchpad-btn" data-arn="${r.arn}" data-label="${r.name}">→ Scratchpad</button>
            </div>
          </td>
        </tr>
      `).join('');

      // Bind copy buttons
      tbody.querySelectorAll('.rl-copy-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          navigator.clipboard.writeText(btn.dataset.arn);
          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = orig; }, 1500);
        });
      });

      // Bind scratchpad buttons
      tbody.querySelectorAll('.rl-scratchpad-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const orig = btn.textContent;
          try {
            const res = await window.aws.invoke('arn-scratchpad:add', { arn: btn.dataset.arn, label: btn.dataset.label });
            btn.textContent = res.ok ? 'Added ✓' : `Error: ${res.error || 'unknown'}`;
            if (res.ok && window._arnScratchpadRefresh) window._arnScratchpadRefresh();
          } catch (err) {
            btn.textContent = `Error: ${err.message}`;
          }
          setTimeout(() => { btn.textContent = orig; }, 2000);
        });
      });
    }

    // Type selector buttons
    section.querySelectorAll('.rl-type-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        section.querySelectorAll('.rl-type-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        loadResourceType(btn.dataset.type);
      });
    });

    // Auto-load S3 on first open
    loadResourceType('s3');
  }

  if (feature.id === 'arn-scratchpad') {
    bindArnScratchpad(section);
  }

  if (feature.id === 'ip-scratchpad') {
    bindIpScratchpad(section);
  }

  if (feature.id === 'route53') {
    bindRoute53(section);
  }

  if (feature.id === 'timestamp-converter') {
    bindTimestampConverter(section);
  }

  if (feature.id === 'script-runner') {
    bindScriptRunner(section);
  }

  if (feature.id === 'cfn-templates') {
    bindCfnTemplates(section);
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

  // Expose refresh so the resource lister can trigger a reload after adding
  window._arnScratchpadRefresh = loadAndRender;

  loadAndRender();
}

/* ── IP Scratchpad ───────────────────────────────────────────────────────── */

function ipTypeLabel(ip) {
  if (ip.includes('/')) return 'CIDR';
  if (ip.includes(':')) return 'IPv6';
  const parts = ip.split('.');
  if (parts.length !== 4) return 'IP';
  const first = parseInt(parts[0], 10);
  if (first === 10) return 'RFC1918';
  if (first === 172 && parseInt(parts[1], 10) >= 16 && parseInt(parts[1], 10) <= 31) return 'RFC1918';
  if (first === 192 && parseInt(parts[1], 10) === 168) return 'RFC1918';
  if (first === 127) return 'LOOPBACK';
  return 'PUBLIC';
}

function ipTypeIcon(ip) {
  const t = ipTypeLabel(ip);
  const icons = { CIDR: '🗺', IPv6: '🔷', RFC1918: '🔒', LOOPBACK: '🔄', PUBLIC: '🌍' };
  return icons[t] || '🌐';
}

function bindIpScratchpad(section) {
  const ipInput    = section.querySelector('#ip-input');
  const labelInput = section.querySelector('#ip-label-input');
  const addBtn     = section.querySelector('#ip-add-btn');
  const errEl      = section.querySelector('#ip-add-error');
  const listEl     = section.querySelector('#ip-list');
  const countEl    = section.querySelector('#ip-count');

  async function loadAndRender() {
    const result = await window.aws.invoke('ip-scratchpad:list');
    renderIPs(result.entries || []);
  }

  function renderIPs(entries) {
    countEl.textContent = entries.length ? `${entries.length} saved` : '';
    if (!entries.length) {
      listEl.innerHTML = `<div class="ip-empty">No IPs saved yet. Paste one above to get started.</div>`;
      return;
    }
    listEl.innerHTML = entries.map(e => `
      <div class="ip-row" data-id="${e.id}">
        <span class="ip-icon">${ipTypeIcon(e.ip)}</span>
        <div class="ip-body">
          <div class="ip-meta">
            <span class="ip-type-badge">${ipTypeLabel(e.ip)}</span>
            ${e.label ? `<span class="ip-label-text">${escHtml(e.label)}</span>` : ''}
            <span class="ip-date">${new Date(e.addedAt).toLocaleDateString()}</span>
          </div>
          <div class="ip-text" title="${escHtml(e.ip)}">${escHtml(e.ip)}</div>
        </div>
        <div class="ip-actions">
          <button class="ip-copy-btn" title="Copy IP">Copy</button>
          <button class="ip-delete-btn" title="Remove">✕</button>
        </div>
      </div>
    `).join('');

    // Copy buttons
    listEl.querySelectorAll('.ip-copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = btn.closest('.ip-row');
        const ip = entries.find(en => en.id === row.dataset.id)?.ip;
        if (!ip) return;
        navigator.clipboard.writeText(ip).then(() => {
          btn.textContent = '✓ Copied';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1800);
        });
      });
    });

    // Click entire row to copy too
    listEl.querySelectorAll('.ip-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const ip = entries.find(en => en.id === row.dataset.id)?.ip;
        if (!ip) return;
        navigator.clipboard.writeText(ip).then(() => {
          row.classList.add('ip-flash');
          setTimeout(() => row.classList.remove('ip-flash'), 500);
        });
      });
    });

    // Delete buttons
    listEl.querySelectorAll('.ip-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.closest('.ip-row').dataset.id;
        await window.aws.invoke('ip-scratchpad:delete', { id });
        loadAndRender();
      });
    });
  }

  async function addIP() {
    const ip    = (ipInput.value || '').trim();
    const label = (labelInput.value || '').trim();
    errEl.classList.add('hidden');
    errEl.textContent = '';

    const result = await window.aws.invoke('ip-scratchpad:add', { ip, label });
    if (!result.ok) {
      errEl.textContent = result.error;
      errEl.classList.remove('hidden');
      ipInput.focus();
      return;
    }
    ipInput.value   = '';
    labelInput.value = '';
    loadAndRender();
  }

  addBtn.addEventListener('click', addIP);
  ipInput.addEventListener('keydown', e => { if (e.key === 'Enter') addIP(); });

  // Paste handler — auto-extract first IP from clipboard text
  ipInput.addEventListener('paste', (e) => {
    const pasted = (e.clipboardData || window.clipboardData).getData('text');
    const match  = pasted.match(/\b(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?\b|[0-9a-fA-F:]{2,39}/);
    if (match && match[0] !== pasted.trim()) {
      e.preventDefault();
      ipInput.value = match[0];
    }
  });

  window._ipScratchpadRefresh = loadAndRender;

  loadAndRender();
}

/* ── Timestamp Converter ─────────────────────────────────────────────────── */
function bindTimestampConverter(section) {
  const input   = section.querySelector('#ts-input');
  const errEl   = section.querySelector('#ts-error');
  const results = section.querySelector('#ts-results');
  const clearBtn = section.querySelector('#ts-clear');
  const nowBtn   = section.querySelector('#ts-now');

  function relativeTime(date) {
    const diff = Date.now() - date.getTime();
    const abs  = Math.abs(diff);
    const future = diff < 0;
    const fmt = (n, unit) => `${n} ${unit}${n !== 1 ? 's' : ''} ${future ? 'from now' : 'ago'}`;
    if (abs < 60_000)              return fmt(Math.round(abs / 1000), 'second');
    if (abs < 3_600_000)           return fmt(Math.round(abs / 60_000), 'minute');
    if (abs < 86_400_000)          return fmt(Math.round(abs / 3_600_000), 'hour');
    if (abs < 30 * 86_400_000)     return fmt(Math.round(abs / 86_400_000), 'day');
    if (abs < 365 * 86_400_000)    return fmt(Math.round(abs / (30 * 86_400_000)), 'month');
    return fmt(Math.round(abs / (365 * 86_400_000)), 'year');
  }

  function convert(raw) {
    const trimmed = raw.trim();
    if (!trimmed) { results.classList.add('hidden'); errEl.classList.add('hidden'); return; }

    let date;
    // Unix timestamp (seconds or ms)
    if (/^\d{10}$/.test(trimmed))       date = new Date(parseInt(trimmed, 10) * 1000);
    else if (/^\d{13}$/.test(trimmed))  date = new Date(parseInt(trimmed, 10));
    else                                date = new Date(trimmed);

    if (isNaN(date.getTime())) {
      results.classList.add('hidden');
      errEl.textContent = 'Could not parse timestamp. Try ISO 8601 or a Unix timestamp.';
      errEl.classList.remove('hidden');
      return;
    }

    errEl.classList.add('hidden');
    results.classList.remove('hidden');

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const localStr = date.toLocaleString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZoneName: 'short',
    });
    const utcStr = date.toLocaleString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'UTC', timeZoneName: 'short',
    });

    section.querySelector('#ts-local').textContent    = localStr;
    section.querySelector('#ts-utc').textContent      = utcStr;
    section.querySelector('#ts-iso').textContent      = date.toISOString();
    section.querySelector('#ts-unix').textContent     = Math.floor(date.getTime() / 1000).toString();
    section.querySelector('#ts-unix-ms').textContent  = date.getTime().toString();
    section.querySelector('#ts-relative').textContent = relativeTime(date);
    section.querySelector('#ts-tz').textContent       = tz;
  }

  input.addEventListener('input', () => convert(input.value));

  clearBtn.addEventListener('click', () => {
    input.value = '';
    results.classList.add('hidden');
    errEl.classList.add('hidden');
    input.focus();
  });

  nowBtn.addEventListener('click', () => {
    input.value = new Date().toISOString();
    convert(input.value);
  });

  // Copy buttons
  section.querySelectorAll('.ts-copy-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.previousElementSibling.textContent;
      navigator.clipboard.writeText(val);
      const orig = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
  });

  // Auto-convert if clipboard has a timestamp on focus
  input.addEventListener('focus', async () => {
    if (input.value) return;
    try {
      const text = await navigator.clipboard.readText();
      if (/^\d{10,13}$/.test(text.trim()) || /\d{4}-\d{2}-\d{2}T/.test(text)) {
        input.value = text.trim();
        convert(input.value);
      }
    } catch {}
  });
}

/* ── Route53 ─────────────────────────────────────────────────────────────── */
function bindRoute53(section) {
  const zonesList   = section.querySelector('#r53-zones-list');
  const recordsList = section.querySelector('#r53-records-list');
  const zoneTitle   = section.querySelector('#r53-zone-title');
  const recordCount = section.querySelector('#r53-record-count');
  const refreshBtn  = section.querySelector('#r53-refresh-zones');

  async function loadZones(attempt = 0) {
    zonesList.innerHTML = '<div class="r53-loading"><div class="spinner" style="margin:0 auto"></div></div>';
    const result = await window.aws.invoke('route53:list-zones');
    if (!result.ok) {
      // Auth not ready yet at startup — retry silently until session is restored
      if (result.error === 'Not authenticated' && attempt < 20) {
        setTimeout(() => loadZones(attempt + 1), 500);
        return;
      }
      zonesList.innerHTML = `<div class="r53-empty" style="color:var(--error)">${result.error}</div>`;
      return;
    }
    if (!result.zones.length) {
      zonesList.innerHTML = '<div class="r53-empty">No hosted zones found.</div>';
      return;
    }
    zonesList.innerHTML = result.zones.map((z) => `
      <div class="r53-zone-row" data-id="${z.id}" title="${z.comment || z.name}">
        <div class="r53-zone-name">${z.name}</div>
        <div class="r53-zone-meta">
          ${z.privateZone ? '<span class="r53-badge r53-private">Private</span>' : '<span class="r53-badge r53-public">Public</span>'}
          <span class="r53-badge">${z.recordCount} records</span>
        </div>
      </div>
    `).join('');

    zonesList.querySelectorAll('.r53-zone-row').forEach((row) => {
      row.addEventListener('click', () => {
        zonesList.querySelectorAll('.r53-zone-row').forEach((r) => r.classList.remove('active'));
        row.classList.add('active');
        const zone = result.zones.find((z) => z.id === row.dataset.id);
        loadRecords(row.dataset.id, zone?.name || row.dataset.id);
      });
    });
  }

  async function loadRecords(zoneId, zoneName) {
    zoneTitle.textContent = zoneName;
    recordCount.textContent = '';
    recordsList.innerHTML = '<div class="r53-loading"><div class="spinner" style="margin:0 auto"></div></div>';

    const result = await window.aws.invoke('route53:list-records', { zoneId });
    if (!result.ok) {
      recordsList.innerHTML = `<div class="r53-empty" style="color:var(--error)">${result.error}</div>`;
      return;
    }
    if (!result.records.length) {
      recordsList.innerHTML = '<div class="r53-empty">No records found.</div>';
      return;
    }

    recordCount.textContent = `${result.records.length} record${result.records.length !== 1 ? 's' : ''}`;
    recordsList.innerHTML = `
      <table class="feature-table r53-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>TTL</th>
            <th>Value(s)</th>
          </tr>
        </thead>
        <tbody>
          ${result.records.map((r) => {
            const values = r.alias ? [`ALIAS → ${r.alias}`] : r.values;
            return `
              <tr>
                <td class="r53-record-name" title="${escHtml(r.name)}">${escHtml(r.name)}</td>
                <td><span class="r53-type-badge r53-type-${r.type.toLowerCase()}">${r.type}</span></td>
                <td style="color:var(--text-muted)">${r.ttl !== null ? r.ttl : '—'}</td>
                <td class="r53-values">${values.map((v) => `<div class="r53-value" title="${escHtml(v)}">${escHtml(v)}</div>`).join('')}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;

    // Click any value to copy it
    recordsList.querySelectorAll('.r53-value').forEach((el) => {
      el.addEventListener('click', () => {
        navigator.clipboard.writeText(el.textContent.trim());
        el.classList.add('copied');
        const orig = el.title;
        el.title = 'Copied!';
        setTimeout(() => { el.classList.remove('copied'); el.title = orig; }, 1500);
      });
    });
  }

  refreshBtn.addEventListener('click', loadZones);
  loadZones();
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

/* ── Session Expiry Overlay ──────────────────────────────────────────────── */
function initSessionExpiryOverlay() {
  const overlay = document.getElementById('session-expired-overlay');
  const btn     = document.getElementById('session-expired-reauth-btn');

  function showExpiryOverlay() {
    // Only show if the user is currently authenticated — don't interrupt
    // the login flow if they're already looking at the auth view.
    if (currentView === 'auth') return;
    overlay.style.display = 'flex';
    // Clear session so the app knows they're logged out
    session = null;
  }

  // Proactive push from main process (timer fired before/at expiry)
  window.aws.onSessionExpired(showExpiryOverlay);

  // Reactive: also detect expired-token errors returned by any feature invoke
  const _origInvoke = window.aws.invoke;
  window.aws.invoke = async (channel, ...args) => {
    const result = await _origInvoke(channel, ...args);
    if (result && !result.ok && typeof result.error === 'string') {
      const msg = result.error.toLowerCase();
      if (msg.includes('expiredtoken') || msg.includes('token is expired') ||
          msg.includes('expired token') || msg.includes('security token') ||
          msg.includes('request has expired')) {
        showExpiryOverlay();
      }
    }
    return result;
  };

  btn.addEventListener('click', () => {
    overlay.style.display = 'none';
    // Sign the user out of the stored session and navigate to auth view
    window.aws.logout().catch(() => {});
    session = null;
    showView('auth');
  });
}

/* ── Settings view ───────────────────────────────────────────────────────── */
async function bindSettings() {
  const s = await window.aws.invoke('settings:get');
  const tidAvailable = (await window.aws.invoke('settings:touchid-available')).available;

  // ── Auto-refresh ──────────────────────────────────────────────────────────
  const arToggle   = document.getElementById('auto-refresh-toggle');
  const arOptions  = document.getElementById('auto-refresh-options');
  const arDuration = document.getElementById('auto-refresh-duration');

  arToggle.checked   = s.autoRefreshEnabled;
  arDuration.value   = String(s.autoRefreshHours || 4);
  arOptions.classList.toggle('hidden', !s.autoRefreshEnabled);

  // Initialise the clock module with saved values
  if (window._setAutoRefresh) {
    window._setAutoRefresh(s.autoRefreshEnabled, s.autoRefreshHours || 4);
  }

  arToggle.addEventListener('change', async () => {
    arOptions.classList.toggle('hidden', !arToggle.checked);
    await window.aws.invoke('settings:save', { autoRefreshEnabled: arToggle.checked });
    if (window._setAutoRefresh) {
      window._setAutoRefresh(arToggle.checked, Number(arDuration.value));
    }
  });

  arDuration.addEventListener('change', async () => {
    await window.aws.invoke('settings:save', { autoRefreshHours: Number(arDuration.value) });
    if (window._setAutoRefresh) {
      window._setAutoRefresh(arToggle.checked, Number(arDuration.value));
    }
  });

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

/* ── Script Runner ───────────────────────────────────────────────────────── */

function bindScriptRunner(section) {
  // DOM refs
  const prebakedList  = section.querySelector('#sr-prebaked-list');
  const customList    = section.querySelector('#sr-custom-list');
  const searchInput   = section.querySelector('#sr-search');
  const catFilter     = section.querySelector('#sr-category-filter');
  const newBtn        = section.querySelector('#sr-new-btn');
  const importFileBtn = section.querySelector('#sr-import-file-btn');
  const detailEmpty   = section.querySelector('#sr-detail-empty');
  const detailContent = section.querySelector('#sr-detail-content');
  const detailName    = section.querySelector('#sr-detail-name');
  const catBadge      = section.querySelector('#sr-detail-category-badge');
  const dangerBadge   = section.querySelector('#sr-detail-danger-badge');
  const detailDesc    = section.querySelector('#sr-detail-description');
  const scriptBody    = section.querySelector('#sr-script-body');
  const readonlyHint  = section.querySelector('#sr-readonly-hint');
  const customActions = section.querySelector('#sr-custom-actions');
  const saveBtn       = section.querySelector('#sr-save-btn');
  const importBtn     = section.querySelector('#sr-import-btn');
  const deleteBtn     = section.querySelector('#sr-delete-btn');
  const regionRow     = section.querySelector('#sr-region-row');
  const regionInput   = section.querySelector('#sr-region-input');
  const allRegNote    = section.querySelector('#sr-all-regions-note');
  const runBtn        = section.querySelector('#sr-run-btn');
  const outputWrap    = section.querySelector('#sr-output-wrap');
  const outputEl      = section.querySelector('#sr-output');
  const clearOutputBtn = section.querySelector('#sr-clear-output-btn');

  // Modals
  const newModal        = section.querySelector('#sr-new-modal');
  const newModalTitle   = section.querySelector('#sr-new-modal-title');
  const newModalClose   = section.querySelector('#sr-new-modal-close');
  const newNameInput    = section.querySelector('#sr-new-name');
  const newDescInput    = section.querySelector('#sr-new-desc');
  const newCategoryInput = section.querySelector('#sr-new-category');
  const newDangerInput  = section.querySelector('#sr-new-danger');
  const newBodyInput    = section.querySelector('#sr-new-body');
  const newError        = section.querySelector('#sr-new-error');
  const newCancelBtn    = section.querySelector('#sr-new-cancel');
  const newSaveBtn      = section.querySelector('#sr-new-save');

  const authModal     = section.querySelector('#sr-auth-modal');
  const authIcon      = section.querySelector('#sr-auth-icon');
  const authSubtitle  = section.querySelector('#sr-auth-subtitle');
  const authNotCfg    = section.querySelector('#sr-auth-not-configured');
  const authTidWrap   = section.querySelector('#sr-auth-touchid-wrap');
  const authTidBtn    = section.querySelector('#sr-auth-touchid-btn');
  const authSwitchPw  = section.querySelector('#sr-auth-switch-pw');
  const authPwWrap    = section.querySelector('#sr-auth-pw-wrap');
  const authPwInput   = section.querySelector('#sr-auth-pw-input');
  const authPwSubmit  = section.querySelector('#sr-auth-pw-submit');
  const authError     = section.querySelector('#sr-auth-error');
  const authCancel    = section.querySelector('#sr-auth-cancel');
  const authGoSettings = section.querySelector('#sr-auth-go-settings');

  const confirmModal  = section.querySelector('#sr-confirm-modal');
  const confirmClose  = section.querySelector('#sr-confirm-close');
  const confirmDanger = section.querySelector('#sr-confirm-danger-warn');
  const confirmName   = section.querySelector('#sr-confirm-name');
  const confirmAccount = section.querySelector('#sr-confirm-account');
  const confirmRegion  = section.querySelector('#sr-confirm-region');
  const confirmCancel = section.querySelector('#sr-confirm-cancel-btn');
  const confirmRun    = section.querySelector('#sr-confirm-run-btn');

  // State
  let selectedScript = null; // { id, name, description, category, danger, allRegions, scriptBody/body, isPrebaked }
  let allScripts     = { prebaked: [], custom: [] };
  let favoriteIds    = new Set();
  let _authResolve   = null;

  const CATEGORY_LABELS = {
    'cost-optimization': 'Cost Optimization',
    'security':          'Security',
    'danger':            'Danger',
    'custom':            'Custom',
    'iam':               'IAM',
    'operations':        'Operations',
  };

  // ── Render helpers ─────────────────────────────────────────────────────────

  function renderList() {
    const search    = (section.querySelector('#sr-search')?.value || '').toLowerCase().trim();
    const catFilter = section.querySelector('#sr-category-filter')?.value || '';
    const showFavsOnly = catFilter === 'favorites';

    function matchesFilter(s, defaultCat) {
      const cat = s.category || defaultCat;
      const nameMatch = !search || s.name.toLowerCase().includes(search) ||
                        (s.description || '').toLowerCase().includes(search);
      if (showFavsOnly) return nameMatch && favoriteIds.has(s.id);
      const catMatch  = !catFilter || cat === catFilter ||
                        (catFilter === 'danger' && s.danger);
      return nameMatch && catMatch;
    }

    function makeRow(s, isPrebaked) {
      const row = document.createElement('div');
      row.className = 'sr-script-row' + (selectedScript?.id === s.id ? ' active' : '');
      row.dataset.id = s.id;
      const cat     = s.category || (isPrebaked ? '' : 'custom');
      const isFav   = favoriteIds.has(s.id);

      const star = document.createElement('button');
      star.className = 'sr-fav-btn';
      star.textContent = isFav ? '⭐' : '☆';
      star.title = isFav ? 'Remove from favorites' : 'Add to favorites';
      star.addEventListener('click', async (e) => {
        e.stopPropagation();
        const res = await window.aws.invoke('script-runner:toggle-favorite', { id: s.id });
        if (res.ok) { favoriteIds = new Set(res.favorites); renderList(); }
      });

      const nameEl = document.createElement('div');
      nameEl.className = 'sr-script-row-name';
      nameEl.textContent = s.name;

      const badges = document.createElement('div');
      badges.className = 'sr-script-row-badges';
      badges.innerHTML = `${s.danger ? '<span class="sr-danger-badge-sm">DANGER</span>' : ''}<span class="sr-cat-badge-sm sr-cat-${cat}">${CATEGORY_LABELS[cat] || cat}</span>`;

      row.appendChild(star);
      row.appendChild(nameEl);
      row.appendChild(badges);
      row.addEventListener('click', () => selectScript({ ...s, isPrebaked }));
      return row;
    }

    // ── Favorites section (always shown when any exist, hidden when filtering by favorites only) ──
    const favsSection = section.querySelector('#sr-favorites-section');
    const favsList    = section.querySelector('#sr-favorites-list');
    const allItems    = [
      ...allScripts.prebaked.map(s => ({ ...s, isPrebaked: true })),
      ...allScripts.custom.map(s => ({ ...s, isPrebaked: false })),
    ];
    const favItems = allItems.filter(s => favoriteIds.has(s.id) &&
      (!search || s.name.toLowerCase().includes(search) || (s.description||'').toLowerCase().includes(search)));

    if (favItems.length > 0 && !showFavsOnly) {
      favsSection.style.display = '';
      favsList.innerHTML = '';
      for (const s of favItems) favsList.appendChild(makeRow(s, s.isPrebaked));
    } else {
      favsSection.style.display = 'none';
    }

    // ── Prebaked ──────────────────────────────────────────────────────────────
    const filteredPrebaked = allScripts.prebaked.filter(s => matchesFilter(s, ''));
    const prebakedSection  = section.querySelector('#sr-prebaked-section');

    if (showFavsOnly) {
      prebakedSection.style.display = 'none';
    } else {
      prebakedSection.style.display = '';
      prebakedList.innerHTML = '';
      if (filteredPrebaked.length === 0) {
        prebakedList.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:8px 10px;">${search || catFilter ? 'No matches' : 'No prebaked scripts'}</div>`;
      } else if (catFilter) {
        for (const s of filteredPrebaked) prebakedList.appendChild(makeRow(s, true));
      } else {
        const ORDER = ['security', 'cost-optimization', 'iam', 'operations', 'danger'];
        const grouped = {};
        for (const s of filteredPrebaked) {
          const key = s.category || 'other';
          (grouped[key] = grouped[key] || []).push(s);
        }
        const keys = [...ORDER.filter(k => grouped[k]), ...Object.keys(grouped).filter(k => !ORDER.includes(k))];
        for (const key of keys) {
          const label = document.createElement('div');
          label.className = 'sr-list-group-label';
          label.textContent = CATEGORY_LABELS[key] || key;
          prebakedList.appendChild(label);
          for (const s of grouped[key]) prebakedList.appendChild(makeRow(s, true));
        }
      }
    }

    // ── Custom ────────────────────────────────────────────────────────────────
    const filteredCustom  = allScripts.custom.filter(s => matchesFilter(s, 'custom'));
    const customSection   = section.querySelector('#sr-custom-section');

    if (showFavsOnly || (catFilter && catFilter !== 'custom')) {
      customSection.style.display = 'none';
    } else {
      customSection.style.display = '';
      customList.innerHTML = '';
      if (filteredCustom.length === 0) {
        customList.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:8px 10px;">${search ? 'No matches' : 'No custom scripts yet. Click "＋ New Script" to add one.'}</div>`;
      } else {
        for (const s of filteredCustom) customList.appendChild(makeRow(s, false));
      }
    }

    // ── Favorites-only view ───────────────────────────────────────────────────
    if (showFavsOnly) {
      favsSection.style.display = '';
      favsList.innerHTML = '';
      if (favItems.length === 0) {
        favsList.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:8px 10px;">${search ? 'No matching favorites' : 'No favorites yet — click ☆ on any script to add it.'}</div>`;
      } else {
        for (const s of favItems) favsList.appendChild(makeRow(s, s.isPrebaked));
      }
    }
  }

  function selectScript(s) {
    selectedScript = s;
    renderList();

    detailEmpty.classList.add('hidden');
    detailContent.classList.remove('hidden');

    detailName.textContent = s.name;
    detailDesc.textContent = s.description || '';

    // Category badge
    catBadge.textContent = CATEGORY_LABELS[s.category] || s.category;
    catBadge.className   = `sr-cat-badge sr-cat-${s.category}`;

    // Danger badge
    dangerBadge.classList.toggle('hidden', !s.danger);

    // Script body
    const body = s.isPrebaked ? s.scriptBody : s.body;
    scriptBody.value = body || '';
    scriptBody.readOnly = s.isPrebaked;
    readonlyHint.classList.toggle('hidden', !s.isPrebaked);
    customActions.classList.toggle('hidden', s.isPrebaked);

    // Region control
    const region = session?.region || '';
    if (s.allRegions) {
      regionRow.querySelector('#sr-region-input').style.display = 'none';
      regionRow.querySelector('label').style.display = 'none';
      allRegNote.classList.remove('hidden');
    } else {
      regionInput.style.display = '';
      regionRow.querySelector('label').style.display = '';
      allRegNote.classList.add('hidden');
      if (!regionInput.value) regionInput.value = region;
    }

    // Reset output
    outputWrap.classList.add('hidden');
    outputEl.innerHTML = '';
  }

  // ── Auth helpers ────────────────────────────────────────────────────────────

  async function promptAuth() {
    return new Promise(async (resolve) => {
      _authResolve = resolve;

      const s          = await window.aws.invoke('settings:get');
      const tidCheck   = await window.aws.invoke('settings:touchid-available');
      const tidAvail   = tidCheck.available;
      const authReady  = s.lockEnabled && (s.lockMethod === 'touchid' ? tidAvail : s.hasPassword);

      // Reset modal state
      authError.classList.add('hidden');
      authNotCfg.classList.add('hidden');
      authTidWrap.classList.add('hidden');
      authPwWrap.classList.add('hidden');
      authPwInput.value = '';

      authModal.classList.remove('hidden');

      if (!authReady) {
        authIcon.textContent = '🔒';
        authSubtitle.textContent = 'Auth protection is required to run scripts.';
        authNotCfg.classList.remove('hidden');
        return; // resolve never called until user dismisses
      }

      authIcon.textContent = '🔐';
      authSubtitle.textContent = 'Verify your identity before executing.';

      if (s.lockMethod === 'touchid' && tidAvail) {
        authTidWrap.classList.remove('hidden');
        setTimeout(doTouchID, 300);
      } else {
        authPwWrap.classList.remove('hidden');
        setTimeout(() => authPwInput.focus(), 100);
      }
    });
  }

  async function doTouchID() {
    authError.classList.add('hidden');
    const result = await window.aws.invoke('settings:prompt-touchid');
    if (result.ok) {
      closeAuthModal(true);
      return;
    }
    // Fall back to password
    authTidWrap.classList.add('hidden');
    authPwWrap.classList.remove('hidden');
    if (result.error && !result.error.toLowerCase().includes('cancelled')) {
      authError.textContent = result.error;
      authError.classList.remove('hidden');
    }
    setTimeout(() => authPwInput.focus(), 100);
  }

  async function doPassword() {
    authError.classList.add('hidden');
    const pw = authPwInput.value;
    const result = await window.aws.invoke('settings:verify-password', pw);
    if (result.ok) {
      closeAuthModal(true);
    } else {
      authError.textContent = 'Incorrect password.';
      authError.classList.remove('hidden');
      authPwInput.select();
    }
  }

  function closeAuthModal(success) {
    authModal.classList.add('hidden');
    authPwInput.value = '';
    if (_authResolve) { _authResolve(success); _authResolve = null; }
  }

  // ── Confirm modal ──────────────────────────────────────────────────────────

  function showConfirmModal(script, region, onConfirm) {
    confirmDanger.classList.toggle('hidden', !script.danger);
    confirmName.textContent    = script.name;
    confirmAccount.textContent = session?.accountId || '—';
    confirmRegion.textContent  = script.allRegions ? 'All active regions' : (region || '—');
    confirmModal.classList.remove('hidden');

    const cleanup = () => { confirmModal.classList.add('hidden'); };
    const handleRun = () => { cleanup(); onConfirm(); };

    confirmRun.onclick    = handleRun;
    confirmCancel.onclick = cleanup;
    confirmClose.onclick  = cleanup;
  }

  // ── Run script ─────────────────────────────────────────────────────────────

  async function runSelectedScript() {
    if (!selectedScript) return;

    // 1. Auth gate
    const authed = await promptAuth();
    if (!authed) return;

    // 2. Validate region (if needed)
    const region = selectedScript.allRegions ? '' : (regionInput.value || '').trim();
    if (!selectedScript.allRegions && !region) {
      outputEl.innerHTML = '<div class="sr-output-line sr-output-error">⚠ Please enter a target region before running.</div>';
      outputWrap.classList.remove('hidden');
      return;
    }

    // 3. Collect params (if script has interactive parameters)
    let params = null;
    if (selectedScript.isPrebaked && (selectedScript.params || []).length) {
      params = await promptParams(selectedScript, region);
      if (!params) return; // user cancelled
    }

    // 4. Confirm dialog
    showConfirmModal(selectedScript, region, async () => {
      // 5. Execute
      runBtn.disabled = true;
      runBtn.textContent = '⏳ Running…';
      outputWrap.classList.remove('hidden');
      outputEl.innerHTML = '<div class="sr-output-line" style="color:var(--text-muted)">Starting…</div>';

      let result;
      if (selectedScript.isPrebaked) {
        result = await window.aws.invoke('script-runner:run', { scriptId: selectedScript.id, region, params });
      } else {
        const body = scriptBody.value;
        result = await window.aws.invoke('script-runner:run-custom', { body, region });
      }

      runBtn.disabled = false;
      runBtn.textContent = '▶ Run Script';

      if (!result.ok) {
        outputEl.innerHTML = `<div class="sr-output-line sr-output-error">✗ Error: ${escHtml(result.error)}</div>`;
        return;
      }

      outputEl.innerHTML = (result.logs || []).map(renderLogLine).join('');
      bindOutputLinks(outputEl);
    });
  }

  // ── Load scripts ───────────────────────────────────────────────────────────

  async function loadScripts() {
    const result = await window.aws.invoke('script-runner:list');
    if (result.ok) {
      allScripts  = { prebaked: result.prebaked, custom: result.custom };
      favoriteIds = new Set(result.favorites || []);
    }
    renderList();
  }

  // ── New script modal ───────────────────────────────────────────────────────

  function openNewModal(editScript) {
    newModalTitle.textContent   = editScript ? 'Edit Custom Script' : 'New Custom Script';
    newNameInput.value          = editScript?.name || '';
    newDescInput.value          = editScript?.description || '';
    newCategoryInput.value      = editScript?.category || 'custom';
    newDangerInput.checked      = editScript?.danger || false;
    newBodyInput.value          = editScript?.body || '';
    newError.classList.add('hidden');
    newModal.classList.remove('hidden');
    setTimeout(() => newNameInput.focus(), 100);
  }

  function closeNewModal() { newModal.classList.add('hidden'); }

  newBtn.addEventListener('click', () => openNewModal(null));

  importFileBtn.addEventListener('click', async () => {
    const result = await window.aws.invoke('util:import-file', {
      type:    'script',
      filters: [
        { name: 'Shell Scripts', extensions: ['sh', 'bash', 'zsh', 'py', 'rb', 'ps1'] },
        { name: 'All Files',     extensions: ['*'] },
      ],
    });
    if (result.canceled) return;
    if (!result.ok) { showImportError(result.error); return; }
    const fileName = result.filePath.split('/').pop().replace(/\.[^.]+$/, '');
    openNewModal({ name: fileName, description: '', body: result.content, category: 'custom', danger: false });
  });

  newModalClose.addEventListener('click', closeNewModal);
  newCancelBtn.addEventListener('click', closeNewModal);

  newSaveBtn.addEventListener('click', async () => {
    const name     = newNameInput.value.trim();
    const desc     = newDescInput.value.trim();
    const category = newCategoryInput.value || 'custom';
    const danger   = newDangerInput.checked;
    const body     = newBodyInput.value.trim();
    newError.classList.add('hidden');

    if (!name) { newError.textContent = 'Script name is required.'; newError.classList.remove('hidden'); return; }
    if (!body) { newError.textContent = 'Script body cannot be empty.'; newError.classList.remove('hidden'); return; }

    const result = await window.aws.invoke('script-runner:save-custom', { name, description: desc, category, danger, body });
    if (!result.ok && result.error) { newError.textContent = result.error; newError.classList.remove('hidden'); return; }

    closeNewModal();
    await loadScripts();
    // Auto-select the newly saved script (first in custom list)
    if (allScripts.custom.length) {
      selectScript({ ...allScripts.custom[0], isPrebaked: false });
    }
  });

  // ── Detail actions ─────────────────────────────────────────────────────────

  saveBtn.addEventListener('click', async () => {
    if (!selectedScript || selectedScript.isPrebaked) return;
    const body = scriptBody.value.trim();
    if (!body) return;
    await window.aws.invoke('script-runner:save-custom', {
      id:          selectedScript.id,
      name:        selectedScript.name,
      description: selectedScript.description,
      category:    selectedScript.category,
      danger:      selectedScript.danger,
      body,
    });
    await loadScripts();
    // Re-select
    const updated = allScripts.custom.find(s => s.id === selectedScript.id);
    if (updated) selectScript({ ...updated, isPrebaked: false });
  });

  importBtn.addEventListener('click', async () => {
    if (!selectedScript || selectedScript.isPrebaked) return;
    const result = await window.aws.invoke('util:import-file', {
      type:    'script',
      filters: [
        { name: 'Shell Scripts', extensions: ['sh', 'bash', 'zsh', 'py', 'rb', 'ps1'] },
        { name: 'All Files',     extensions: ['*'] },
      ],
    });
    if (result.canceled) return;
    if (!result.ok) { showImportError(result.error); return; }
    scriptBody.value = result.content;
    scriptBody.dispatchEvent(new Event('input'));
  });

  deleteBtn.addEventListener('click', async () => {
    if (!selectedScript || selectedScript.isPrebaked) return;
    if (!confirm(`Delete "${selectedScript.name}"? This cannot be undone.`)) return;
    await window.aws.invoke('script-runner:delete-custom', { id: selectedScript.id });
    selectedScript = null;
    detailEmpty.classList.remove('hidden');
    detailContent.classList.add('hidden');
    await loadScripts();
  });

  runBtn.addEventListener('click', runSelectedScript);

  clearOutputBtn.addEventListener('click', () => {
    outputEl.innerHTML = '';
    outputWrap.classList.add('hidden');
  });

  // ── Params modal ─────────────────────────────────────────────────────────────

  const paramsModal       = section.querySelector('#sr-params-modal');
  const paramsModalTitle  = section.querySelector('#sr-params-modal-title');
  const paramsModalClose  = section.querySelector('#sr-params-modal-close');
  const paramsFields      = section.querySelector('#sr-params-fields');
  const paramsError       = section.querySelector('#sr-params-error');
  const paramsCancelBtn   = section.querySelector('#sr-params-cancel-btn');
  const paramsContinueBtn = section.querySelector('#sr-params-continue-btn');
  let _paramsResolve      = null;

  function buildParamInput(param, region) {
    const wrapper = document.createElement('div');

    const label = document.createElement('label');
    label.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:5px;';
    label.textContent = param.label + (param.required ? ' *' : '');
    wrapper.appendChild(label);

    const inputStyle = 'width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:var(--radius);padding:7px 10px;font-size:13px;outline:none;box-sizing:border-box;';

    if (param.type === 'select') {
      const select = document.createElement('select');
      select.dataset.paramId = param.id;
      select.style.cssText = inputStyle;
      for (const opt of param.options || []) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = param.unit ? `${opt} ${param.unit}` : opt;
        select.appendChild(o);
      }
      if (param.defaultValue) select.value = param.defaultValue;

      if (param.allowCustom) {
        const customOpt = document.createElement('option');
        customOpt.value = '__custom__';
        customOpt.textContent = 'Custom…';
        select.appendChild(customOpt);

        const customInput = document.createElement('input');
        customInput.type = 'text';
        customInput.dataset.paramId = `${param.id}_custom`;
        customInput.placeholder = `Enter custom value${param.unit ? ' (' + param.unit + ')' : ''}`;
        customInput.style.cssText = inputStyle + 'margin-top:6px;';
        customInput.classList.add('hidden');

        select.addEventListener('change', () => {
          customInput.classList.toggle('hidden', select.value !== '__custom__');
          if (select.value !== '__custom__') customInput.value = '';
          else setTimeout(() => customInput.focus(), 50);
        });

        wrapper.appendChild(select);
        wrapper.appendChild(customInput);
      } else {
        wrapper.appendChild(select);
      }

    } else if (param.type === 'multiselect') {
      const container = document.createElement('div');
      container.dataset.paramId  = param.id;
      container.dataset.paramType = 'multiselect';
      container.style.cssText = 'border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;max-height:180px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;background:var(--surface);';
      for (const opt of param.options || []) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-primary);cursor:pointer;';
        const cb = document.createElement('input');
        cb.type  = 'checkbox';
        cb.value = opt.value;
        cb.style.cssText = 'accent-color:var(--accent);width:14px;height:14px;cursor:pointer;flex-shrink:0;';
        row.appendChild(cb);
        row.appendChild(document.createTextNode(opt.label));
        container.appendChild(row);
      }
      wrapper.appendChild(container);

    } else if (param.type === 'dynamic-select') {
      const container = document.createElement('div');
      container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:6px 0;">Loading options…</div>';
      wrapper.appendChild(container);

      window.aws.invoke(param.fetchIpc, { region }).then(resp => {
        const opts = resp.ok ? (resp.options || []) : [];
        let html = `<select data-param-id="${param.id}" style="${inputStyle}">`;
        if (param.allOption) html += `<option value="__ALL__">${escHtml(param.allOption)}</option>`;
        for (const opt of opts) {
          html += `<option value="${escHtml(opt.value)}">${escHtml(opt.label)}</option>`;
        }
        if (!opts.length && !param.allOption) {
          html += '<option value="" disabled>No options found</option>';
        }
        html += '</select>';
        if (!resp.ok) html += `<div style="color:var(--error);font-size:11px;margin-top:4px;">${escHtml(resp.error)}</div>`;
        container.innerHTML = html;
      }).catch(err => {
        container.innerHTML = `<div style="color:var(--error);font-size:12px;">${escHtml(err.message)}</div>`;
      });

    } else {
      const input = document.createElement('input');
      input.type = param.type === 'email' ? 'email' : 'text';
      input.dataset.paramId = param.id;
      input.placeholder = param.placeholder || '';
      input.style.cssText = inputStyle;
      if (param.defaultValue) input.value = param.defaultValue;
      wrapper.appendChild(input);
    }

    return wrapper;
  }

  async function promptParams(script, region) {
    return new Promise((resolve) => {
      _paramsResolve = resolve;
      paramsModalTitle.textContent = script.name;
      paramsError.classList.add('hidden');
      paramsFields.innerHTML = '';

      for (const param of script.params || []) {
        paramsFields.appendChild(buildParamInput(param, region));
      }

      paramsModal.classList.remove('hidden');
      // Focus first text input
      setTimeout(() => paramsFields.querySelector('input, select')?.focus(), 100);
    });
  }

  function closeParamsModal(result) {
    paramsModal.classList.add('hidden');
    if (_paramsResolve) { _paramsResolve(result); _paramsResolve = null; }
  }

  paramsModalClose.addEventListener('click', () => closeParamsModal(null));
  paramsCancelBtn.addEventListener('click',  () => closeParamsModal(null));

  paramsContinueBtn.addEventListener('click', () => {
    paramsError.classList.add('hidden');
    const collected = {};

    for (const param of selectedScript?.params || []) {
      let el = paramsFields.querySelector(`[data-param-id="${param.id}"]`);
      if (!el) continue;

      // Multiselect — collect all checked checkboxes as an array
      if (param.type === 'multiselect') {
        const checked = Array.from(el.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
        if (param.required && checked.length === 0) {
          paramsError.textContent = `"${param.label}" requires at least one selection.`;
          paramsError.classList.remove('hidden');
          return;
        }
        if (checked.length) collected[param.id] = checked;
        continue;
      }

      let val = el.value?.trim() || '';

      if (param.allowCustom && val === '__custom__') {
        const customEl = paramsFields.querySelector(`[data-param-id="${param.id}_custom"]`);
        val = customEl?.value?.trim() || '';
      }

      if (param.required && !val) {
        paramsError.textContent = `"${param.label}" is required.`;
        paramsError.classList.remove('hidden');
        el.focus();
        return;
      }

      if (val) collected[param.id] = val;
    }

    closeParamsModal(collected);
  });

  // ── Version history ───────────────────────────────────────────────────────────

  const versionsModal          = section.querySelector('#sr-versions-modal');
  const versionsModalClose     = section.querySelector('#sr-versions-modal-close');
  const versionsList           = section.querySelector('#sr-versions-list');
  const versionPreviewEmpty    = section.querySelector('#sr-version-preview-empty');
  const versionPreviewContent  = section.querySelector('#sr-version-preview-content');
  const versionPreviewBody     = section.querySelector('#sr-version-preview-body');
  const versionRevertBtn       = section.querySelector('#sr-version-revert-btn');
  const versionDefaultBtn      = section.querySelector('#sr-version-default-btn');
  const versionDeleteBtn       = section.querySelector('#sr-version-delete-btn');
  const versionSnapshotBtn     = section.querySelector('#sr-version-snapshot-btn');
  const versionLabelInput      = section.querySelector('#sr-version-label-input');
  const versionsBtn            = section.querySelector('#sr-versions-btn');

  let _versionsScriptId  = null;
  let _versionsData      = [];
  let _selectedVersionId = null;

  async function openVersionHistory() {
    if (!selectedScript || selectedScript.isPrebaked) return;
    _versionsScriptId  = selectedScript.id;
    _selectedVersionId = null;
    versionPreviewEmpty.classList.remove('hidden');
    versionPreviewContent.classList.add('hidden');
    versionLabelInput.value = '';
    versionsModal.classList.remove('hidden');
    await loadVersionHistory();
  }

  async function loadVersionHistory() {
    const result = await window.aws.invoke('script-runner:versions-list', { scriptId: _versionsScriptId });
    _versionsData = result.versions || [];
    renderVersionList();
  }

  function renderVersionList() {
    if (!_versionsData.length) {
      versionsList.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:16px;text-align:center;">No versions yet.<br>Save a snapshot or edit the script.</div>';
      return;
    }

    versionsList.innerHTML = _versionsData.map(v => `
      <div class="sr-script-row${_selectedVersionId === v.id ? ' active' : ''}" data-vid="${v.id}" style="padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--border);">
        <div style="font-size:10px;font-weight:600;color:var(--text-secondary);">${v.isDefault ? '★ Default  ·  ' : ''}${new Date(v.timestamp).toLocaleString()}</div>
        ${v.label ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(v.label)}</div>` : ''}
      </div>
    `).join('');

    versionsList.querySelectorAll('[data-vid]').forEach(row => {
      row.addEventListener('click', () => {
        _selectedVersionId = row.dataset.vid;
        renderVersionList();
        const v = _versionsData.find(v => v.id === _selectedVersionId);
        if (v) {
          versionPreviewBody.value = v.content;
          versionPreviewEmpty.classList.add('hidden');
          versionPreviewContent.classList.remove('hidden');
          versionDefaultBtn.textContent = v.isDefault ? '★ Default' : '★ Set Default';
          versionDefaultBtn.disabled    = v.isDefault;
        }
      });
    });
  }

  versionsBtn?.addEventListener('click', openVersionHistory);
  versionsModalClose.addEventListener('click', () => versionsModal.classList.add('hidden'));

  versionSnapshotBtn.addEventListener('click', async () => {
    if (!_versionsScriptId) return;
    const label = versionLabelInput.value.trim();
    await window.aws.invoke('script-runner:versions-save', {
      scriptId: _versionsScriptId,
      content:  scriptBody.value,
      label,
    });
    versionLabelInput.value = '';
    await loadVersionHistory();
  });

  versionRevertBtn.addEventListener('click', async () => {
    if (!_selectedVersionId) return;
    const v = _versionsData.find(v => v.id === _selectedVersionId);
    if (!v) return;
    if (!confirm('Revert to this version? The current content will be auto-saved as a snapshot first.')) return;

    // Snapshot current before reverting
    await window.aws.invoke('script-runner:versions-save', {
      scriptId: _versionsScriptId,
      content:  scriptBody.value,
      label:    `Auto-saved before revert on ${new Date().toLocaleString()}`,
    });

    // Overwrite script with the selected version's content
    await window.aws.invoke('script-runner:save-custom', {
      id:          selectedScript.id,
      name:        selectedScript.name,
      description: selectedScript.description,
      body:        v.content,
    });

    versionsModal.classList.add('hidden');
    await loadScripts();
    const updated = allScripts.custom.find(s => s.id === selectedScript.id);
    if (updated) selectScript({ ...updated, isPrebaked: false });
  });

  versionDefaultBtn.addEventListener('click', async () => {
    if (!_selectedVersionId) return;
    await window.aws.invoke('script-runner:versions-set-default', {
      scriptId:  _versionsScriptId,
      versionId: _selectedVersionId,
    });
    await loadVersionHistory();
  });

  versionDeleteBtn.addEventListener('click', async () => {
    if (!_selectedVersionId) return;
    if (!confirm('Delete this version? This cannot be undone.')) return;
    await window.aws.invoke('script-runner:versions-delete', {
      scriptId:  _versionsScriptId,
      versionId: _selectedVersionId,
    });
    _selectedVersionId = null;
    versionPreviewEmpty.classList.remove('hidden');
    versionPreviewContent.classList.add('hidden');
    await loadVersionHistory();
  });

  // ── Auth modal events ──────────────────────────────────────────────────────

  authTidBtn.addEventListener('click', doTouchID);
  authSwitchPw.addEventListener('click', () => {
    authTidWrap.classList.add('hidden');
    authPwWrap.classList.remove('hidden');
    authError.classList.add('hidden');
    setTimeout(() => authPwInput.focus(), 60);
  });
  authPwSubmit.addEventListener('click', doPassword);
  authPwInput.addEventListener('keydown', e => { if (e.key === 'Enter') doPassword(); });
  authCancel.addEventListener('click', () => closeAuthModal(false));
  authGoSettings.addEventListener('click', () => {
    closeAuthModal(false);
    showView('settings');
    setActiveNav('settings');
  });
  // Settings link inside error box
  section.querySelectorAll('.sr-settings-link').forEach(el => {
    el.addEventListener('click', () => {
      closeAuthModal(false);
      showView('settings');
      setActiveNav('settings');
    });
  });

  // ── Confirm modal events ───────────────────────────────────────────────────

  // (onclick wired per-show in showConfirmModal)

  // ── Search / filter ───────────────────────────────────────────────────────

  searchInput.addEventListener('input', () => renderList());
  catFilter.addEventListener('change',  () => renderList());

  // ── Init ──────────────────────────────────────────────────────────────────

  loadScripts();
}

function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Renders a log line as an HTML string, turning any https:// URLs into
// clickable links that open in the external browser.
function renderLogLine(line) {
  const cls = line.startsWith('✓') ? 'sr-output-ok'
            : line.startsWith('✗') ? 'sr-output-error'
            : line.startsWith('⚠') ? 'sr-output-warn'
            : '';
  const urlPattern = /https?:\/\/[^\s]+/g;
  let inner = '';
  let last  = 0;
  let m;
  while ((m = urlPattern.exec(line)) !== null) {
    inner += escHtml(line.slice(last, m.index));
    const url = m[0];
    inner += `<a href="#" class="sr-output-link" data-href="${escHtml(url)}">${escHtml(url)}</a>`;
    last = m.index + url.length;
  }
  inner += escHtml(line.slice(last));
  return `<div class="sr-output-line ${cls}">${inner}</div>`;
}

// Wire up link clicks inside an output element (call once after setting innerHTML)
function bindOutputLinks(el) {
  el.querySelectorAll('.sr-output-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      window.aws.openExternal(a.dataset.href);
    });
  });
}

/* ── CloudFormation Templates ───────────────────────────────────────────────── */

function bindCfnTemplates(section) {
  // DOM refs
  const prebakedList  = section.querySelector('#cfn-prebaked-list');
  const customList    = section.querySelector('#cfn-custom-list');
  const searchInput   = section.querySelector('#cfn-search');
  const catFilter     = section.querySelector('#cfn-category-filter');
  const newBtn        = section.querySelector('#cfn-new-btn');
  const importFileBtn = section.querySelector('#cfn-import-file-btn');
  const detailEmpty   = section.querySelector('#cfn-detail-empty');
  const detailContent = section.querySelector('#cfn-detail-content');
  const detailName    = section.querySelector('#cfn-detail-name');
  const catBadge      = section.querySelector('#cfn-detail-category-badge');
  const dangerBadge   = section.querySelector('#cfn-detail-danger-badge');
  const detailDesc    = section.querySelector('#cfn-detail-description');
  const templateBody  = section.querySelector('#cfn-template-body');
  const readonlyHint  = section.querySelector('#cfn-readonly-hint');
  const customActions = section.querySelector('#cfn-custom-actions');
  const saveBtn       = section.querySelector('#cfn-save-btn');
  const importBtn     = section.querySelector('#cfn-import-btn');
  const deleteBtn     = section.querySelector('#cfn-delete-btn');
  const regionInput   = section.querySelector('#cfn-region-input');
  const deployBtn     = section.querySelector('#cfn-deploy-btn');
  const outputWrap    = section.querySelector('#cfn-output-wrap');
  const outputEl      = section.querySelector('#cfn-output');
  const clearOutputBtn = section.querySelector('#cfn-clear-output-btn');

  // New template modal
  const newModal          = section.querySelector('#cfn-new-modal');
  const newModalTitle     = section.querySelector('#cfn-new-modal-title');
  const newModalClose     = section.querySelector('#cfn-new-modal-close');
  const newNameInput      = section.querySelector('#cfn-new-name');
  const newDescInput      = section.querySelector('#cfn-new-desc');
  const newCategoryInput  = section.querySelector('#cfn-new-category');
  const newDangerInput    = section.querySelector('#cfn-new-danger');
  const newBodyInput      = section.querySelector('#cfn-new-body');
  const newError          = section.querySelector('#cfn-new-error');
  const newCancelBtn      = section.querySelector('#cfn-new-cancel');
  const newSaveBtn        = section.querySelector('#cfn-new-save');

  // Auth modal
  const authModal    = section.querySelector('#cfn-auth-modal');
  const authNotCfg   = section.querySelector('#cfn-auth-not-configured');
  const authTidWrap  = section.querySelector('#cfn-auth-touchid-wrap');
  const authTidBtn   = section.querySelector('#cfn-auth-touchid-btn');
  const authSwitchPw = section.querySelector('#cfn-auth-switch-pw');
  const authPwWrap   = section.querySelector('#cfn-auth-pw-wrap');
  const authPwInput  = section.querySelector('#cfn-auth-pw-input');
  const authPwSubmit = section.querySelector('#cfn-auth-pw-submit');
  const authError    = section.querySelector('#cfn-auth-error');
  const authCancel   = section.querySelector('#cfn-auth-cancel');
  const authGoSettings = section.querySelector('#cfn-auth-go-settings');

  // Deploy modal
  const deployModal      = section.querySelector('#cfn-deploy-modal');
  const deployModalClose = section.querySelector('#cfn-deploy-modal-close');
  const deployDangerWarn = section.querySelector('#cfn-deploy-danger-warn');
  const deployTmplName   = section.querySelector('#cfn-deploy-template-name');
  const deployAccount    = section.querySelector('#cfn-deploy-account');
  const deployRegionDisp = section.querySelector('#cfn-deploy-region-display');
  const deployStackInput = section.querySelector('#cfn-stack-name-input');
  const deployParams     = section.querySelector('#cfn-deploy-params');
  const deployError      = section.querySelector('#cfn-deploy-error');
  const deployCancelBtn  = section.querySelector('#cfn-deploy-cancel-btn');
  const deployConfirmBtn = section.querySelector('#cfn-deploy-confirm-btn');

  // State
  let selectedTemplate = null;
  let allTemplates     = { prebaked: [], custom: [] };
  let favoriteIds      = new Set();
  let _authResolve     = null;

  const CFN_CATEGORY_LABELS = {
    'networking': 'Networking',
    'security':   'Security',
    'storage':    'Storage',
    'compute':    'Compute',
    'custom':     'Custom',
    'danger':     'Danger',
  };

  // ── Render helpers ──────────────────────────────────────────────────────────

  function renderList() {
    const search       = (searchInput?.value || '').toLowerCase().trim();
    const catValue     = catFilter?.value || '';
    const showFavsOnly = catValue === 'favorites';

    function matchesFilter(t, defaultCat) {
      const cat      = t.category || defaultCat;
      const nameMatch = !search || t.name.toLowerCase().includes(search) ||
                        (t.description || '').toLowerCase().includes(search);
      if (showFavsOnly) return nameMatch && favoriteIds.has(t.id);
      const catMatch  = !catValue || cat === catValue ||
                        (catValue === 'danger' && t.danger);
      return nameMatch && catMatch;
    }

    function makeRow(t, isPrebaked) {
      const row = document.createElement('div');
      row.className = 'sr-script-row' + (selectedTemplate?.id === t.id ? ' active' : '');
      row.dataset.id = t.id;
      const cat   = t.category || (isPrebaked ? '' : 'custom');
      const isFav = favoriteIds.has(t.id);

      const star = document.createElement('button');
      star.className = 'sr-fav-btn';
      star.textContent = isFav ? '⭐' : '☆';
      star.title = isFav ? 'Remove from favorites' : 'Add to favorites';
      star.addEventListener('click', async (e) => {
        e.stopPropagation();
        const res = await window.aws.invoke('cfn-templates:toggle-favorite', { id: t.id });
        if (res.ok) { favoriteIds = new Set(res.favorites); renderList(); }
      });

      const nameEl = document.createElement('div');
      nameEl.className = 'sr-script-row-name';
      nameEl.textContent = t.name;

      const badges = document.createElement('div');
      badges.className = 'sr-script-row-badges';
      badges.innerHTML = `${t.danger ? '<span class="sr-danger-badge-sm">DANGER</span>' : ''}<span class="sr-cat-badge-sm sr-cat-${cat}">${CFN_CATEGORY_LABELS[cat] || cat}</span>`;

      row.appendChild(star);
      row.appendChild(nameEl);
      row.appendChild(badges);
      row.addEventListener('click', () => selectTemplate({ ...t, isPrebaked }));
      return row;
    }

    // ── Favorites section ─────────────────────────────────────────────────────
    const favsSection = section.querySelector('#cfn-favorites-section');
    const favsList    = section.querySelector('#cfn-favorites-list');
    const allItems    = [
      ...allTemplates.prebaked.map(t => ({ ...t, isPrebaked: true })),
      ...allTemplates.custom.map(t => ({ ...t, isPrebaked: false })),
    ];
    const favItems = allItems.filter(t => favoriteIds.has(t.id) &&
      (!search || t.name.toLowerCase().includes(search) || (t.description||'').toLowerCase().includes(search)));

    if (favItems.length > 0 && !showFavsOnly) {
      favsSection.style.display = '';
      favsList.innerHTML = '';
      for (const t of favItems) favsList.appendChild(makeRow(t, t.isPrebaked));
    } else {
      favsSection.style.display = 'none';
    }

    // ── Prebaked ──────────────────────────────────────────────────────────────
    const filteredPrebaked = allTemplates.prebaked.filter(t => matchesFilter(t, ''));
    const prebakedSection  = section.querySelector('#cfn-prebaked-section');

    if (showFavsOnly) {
      prebakedSection.style.display = 'none';
    } else {
      prebakedSection.style.display = '';
      prebakedList.innerHTML = '';
      if (filteredPrebaked.length === 0) {
        prebakedList.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:8px 10px;">${search || catValue ? 'No matches' : 'No prebaked templates'}</div>`;
      } else if (catValue) {
        for (const t of filteredPrebaked) prebakedList.appendChild(makeRow(t, true));
      } else {
        const ORDER = ['networking', 'security', 'storage', 'compute', 'danger'];
        const grouped = {};
        for (const t of filteredPrebaked) {
          const key = t.category || 'other';
          (grouped[key] = grouped[key] || []).push(t);
        }
        const keys = [...ORDER.filter(k => grouped[k]), ...Object.keys(grouped).filter(k => !ORDER.includes(k))];
        for (const key of keys) {
          const label = document.createElement('div');
          label.className = 'sr-list-group-label';
          label.textContent = CFN_CATEGORY_LABELS[key] || key;
          prebakedList.appendChild(label);
          for (const t of grouped[key]) prebakedList.appendChild(makeRow(t, true));
        }
      }
    }

    // ── Custom ────────────────────────────────────────────────────────────────
    const filteredCustom = allTemplates.custom.filter(t => matchesFilter(t, 'custom'));
    const customSection  = section.querySelector('#cfn-custom-section');

    if (showFavsOnly || (catValue && catValue !== 'custom')) {
      customSection.style.display = 'none';
    } else {
      customSection.style.display = '';
      customList.innerHTML = '';
      if (filteredCustom.length === 0) {
        customList.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:8px 10px;">${search ? 'No matches' : 'No custom templates. Click "＋ Add Template" to add one.'}</div>`;
      } else {
        for (const t of filteredCustom) customList.appendChild(makeRow(t, false));
      }
    }

    // ── Favorites-only view ───────────────────────────────────────────────────
    if (showFavsOnly) {
      favsSection.style.display = '';
      favsList.innerHTML = '';
      if (favItems.length === 0) {
        favsList.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:8px 10px;">${search ? 'No matching favorites' : 'No favorites yet — click ☆ on any template to add it.'}</div>`;
      } else {
        for (const t of favItems) favsList.appendChild(makeRow(t, t.isPrebaked));
      }
    }
  }

  function selectTemplate(t) {
    selectedTemplate = t;
    renderList();

    detailEmpty.classList.add('hidden');
    detailContent.classList.remove('hidden');

    detailName.textContent = t.name;
    detailDesc.textContent = t.description || '';

    catBadge.textContent = CFN_CATEGORY_LABELS[t.category] || t.category;
    catBadge.className   = `sr-cat-badge sr-cat-${t.category}`;

    dangerBadge.classList.toggle('hidden', !t.danger);

    const body = t.isPrebaked ? t.templateBody : t.body;
    templateBody.value    = body || '';
    templateBody.readOnly = t.isPrebaked;
    readonlyHint.classList.toggle('hidden', !t.isPrebaked);
    customActions.classList.toggle('hidden', t.isPrebaked);

    if (!regionInput.value) regionInput.value = session?.region || '';

    outputWrap.classList.add('hidden');
    outputEl.innerHTML = '';
  }

  async function loadTemplates() {
    const result = await window.aws.invoke('cfn-templates:list');
    if (result.ok) {
      allTemplates = { prebaked: result.prebaked, custom: result.custom };
      favoriteIds  = new Set(result.favorites || []);
    }
    renderList();
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  async function promptAuth() {
    return new Promise(async (resolve) => {
      _authResolve = resolve;

      const s        = await window.aws.invoke('settings:get');
      const tidCheck = await window.aws.invoke('settings:touchid-available');
      const tidAvail = tidCheck.available;
      const ready    = s.lockEnabled && (s.lockMethod === 'touchid' ? tidAvail : s.hasPassword);

      authError.classList.add('hidden');
      authNotCfg.classList.add('hidden');
      authTidWrap.classList.add('hidden');
      authPwWrap.classList.add('hidden');
      authPwInput.value = '';
      authModal.classList.remove('hidden');

      if (!ready) {
        authNotCfg.classList.remove('hidden');
        return;
      }

      if (s.lockMethod === 'touchid' && tidAvail) {
        authTidWrap.classList.remove('hidden');
        setTimeout(doTouchID, 300);
      } else {
        authPwWrap.classList.remove('hidden');
        setTimeout(() => authPwInput.focus(), 100);
      }
    });
  }

  async function doTouchID() {
    authError.classList.add('hidden');
    const result = await window.aws.invoke('settings:prompt-touchid');
    if (result.ok) { closeAuthModal(true); return; }
    authTidWrap.classList.add('hidden');
    authPwWrap.classList.remove('hidden');
    if (result.error && !result.error.toLowerCase().includes('cancelled')) {
      authError.textContent = result.error;
      authError.classList.remove('hidden');
    }
    setTimeout(() => authPwInput.focus(), 100);
  }

  async function doPassword() {
    authError.classList.add('hidden');
    const result = await window.aws.invoke('settings:verify-password', authPwInput.value);
    if (result.ok) { closeAuthModal(true); }
    else {
      authError.textContent = 'Incorrect password.';
      authError.classList.remove('hidden');
      authPwInput.select();
    }
  }

  function closeAuthModal(success) {
    authModal.classList.add('hidden');
    authPwInput.value = '';
    if (_authResolve) { _authResolve(success); _authResolve = null; }
  }

  authTidBtn.addEventListener('click', doTouchID);
  authSwitchPw.addEventListener('click', () => {
    authTidWrap.classList.add('hidden');
    authPwWrap.classList.remove('hidden');
    authError.classList.add('hidden');
    setTimeout(() => authPwInput.focus(), 60);
  });
  authPwSubmit.addEventListener('click', doPassword);
  authPwInput.addEventListener('keydown', e => { if (e.key === 'Enter') doPassword(); });
  authCancel.addEventListener('click', () => closeAuthModal(false));
  authGoSettings.addEventListener('click', () => {
    closeAuthModal(false);
    showView('settings');
    setActiveNav('settings');
  });
  section.querySelectorAll('.cfn-settings-link').forEach(el => {
    el.addEventListener('click', () => { closeAuthModal(false); showView('settings'); setActiveNav('settings'); });
  });

  // ── Deploy modal ────────────────────────────────────────────────────────────

  function showDeployModal(template, region, onDeploy) {
    deployDangerWarn.classList.toggle('hidden', !template.danger);
    deployTmplName.textContent   = template.name;
    deployAccount.textContent    = session?.accountId || '—';
    deployRegionDisp.textContent = region || '—';
    deployError.classList.add('hidden');
    deployParams.innerHTML = '';

    // Inject template-specific deploy params (for prebaked templates)
    for (const param of template.deployParams || []) {
      const wrapper = document.createElement('div');
      const label = document.createElement('label');
      label.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:5px;';
      label.textContent = param.label + (param.required ? ' *' : '');
      wrapper.appendChild(label);

      const inputStyle = 'width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:var(--radius);padding:7px 10px;font-size:13px;outline:none;box-sizing:border-box;';

      if (param.type === 'select') {
        const sel = document.createElement('select');
        sel.dataset.paramId = param.id;
        sel.style.cssText = inputStyle;
        for (const opt of param.options || []) {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          sel.appendChild(o);
        }
        if (param.defaultValue) sel.value = param.defaultValue;
        wrapper.appendChild(sel);
      } else {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.dataset.paramId = param.id;
        inp.placeholder = param.placeholder || '';
        inp.style.cssText = inputStyle;
        if (param.defaultValue) inp.value = param.defaultValue;
        wrapper.appendChild(inp);
      }

      deployParams.appendChild(wrapper);
    }

    // Pre-fill stack name from template id if empty
    if (!deployStackInput.value) deployStackInput.value = template.id;

    deployModal.classList.remove('hidden');
    setTimeout(() => deployStackInput.select(), 80);

    const cleanup = () => deployModal.classList.add('hidden');

    deployModalClose.onclick  = cleanup;
    deployCancelBtn.onclick   = cleanup;
    deployConfirmBtn.onclick  = () => {
      deployError.classList.add('hidden');
      const stackName = deployStackInput.value.trim();
      if (!stackName) {
        deployError.textContent = 'Stack name is required.';
        deployError.classList.remove('hidden');
        deployStackInput.focus();
        return;
      }

      const params = {};
      deployParams.querySelectorAll('[data-param-id]').forEach(el => {
        const v = el.value?.trim();
        if (v) params[el.dataset.paramId] = v;
      });

      cleanup();
      onDeploy(stackName, params);
    };
  }

  // ── Deploy flow ─────────────────────────────────────────────────────────────

  async function deploySelectedTemplate() {
    if (!selectedTemplate) return;

    const region = (regionInput.value || '').trim();
    if (!region) {
      outputEl.innerHTML = '<div class="sr-output-line sr-output-error">⚠ Please enter a target region before deploying.</div>';
      outputWrap.classList.remove('hidden');
      return;
    }

    const authed = await promptAuth();
    if (!authed) return;

    showDeployModal(selectedTemplate, region, async (stackName, params) => {
      deployBtn.disabled = true;
      deployBtn.textContent = '⏳ Deploying…';
      outputWrap.classList.remove('hidden');
      outputEl.innerHTML = '<div class="sr-output-line" style="color:var(--text-muted)">Submitting stack creation request…</div>';

      const result = await window.aws.invoke('cfn-templates:deploy', {
        templateId:   selectedTemplate.isPrebaked ? selectedTemplate.id : null,
        templateBody: selectedTemplate.isPrebaked ? null : selectedTemplate.body,
        stackName,
        region,
        params,
      });

      if (!result.ok) {
        deployBtn.disabled = false;
        deployBtn.textContent = '🚀 Deploy Stack';
        outputEl.innerHTML = `<div class="sr-output-line sr-output-error">✗ Error: ${escHtml(result.error)}</div>`;
        return;
      }

      // Render initial lines from the deploy response
      function appendOutputLine(text, cls = '') {
        const d = document.createElement('div');
        d.className = 'sr-output-line' + (cls ? ' ' + cls : '');
        d.textContent = text;
        outputEl.appendChild(d);
        outputEl.scrollTop = outputEl.scrollHeight;
      }

      outputEl.innerHTML = '';
      (result.logs || []).forEach(line => {
        const el = document.createElement('div');
        el.innerHTML = renderLogLine(line);
        const child = el.firstElementChild;
        outputEl.appendChild(child);
      });
      bindOutputLinks(outputEl);

      // Poll for stack status until terminal state
      let lastEventId = null;
      let pollCount   = 0;
      const MAX_POLLS = 120; // ~10 minutes at 5s intervals

      const spinFrames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
      const statusLine = document.createElement('div');
      statusLine.className = 'sr-output-line cfn-status-line';
      outputEl.appendChild(statusLine);

      async function poll() {
        if (pollCount++ >= MAX_POLLS) {
          statusLine.textContent = '⚠ Timed out waiting for stack. Check the AWS Console for final status.';
          statusLine.className = 'sr-output-line sr-output-warn';
          deployBtn.disabled = false;
          deployBtn.textContent = '🚀 Deploy Stack';
          return;
        }

        const pr = await window.aws.invoke('cfn-templates:poll-status', {
          stackName: result.stackName,
          region:    result.region,
          lastEventId,
        });

        if (!pr.ok) {
          statusLine.textContent = `✗ Poll error: ${pr.error}`;
          statusLine.className = 'sr-output-line sr-output-error';
          deployBtn.disabled = false;
          deployBtn.textContent = '🚀 Deploy Stack';
          return;
        }

        // Append any new resource events (insert before status line)
        (pr.newEvents || []).forEach(ev => {
          const isErr = ev.status.includes('FAILED');
          const icon  = isErr ? '✗' : ev.status.includes('COMPLETE') ? '✓' : '  ';
          const text  = `${icon} [${ev.timestamp}] ${ev.logicalId} (${ev.resourceType}) → ${ev.status}${ev.reason ? ': ' + ev.reason : ''}`;
          const d = document.createElement('div');
          d.className = 'sr-output-line' + (isErr ? ' sr-output-error' : ev.status.includes('COMPLETE') ? ' sr-output-ok' : '');
          d.textContent = text;
          outputEl.insertBefore(d, statusLine);
        });
        if (pr.newEvents?.length) lastEventId = pr.lastEventId;

        outputEl.scrollTop = outputEl.scrollHeight;

        if (pr.terminal) {
          const succeeded = pr.succeeded;
          statusLine.textContent = succeeded
            ? `✓ Stack "${result.stackName}" created successfully.`
            : `✗ Stack "${result.stackName}" ended with status: ${pr.status}${pr.statusReason ? ' — ' + pr.statusReason : ''}`;
          statusLine.className = 'sr-output-line ' + (succeeded ? 'sr-output-ok' : 'sr-output-error');
          deployBtn.disabled = false;
          deployBtn.textContent = '🚀 Deploy Stack';
          return;
        }

        // Still in-progress — update the spinner line
        const spin = spinFrames[pollCount % spinFrames.length];
        statusLine.textContent = `${spin} Status: ${pr.status || 'CREATE_IN_PROGRESS'} — waiting…`;
        statusLine.className = 'sr-output-line cfn-status-line';

        setTimeout(poll, 5000);
      }

      // First poll after a short delay to let CFN register the stack
      setTimeout(poll, 3000);
    });
  }

  deployBtn.addEventListener('click', deploySelectedTemplate);

  clearOutputBtn.addEventListener('click', () => {
    outputEl.innerHTML = '';
    outputWrap.classList.add('hidden');
  });

  // ── New template modal ───────────────────────────────────────────────────────

  function openNewModal(editTemplate) {
    newModalTitle.textContent  = editTemplate ? 'Edit Custom Template' : 'Add Custom Template';
    newNameInput.value         = editTemplate?.name || '';
    newDescInput.value         = editTemplate?.description || '';
    newCategoryInput.value     = editTemplate?.category || 'custom';
    newDangerInput.checked     = editTemplate?.danger || false;
    newBodyInput.value         = editTemplate?.body || '';
    newError.classList.add('hidden');
    newModal.classList.remove('hidden');
    setTimeout(() => newNameInput.focus(), 100);
  }

  function closeNewModal() { newModal.classList.add('hidden'); }

  newBtn.addEventListener('click', () => openNewModal(null));

  importFileBtn.addEventListener('click', async () => {
    const result = await window.aws.invoke('util:import-file', {
      type:    'cfn',
      filters: [
        { name: 'CloudFormation Templates', extensions: ['yaml', 'yml', 'json', 'template'] },
        { name: 'All Files',                extensions: ['*'] },
      ],
    });
    if (result.canceled) return;
    if (!result.ok) { showImportError(result.error); return; }
    const fileName = result.filePath.split('/').pop().replace(/\.[^.]+$/, '');
    openNewModal({ name: fileName, description: '', body: result.content, category: 'custom', danger: false });
  });

  newModalClose.addEventListener('click', closeNewModal);
  newCancelBtn.addEventListener('click', closeNewModal);

  newSaveBtn.addEventListener('click', async () => {
    const name     = newNameInput.value.trim();
    const desc     = newDescInput.value.trim();
    const category = newCategoryInput.value || 'custom';
    const danger   = newDangerInput.checked;
    const body     = newBodyInput.value.trim();
    newError.classList.add('hidden');

    if (!name) { newError.textContent = 'Template name is required.'; newError.classList.remove('hidden'); return; }
    if (!body) { newError.textContent = 'Template body cannot be empty.'; newError.classList.remove('hidden'); return; }

    const result = await window.aws.invoke('cfn-templates:save-custom', { name, description: desc, category, danger, body });
    if (!result.ok && result.error) { newError.textContent = result.error; newError.classList.remove('hidden'); return; }

    closeNewModal();
    await loadTemplates();
    if (allTemplates.custom.length) {
      selectTemplate({ ...allTemplates.custom[0], isPrebaked: false });
    }
  });

  // ── Detail actions ──────────────────────────────────────────────────────────

  saveBtn.addEventListener('click', async () => {
    if (!selectedTemplate || selectedTemplate.isPrebaked) return;
    const body = templateBody.value.trim();
    if (!body) return;
    await window.aws.invoke('cfn-templates:save-custom', {
      id:          selectedTemplate.id,
      name:        selectedTemplate.name,
      description: selectedTemplate.description,
      category:    selectedTemplate.category,
      danger:      selectedTemplate.danger,
      body,
    });
    await loadTemplates();
    const updated = allTemplates.custom.find(t => t.id === selectedTemplate.id);
    if (updated) selectTemplate({ ...updated, isPrebaked: false });
  });

  importBtn.addEventListener('click', async () => {
    if (!selectedTemplate || selectedTemplate.isPrebaked) return;
    const result = await window.aws.invoke('util:import-file', {
      type:    'cfn',
      filters: [
        { name: 'CloudFormation Templates', extensions: ['yaml', 'yml', 'json', 'template'] },
        { name: 'All Files',                extensions: ['*'] },
      ],
    });
    if (result.canceled) return;
    if (!result.ok) { showImportError(result.error); return; }
    templateBody.value = result.content;
    templateBody.dispatchEvent(new Event('input'));
  });

  deleteBtn.addEventListener('click', async () => {
    if (!selectedTemplate || selectedTemplate.isPrebaked) return;
    if (!confirm(`Delete "${selectedTemplate.name}"? This cannot be undone.`)) return;
    await window.aws.invoke('cfn-templates:delete-custom', { id: selectedTemplate.id });
    selectedTemplate = null;
    detailEmpty.classList.remove('hidden');
    detailContent.classList.add('hidden');
    await loadTemplates();
  });

  // ── Search / filter ───────────────────────────────────────────────────────

  searchInput.addEventListener('input', () => renderList());
  catFilter.addEventListener('change',  () => renderList());

  // ── Init ────────────────────────────────────────────────────────────────────

  loadTemplates();
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
    const noAuthRequired = ['auth', 'console', 'cloudshell', 'audit', 'settings', 'feature-arn-scratchpad', 'feature-ip-scratchpad'];
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

      // Show log file link if this entry has one
      const logLinkContainer = document.getElementById('audit-detail-log-link');
      if (logLinkContainer) {
        const logPath = entry.details?.logPath;
        if (logPath) {
          logLinkContainer.innerHTML =
            `<a href="#" class="audit-log-file-link" data-path="${logPath}">📄 Open script output log</a>
             <span class="audit-log-file-path">${logPath}</span>`;
          logLinkContainer.querySelector('a').addEventListener('click', async (ev) => {
            ev.preventDefault();
            await window.aws.showItemInFolder(logPath);
          });
          logLinkContainer.style.display = '';
        } else {
          logLinkContainer.style.display = 'none';
        }
      }

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
