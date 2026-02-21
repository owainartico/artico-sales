/* ============================================================
   Artico Sales — App JS (vanilla, no framework)
   ============================================================ */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser   = null;
let firstLoginId  = null;   // user_id for first-login password-set flow
let currentTab    = 'dashboard';
let toastTimer    = null;
let undoCallback  = null;

// Target grid state
let targetReps     = [];
let targetMonths   = [];
let targetMap      = {};   // "repId-YYYY-MM" → amount
let prevYearMap    = {};   // "repId-YYYY-MM" → amount (previous year reference)

// Admin state
let usersCache = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  try {
    const opts = {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    };
    const res = await fetch(path, opts);

    if (res.status === 401 && currentUser) {
      currentUser = null;
      showScreen('login');
      return null;
    }

    return await res.json();
  } catch (err) {
    console.error('API error:', err);
    return null;
  }
}

function fmt(n, compact) {
  if (n === null || n === undefined) return '—';
  const num = parseFloat(n);
  if (isNaN(num)) return '—';
  if (compact && num >= 1000) {
    return '$' + (num / 1000).toFixed(1) + 'k';
  }
  return '$' + num.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtMonth(ym) {
  const [y, m] = ym.split('-');
  const d = new Date(parseInt(y), parseInt(m) - 1, 1);
  return d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' });
}

function prevYearMonth(ym) {
  const [y, m] = ym.split('-');
  return `${parseInt(y) - 1}-${m}`;
}

function getRollingMonths() {
  const months = [];
  const now    = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    months.push(`${y}-${m}`);
  }
  return months;
}

function el(id) { return document.getElementById(id); }

function showError(elId, msg) {
  const e = el(elId);
  e.textContent = msg;
  e.classList.remove('hidden');
}

function clearError(elId) {
  const e = el(elId);
  e.textContent = '';
  e.classList.add('hidden');
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, undoCb, duration = 5000) {
  const t = el('toast');
  clearTimeout(toastTimer);
  undoCallback = undoCb || null;

  if (undoCb) {
    t.innerHTML = `<span>${msg}</span><button class="toast__undo" id="toast-undo">Undo</button>`;
    el('toast-undo').addEventListener('click', () => {
      clearTimeout(toastTimer);
      undoCb();
      t.classList.add('hidden');
      undoCallback = null;
    });
  } else {
    t.textContent = msg;
  }

  t.classList.remove('hidden');
  toastTimer = setTimeout(() => {
    t.classList.add('hidden');
    undoCallback = null;
  }, duration);
}

// ── Screens ───────────────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s =>
    s.classList.toggle('hidden', s.id !== `screen-${name}`)
  );
}

// ── Auth flows ────────────────────────────────────────────────────────────────
el('form-login').addEventListener('submit', async e => {
  e.preventDefault();
  clearError('login-error');

  const email    = el('login-email').value.trim();
  const password = el('login-password').value;
  const btn      = el('login-btn');

  btn.disabled = true;
  btn.textContent = 'Signing in…';

  const data = await api('POST', '/auth/login', { email, password });

  btn.disabled = false;
  btn.textContent = 'Sign In';

  if (!data) {
    showError('login-error', 'Connection error. Please try again.');
    return;
  }

  if (data.first_login) {
    firstLoginId = data.user_id;
    showScreen('set-password');
    return;
  }

  if (data.error) {
    showError('login-error', data.error);
    return;
  }

  currentUser = data;
  if (data.must_change_password) {
    firstLoginId = data.id;
    showScreen('set-password');
  } else {
    initApp();
  }
});

el('form-set-password').addEventListener('submit', async e => {
  e.preventDefault();
  clearError('setpw-error');

  const pw  = el('new-password').value;
  const pw2 = el('confirm-password').value;
  const btn = el('setpw-btn');

  if (pw.length < 8) {
    showError('setpw-error', 'Password must be at least 8 characters.');
    return;
  }
  if (pw !== pw2) {
    showError('setpw-error', 'Passwords do not match.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  const data = await api('POST', '/auth/change-password', {
    user_id: firstLoginId,
    password: pw,
  });

  btn.disabled = false;
  btn.textContent = 'Set Password & Continue';

  if (!data || data.error) {
    showError('setpw-error', data?.error || 'Failed to set password.');
    return;
  }

  currentUser  = data;
  firstLoginId = null;
  initApp();
});

el('btn-logout').addEventListener('click', async () => {
  await api('POST', '/auth/logout');
  currentUser = null;
  el('login-email').value    = '';
  el('login-password').value = '';
  showScreen('login');
});

// ── App Init ──────────────────────────────────────────────────────────────────
async function boot() {
  const data = await api('GET', '/auth/me');

  if (!data || data.error) {
    showScreen('login');
    return;
  }

  currentUser = data;

  if (data.must_change_password) {
    firstLoginId = data.id;
    showScreen('set-password');
    return;
  }

  initApp();
}

function initApp() {
  const isManager = ['manager', 'executive'].includes(currentUser.role);

  // Update header
  el('header-user-name').textContent = currentUser.name;

  // Show/hide role-restricted tabs
  document.querySelectorAll('.manager-only').forEach(el =>
    el.classList.toggle('hidden', !isManager)
  );

  setupPullToRefresh();
  showScreen('app');
  navigate('dashboard');
}

// ── Navigation ────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-bar__item').forEach(btn => {
  btn.addEventListener('click', () => navigate(btn.dataset.tab));
});

function navigate(tab) {
  currentTab = tab;

  document.querySelectorAll('.tab-bar__item').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.querySelectorAll('.page').forEach(p =>
    p.classList.toggle('hidden', p.id !== `page-${tab}`)
  );

  loadPage(tab);
}

async function loadPage(tab) {
  switch (tab) {
    case 'dashboard':  loadDashboard();  break;
    case 'visits':     loadVisits();     break;
    case 'stores':     loadStores();     break;
    case 'targets':    loadTargets();    break;
    case 'admin':      loadAdmin();      break;
    case 'products':   loadProducts();   break;
    case 'scoreboard': loadScoreboard(); break;
    case 'planner':    loadPlanner();    break;
  }
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

let _dashChart = null; // Chart.js instance — destroyed on re-render

async function loadDashboard(force = false) {
  const page   = el('page-dashboard');
  const isManager = ['manager', 'executive'].includes(currentUser.role);
  const url    = isManager
    ? `/api/dashboard/team${force ? '?refresh=1' : ''}`
    : `/api/dashboard/rep${force ? '?refresh=1' : ''}`;

  // Show skeletons with informative loading message
  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Dashboard</h1>
      <button class="btn-icon-sm" id="btn-dash-refresh" title="Refresh data">↻</button>
    </div>
    <div class="skeleton-block" style="height:140px;"></div>
    <div class="skeleton-block" style="height:80px;"></div>
    <div class="skeleton-block" style="height:180px;"></div>
    <div class="skeleton-block skeleton-block--sm"></div>
    <p class="text-muted text-sm" style="text-align:center;padding:8px 16px;">
      Loading revenue data from Zoho… first load may take up to 30s
    </p>`;

  el('btn-dash-refresh')?.addEventListener('click', () => loadDashboard(true));

  const data = await api('GET', url);

  if (!data || data.error) {
    page.innerHTML = `
      <div class="page-header"><h1 class="page-title">Dashboard</h1></div>
      <div class="empty-state">
        <div class="empty-state__icon">⚠️</div>
        <div class="empty-state__title">Could not load data</div>
        <div class="empty-state__desc">${data?.error || 'Check Zoho connection and try again.'}</div>
        <button class="btn btn--accent mt-4" onclick="loadDashboard(true)">Retry</button>
      </div>`;
    return;
  }

  // Invoice cache still warming after server restart — show holding screen and auto-retry
  if (data.data_loading) {
    page.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Dashboard</h1>
        <button class="btn-icon-sm" onclick="loadDashboard(true)" title="Refresh">↻</button>
      </div>
      <div class="empty-state">
        <div class="empty-state__icon" style="font-size:2rem;animation:spin 1.5s linear infinite">⟳</div>
        <div class="empty-state__title">Revenue data is loading</div>
        <div class="empty-state__desc">Fetching 18 months of invoices from Zoho — usually ready within 90 seconds of startup.<br>This page will refresh automatically.</div>
        <button class="btn btn--accent mt-4" onclick="loadDashboard(true)">Refresh now</button>
      </div>`;
    // Auto-retry in 30s — cache should be warm by then
    setTimeout(() => { if (currentTab === 'dashboard') loadDashboard(true); }, 30_000);
    return;
  }

  if (_dashChart) { _dashChart.destroy(); _dashChart = null; }

  if (isManager) renderTeamDashboard(page, data);
  else           renderRepDashboard(page, data);

  // Load alerts after dashboard is visible — failure here won't break the dashboard
  loadDashboardAlerts();

  // Load KPI data async — won't block dashboard display
  if (isManager) loadKpiTeam();
  else            loadKpiCard();
}

function refreshDashboard() { loadDashboard(true); }
window.refreshDashboard = refreshDashboard;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMonthLong(ym) {
  const [y, m] = ym.split('-');
  return new Date(+y, +m - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function pctClass(pct) {
  if (pct === null || pct === undefined) return 'muted';
  if (pct >= 90) return 'success';
  if (pct >= 70) return 'warning';
  return 'danger';
}

function progressBar(pct, cls) {
  const w = Math.min(pct ?? 0, 100);
  return `<div class="progress">
    <div class="progress__fill progress__fill--${cls || pctClass(pct)}" style="width:${w}%"></div>
  </div>`;
}

function freshnessBanner(lastUpdated, lastSyncAt) {
  const syncAge = lastSyncAt
    ? (Date.now() - new Date(lastSyncAt).getTime()) / 60000
    : Infinity;
  const stale = syncAge > 120;
  return `
    <div class="freshness-bar ${stale ? 'freshness-bar--stale' : ''}">
      <span>Updated ${timeAgo(lastUpdated)}</span>
      ${stale ? '<span class="freshness-warn">⚠ Zoho data may be outdated</span>' : ''}
      <button class="btn-text" onclick="refreshDashboard()">↻ Refresh</button>
    </div>`;
}

// ── Rep dashboard renderer ────────────────────────────────────────────────────

function renderRepDashboard(page, d) {
  const { hero, ytd, territory_growth, monthly_history, brand_breakdown, quick_stats, month } = d;
  const pc = pctClass(hero.percentage);

  const brandRows = brand_breakdown.some(b => b.actual > 0)
    ? brand_breakdown.map(b => `
        <div class="brand-row">
          <div class="brand-row__name">${b.name}</div>
          <div class="brand-row__bar-wrap">
            <div class="brand-row__bar" style="width:${b.pct_of_total}%"></div>
          </div>
          <div class="brand-row__meta">
            <span class="fw-bold">${fmt(b.actual, true)}</span>
            <span class="text-muted text-sm">${b.pct_of_total}%</span>
          </div>
        </div>`).join('')
    : `<p class="text-muted text-sm">Brand breakdown available once SKU prefixes are configured.</p>`;

  const tg = territory_growth || {};
  const tgPct = tg.growth_pct;
  const tgClass = tgPct === null ? 'muted' : tgPct >= 0 ? 'success' : 'danger';
  const tgLabel = tgPct === null ? '—' : `${tgPct >= 0 ? '+' : ''}${tgPct}%`;
  const territoryCard = tg.store_count > 0
    ? `<div class="card">
        <div class="card__title">Territory Growth</div>
        <div class="tg-row">
          <div class="tg-cell">
            <div class="stat-num">${fmt(tg.current)}</div>
            <div class="stat-lbl">This Month</div>
          </div>
          <div class="tg-badge-wrap">
            <span class="tg-badge tg-badge--${tgClass}">${tgLabel}</span>
          </div>
          <div class="tg-cell">
            <div class="stat-num text-muted">${fmt(tg.ly)}</div>
            <div class="stat-lbl">Same Mo. LY</div>
          </div>
        </div>
        <div class="text-muted text-xs" style="margin-top:6px;">vs same month last year (by territory · ${tg.store_count} stores)</div>
      </div>`
    : `<div class="card">
        <div class="card__title">Territory Growth</div>
        <p class="text-muted text-sm">Territory data pending — store sync required.</p>
      </div>`;

  page.innerHTML = `
    ${freshnessBanner(d.last_updated, d.last_sync_at)}

    <div class="page-header" style="margin-top:var(--space-3);">
      <h1 class="page-title">Dashboard</h1>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="page-subtitle">${fmtMonthLong(month)}</span>
        <button class="btn-icon-sm" onclick="refreshDashboard()" title="Refresh">↻</button>
      </div>
    </div>

    <!-- Hero -->
    <div class="card dash-hero">
      <div class="dash-hero__label">This Month</div>
      <div class="dash-hero__actual">${fmt(hero.actual)}</div>
      <div class="dash-hero__target text-muted">of ${fmt(hero.target)} target</div>
      ${progressBar(hero.percentage, pc)}
      <div class="dash-hero__meta">
        <span class="pct-badge pct-badge--${pc}">${hero.percentage !== null ? hero.percentage + '%' : '—'}</span>
        <span class="text-muted text-sm">
          ${hero.days_remaining}d left ·
          ${fmt(hero.daily_run_rate, true)}/day pace ·
          need ${fmt(hero.required_daily_rate, true)}/day
        </span>
      </div>
    </div>

    <!-- YTD -->
    <div class="card">
      <div class="card__title">Year to Date</div>
      <div class="stat-grid stat-grid--2" style="margin-bottom:var(--space-3);">
        <div>
          <div class="stat-num">${fmt(ytd.actual)}</div>
          <div class="stat-lbl">Actual</div>
        </div>
        <div>
          <div class="stat-num">${fmt(ytd.target)}</div>
          <div class="stat-lbl">Target</div>
        </div>
      </div>
      ${progressBar(ytd.percentage)}
      ${ytd.percentage !== null ? `
        <div class="text-sm mt-4" style="margin-top:6px;">
          <span class="text-${pctClass(ytd.percentage) === 'success' ? 'success' : pctClass(ytd.percentage) === 'warning' ? 'warning' : 'danger'}">
            ${ytd.percentage >= 100 ? '+' : ''}${ytd.percentage - 100}% vs target
          </span>
        </div>` : ''}
    </div>

    <!-- Territory Growth -->
    ${territoryCard}

    <!-- Sparkline -->
    <div class="card">
      <div class="card__title">Last 12 Months</div>
      <div class="chart-wrap">
        <canvas id="chart-monthly"></canvas>
      </div>
    </div>

    <!-- Brand breakdown -->
    <div class="card">
      <div class="card__title">Brand Mix — This Month</div>
      ${brandRows}
    </div>

    <!-- Quick stats -->
    <div class="stat-grid stat-grid--3">
      <div class="card stat-mini">
        <div class="stat-mini__val">${quick_stats.new_doors}</div>
        <div class="stat-mini__lbl">New Customers</div>
      </div>
      <div class="card stat-mini">
        <div class="stat-mini__val">${quick_stats.visits_this_month}</div>
        <div class="stat-mini__lbl">Visits</div>
      </div>
      <div class="card stat-mini ${quick_stats.overdue_stores > 0 ? 'stat-mini--alert' : ''}">
        <div class="stat-mini__val">${quick_stats.overdue_stores}</div>
        <div class="stat-mini__lbl">60d Unvisited</div>
      </div>
    </div>

    <!-- KPI card placeholder (filled by loadKpiCard) -->
    <div id="kpi-card-wrap"></div>

    <!-- Alerts placeholder (filled by loadDashboardAlerts) -->
    <div id="alerts-container"><div class="skeleton-block skeleton-block--sm" style="margin-top:var(--space-4);"></div></div>`;

  renderSparkline('chart-monthly', monthly_history);
}

// ── Team dashboard renderer ───────────────────────────────────────────────────

function renderTeamDashboard(page, d) {
  const { leaderboard, totals, ytd, company_territory_growth, quarterly_grade_trend, brand_performance, new_doors_by_rep, monthly_history, month } = d;

  const leaderRows = leaderboard.map((r, i) => {
    const pc = pctClass(r.percentage);
    const tgPct = r.territory_growth_pct;
    const tgClass = tgPct === null ? 'muted' : tgPct >= 0 ? 'success' : 'danger';
    const tgText  = tgPct === null ? '—' : `${tgPct >= 0 ? '+' : ''}${tgPct}%`;
    const gd = r.grade_dist || {};
    const gradeDistHtml = (gd.A || gd.B || gd.C || gd.ungraded)
      ? `<div class="grade-dist">
           ${gd.A ? `<span class="grade-dist__item grade-dist__item--a">${gd.A}A</span>` : ''}
           ${gd.B ? `<span class="grade-dist__item grade-dist__item--b">${gd.B}B</span>` : ''}
           ${gd.C ? `<span class="grade-dist__item grade-dist__item--c">${gd.C}C</span>` : ''}
           ${gd.ungraded ? `<span class="grade-dist__item grade-dist__item--u">${gd.ungraded}?</span>` : ''}
         </div>` : '';
    return `
      <div class="leader-row">
        <div class="leader-row__rank text-muted">${i + 1}</div>
        <div class="leader-row__info">
          <div style="display:flex;align-items:center;gap:var(--space-2);">
            <div class="leader-row__name">${r.name}</div>
            ${gradeDistHtml}
          </div>
          <div class="leader-row__terr text-xs text-${tgClass}" style="margin-bottom:2px;">
            ${tgText} territory vs LY
          </div>
          <div class="leader-row__bar">${progressBar(r.percentage, pc)}</div>
        </div>
        <div class="leader-row__nums">
          <div class="leader-row__actual">${fmt(r.actual, true)}</div>
          <div class="leader-row__pct text-${pc === 'muted' ? 'muted' : pc}">
            ${r.percentage !== null ? r.percentage + '%' : '—'}
          </div>
        </div>
      </div>`;
  }).join('');

  // Total row
  const tpc = pctClass(totals.percentage);
  const totalRow = `
    <div class="leader-row leader-row--total">
      <div class="leader-row__rank"></div>
      <div class="leader-row__info">
        <div class="leader-row__name fw-bold">Total</div>
        <div class="leader-row__bar">${progressBar(totals.percentage, tpc)}</div>
      </div>
      <div class="leader-row__nums">
        <div class="leader-row__actual fw-bold">${fmt(totals.actual, true)}</div>
        <div class="leader-row__pct text-${tpc === 'muted' ? 'muted' : tpc} fw-bold">
          ${totals.percentage !== null ? totals.percentage + '%' : '—'}
        </div>
      </div>
    </div>`;

  const brandRows = brand_performance.map(b => {
    const pc = pctClass(b.percentage);
    const trendHtml = b.trend !== null
      ? `<span class="${b.trend >= 0 ? 'text-success' : 'text-danger'}">${b.trend >= 0 ? '+' : ''}${b.trend}%</span>`
      : '<span class="text-muted">—</span>';
    return `
      <tr>
        <td class="brand-td__name">${b.name}</td>
        <td class="text-right fw-bold">${fmt(b.actual, true)}</td>
        <td class="text-right text-muted">${fmt(b.target, true)}</td>
        <td class="text-right text-${pc}">${b.percentage !== null ? b.percentage + '%' : '—'}</td>
        <td class="text-right">${trendHtml}</td>
      </tr>`;
  }).join('');

  const doorRows = new_doors_by_rep
    .filter(r => r.count > 0)
    .map(r => `<div class="door-row"><span>${r.name}</span><span class="fw-bold">${r.count}</span></div>`)
    .join('') || '<p class="text-muted text-sm">None tracked yet this month.</p>';

  page.innerHTML = `
    ${freshnessBanner(d.last_updated, d.last_sync_at)}

    <div class="page-header" style="margin-top:var(--space-3);">
      <h1 class="page-title">Team</h1>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="page-subtitle">${fmtMonthLong(month)}</span>
        <button class="btn-icon-sm" onclick="refreshDashboard()" title="Refresh">↻</button>
      </div>
    </div>

    <!-- Leaderboard -->
    <div class="card" style="padding:0;">
      <div class="card-header">
        <span class="card__title" style="margin:0;">Rep Leaderboard</span>
        <span class="text-muted text-sm">vs target</span>
      </div>
      <div class="leader-list">
        ${leaderRows}
        ${totalRow}
      </div>
    </div>

    <!-- Company YTD -->
    <div class="card">
      <div class="card__title">Company YTD</div>
      <div class="stat-grid stat-grid--2" style="margin-bottom:var(--space-3);">
        <div>
          <div class="stat-num">${fmt(ytd.actual)}</div>
          <div class="stat-lbl">Actual</div>
        </div>
        <div>
          <div class="stat-num">${fmt(ytd.target)}</div>
          <div class="stat-lbl">Target</div>
        </div>
      </div>
      ${progressBar(ytd.percentage)}
    </div>

    <!-- Company Territory Growth -->
    ${(() => {
      const ctg = company_territory_growth || {};
      const tgPct = ctg.growth_pct;
      const tgClass = tgPct === null ? 'muted' : tgPct >= 0 ? 'success' : 'danger';
      const tgLabel = tgPct === null ? '—' : `${tgPct >= 0 ? '+' : ''}${tgPct}%`;
      return ctg.store_count > 0
        ? `<div class="card">
            <div class="card__title">Territory Growth</div>
            <div class="tg-row">
              <div class="tg-cell">
                <div class="stat-num">${fmt(ctg.current)}</div>
                <div class="stat-lbl">This Month</div>
              </div>
              <div class="tg-badge-wrap">
                <span class="tg-badge tg-badge--${tgClass}">${tgLabel}</span>
              </div>
              <div class="tg-cell">
                <div class="stat-num text-muted">${fmt(ctg.ly)}</div>
                <div class="stat-lbl">Same Mo. LY</div>
              </div>
            </div>
            <div class="text-muted text-xs" style="margin-top:6px;">vs same month last year (by territory · ${ctg.store_count} stores assigned)</div>
          </div>`
        : `<div class="card">
            <div class="card__title">Territory Growth</div>
            <p class="text-muted text-sm">Territory data pending — store sync required.</p>
          </div>`;
    })()}

    <!-- Quarterly Grade Trend -->
    ${(() => {
      const gt = quarterly_grade_trend || {};
      const net = (gt.upgrades || 0) - (gt.downgrades || 0);
      const netClass = net > 0 ? 'success' : net < 0 ? 'danger' : 'muted';
      const netLabel = net > 0 ? `+${net}` : String(net);
      return `<div class="card">
        <div class="card__title">Grade Changes This Quarter</div>
        <div class="grade-trend-row">
          <div class="grade-trend-cell">
            <div class="grade-trend-num text-success">${gt.upgrades || 0}</div>
            <div class="grade-trend-lbl">↑ Upgrades</div>
          </div>
          <div class="grade-trend-cell">
            <div class="grade-trend-num text-${netClass}">${netLabel}</div>
            <div class="grade-trend-lbl">Net</div>
          </div>
          <div class="grade-trend-cell">
            <div class="grade-trend-num text-danger">${gt.downgrades || 0}</div>
            <div class="grade-trend-lbl">↓ Downgrades</div>
          </div>
        </div>
        <div class="text-xs text-muted" style="margin-top:4px;">Since ${gt.quarter_start || 'start of quarter'}</div>
      </div>`;
    })()}

    <!-- Company sparkline -->
    <div class="card">
      <div class="card__title">Company Revenue — Last 18 Months</div>
      <div class="chart-wrap">
        <canvas id="chart-monthly"></canvas>
      </div>
    </div>

    <!-- Brand performance -->
    <div class="card" style="padding:0;">
      <div class="card-header">
        <span class="card__title" style="margin:0;">Brand Performance</span>
        <span class="text-muted text-sm">${fmtMonthLong(month)}</span>
      </div>
      <div class="table-scroll">
        <table class="brand-table">
          <thead>
            <tr>
              <th>Brand</th><th class="text-right">Actual</th>
              <th class="text-right">Target</th><th class="text-right">%</th>
              <th class="text-right">vs Last Mo</th>
            </tr>
          </thead>
          <tbody>${brandRows}</tbody>
        </table>
      </div>
    </div>

    <!-- New Customers -->
    <div class="card">
      <div class="card__title">New Customers This Month</div>
      ${doorRows}
    </div>

    <!-- KPI team placeholder (filled by loadKpiTeam) -->
    <div id="kpi-team-wrap"></div>

    <!-- Alerts placeholder (filled by loadDashboardAlerts) -->
    <div id="alerts-container"><div class="skeleton-block skeleton-block--sm" style="margin-top:var(--space-4);"></div></div>`;

  renderSparkline('chart-monthly', monthly_history);
}

// ── Chart.js sparkline ────────────────────────────────────────────────────────

function renderSparkline(canvasId, history) {
  const canvas = el(canvasId);
  if (!canvas || typeof Chart === 'undefined') return;

  const labels  = history.map(h => fmtMonth(h.month));
  const actuals = history.map(h => h.actual);
  const targets = history.map(h => h.target);
  const hasTargets = targets.some(t => t > 0);

  const navy   = '#1B3A6B';
  const orange = '#E8501A';
  const grey   = 'rgba(107,114,128,0.25)';

  _dashChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Actual',
          data: actuals,
          backgroundColor: actuals.map((v, i) => {
            const t = targets[i];
            if (!t) return navy;
            const pct = (v / t) * 100;
            return pct >= 90 ? '#3DAA6E' : pct >= 70 ? '#F0B429' : '#D94F4F';
          }),
          borderRadius: 3,
          order: 2,
        },
        ...(hasTargets ? [{
          label: 'Target',
          data: targets,
          type: 'line',
          borderColor: orange,
          borderWidth: 1.5,
          borderDash: [4, 3],
          pointRadius: 0,
          fill: false,
          tension: 0,
          order: 1,
        }] : []),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: hasTargets, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw)}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: {
          grid: { color: grey },
          ticks: {
            font: { size: 10 },
            callback: v => '$' + (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v),
          },
        },
      },
    },
  });
}

// ── Pull-to-refresh setup (called from initApp) ───────────────────────────────

function setupPullToRefresh() {
  const main = document.querySelector('.app-main');
  if (!main) return;

  let startY = 0;
  let pulling = false;
  const indicator = el('pull-indicator');

  main.addEventListener('touchstart', e => {
    startY   = e.touches[0].clientY;
    pulling  = main.scrollTop <= 0;
  }, { passive: true });

  main.addEventListener('touchmove', e => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 30 && indicator) indicator.classList.remove('hidden');
  }, { passive: true });

  main.addEventListener('touchend', e => {
    if (indicator) indicator.classList.add('hidden');
    if (!pulling) return;
    const dy = e.changedTouches[0].clientY - startY;
    if (dy > 70 && currentTab === 'dashboard') refreshDashboard();
    pulling = false;
  }, { passive: true });
}

// ═══════════════════════════════════════════════════════════════════
//  VISITS
// ═══════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────
let _logVisitSelected  = null;   // { id, name, grade, channel_type, state }
let _logVisitDebounce  = null;
let _logVisitStoresAll = null;   // cached from /api/stores for the modal
let _analyticsData     = [];
let _visitSort         = { col: 'days_since', dir: 'desc' };
let _analyticsRepFilter = null;

// ── Entry point ───────────────────────────────────────────────────
async function loadVisits() {
  const isManager = ['manager', 'executive'].includes(currentUser.role);
  const page = el('page-visits');

  if (isManager) {
    page.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Visit Analytics</h1>
        <button class="btn btn--ghost btn--sm" id="btn-visits-csv" onclick="exportAnalyticsCSV()">Export CSV</button>
      </div>
      <div class="filter-row" id="analytics-filter-row">
        <select class="form-select" id="analytics-rep-filter" onchange="analyticsRepChanged(this.value)">
          <option value="">All Reps</option>
        </select>
      </div>
      <div id="analytics-wrap">
        <div class="skeleton-block"></div>
        <div class="skeleton-block skeleton-block--sm"></div>
      </div>`;

    // Populate rep filter
    const reps = await api('GET', '/api/users?role=rep');
    if (reps && !reps.error) {
      const sel = el('analytics-rep-filter');
      reps.forEach(r => {
        const o = document.createElement('option');
        o.value = r.id; o.textContent = r.name;
        sel.appendChild(o);
      });
    }

    loadManagerAnalytics();
  } else {
    page.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Visits</h1>
        <button class="btn btn--accent" id="btn-log-visit"
                style="padding:0.5rem 1rem;font-size:0.875rem;"
                onclick="openLogVisitModal()">+ Log Visit</button>
      </div>
      <div id="visits-list">
        <div class="skeleton-block"></div>
        <div class="skeleton-block skeleton-block--sm"></div>
      </div>`;

    loadRecentVisits();
  }
}

// ── Recent visits list (rep) ──────────────────────────────────────
async function loadRecentVisits() {
  const wrap = el('visits-list');
  if (!wrap) return;
  const visits = await api('GET', '/api/visits?limit=20');

  if (!visits || visits.error) {
    wrap.innerHTML = '<p class="text-muted text-sm" style="padding:var(--space-4);">Failed to load visits.</p>';
    return;
  }

  if (visits.length === 0) {
    wrap.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">📍</div>
        <div class="empty-state__title">No visits yet</div>
        <div class="empty-state__desc">Tap <strong>+ Log Visit</strong> to record your first visit.</div>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="section-label">Recent Visits</div>
    ${visits.map(v => {
      const canUndo = (Date.now() - new Date(v.created_at).getTime()) < 4.5 * 60 * 1000;
      return `
        <div class="card visit-row" id="visit-row-${v.id}">
          <div class="visit-row__top">
            <div>
              <div class="fw-bold">${v.store_name}</div>
              ${v.grade ? `<span class="grade-badge grade-badge--${v.grade.toLowerCase()}">${v.grade}</span>` : ''}
            </div>
            <div class="text-right">
              <div class="text-sm text-muted">${timeAgo(v.visited_at)}</div>
              ${canUndo ? `<button class="btn-text text-danger text-sm" onclick="undoVisit(${v.id},'${v.store_name.replace(/'/g,"\\'") }')">Undo</button>` : ''}
            </div>
          </div>
          ${v.note ? `<div class="visit-row__note text-sm text-muted">${escHtml(v.note)}</div>` : ''}
        </div>`;
    }).join('')}`;
}

// ── Log Visit Modal ────────────────────────────────────────────────
function openLogVisitModal(preselectedStore) {
  const modal = el('modal-log-visit');
  el('log-visit-search').value = '';
  el('log-visit-note').value   = '';
  el('log-visit-phase1').classList.remove('hidden');
  el('log-visit-phase2').classList.add('hidden');
  el('log-visit-back').style.visibility = 'hidden';
  el('log-visit-title').textContent     = 'Log Visit';
  el('log-visit-store-list').innerHTML  = '<p class="text-muted text-sm" style="padding:var(--space-4);">Start typing to search your stores…</p>';
  clearError('log-visit-error');
  _logVisitSelected = null;

  modal.classList.remove('hidden');

  if (preselectedStore) {
    selectLogVisitStore(preselectedStore);
  } else {
    setTimeout(() => el('log-visit-search').focus(), 100);
    // Pre-load store list
    fetchLogVisitStores('');
  }
}

function closeLogVisitModal() {
  el('modal-log-visit').classList.add('hidden');
  _logVisitSelected = null;
  _logVisitStoresAll = null;
  clearTimeout(_logVisitDebounce);
}

el('log-visit-close').addEventListener('click', closeLogVisitModal);

el('log-visit-back').addEventListener('click', () => {
  el('log-visit-phase2').classList.add('hidden');
  el('log-visit-phase1').classList.remove('hidden');
  el('log-visit-back').style.visibility = 'hidden';
  el('log-visit-title').textContent = 'Log Visit';
  _logVisitSelected = null;
});

el('log-visit-search').addEventListener('input', e => {
  clearTimeout(_logVisitDebounce);
  _logVisitDebounce = setTimeout(() => fetchLogVisitStores(e.target.value.trim()), 300);
});

async function fetchLogVisitStores(q) {
  const list = el('log-visit-store-list');
  if (!list) return;

  // Use cached data if available and no query
  if (!q && _logVisitStoresAll) {
    renderLogVisitStoreList(_logVisitStoresAll, '');
    return;
  }

  const url = q.length >= 2 ? `/api/stores?q=${encodeURIComponent(q)}&limit=10`
                             : '/api/stores?limit=30';
  const stores = await api('GET', url);
  if (!q) _logVisitStoresAll = stores; // cache unfiltered result

  if (!stores || stores.error || stores.length === 0) {
    list.innerHTML = `<p class="text-muted text-sm" style="padding:var(--space-4);">${q ? 'No stores found.' : 'No stores assigned.'}</p>`;
    return;
  }
  renderLogVisitStoreList(stores, q);
}

function renderLogVisitStoreList(stores, q) {
  const list = el('log-visit-store-list');
  list.innerHTML = stores.map(s => `
    <div class="store-pick-row" onclick="selectLogVisitStore(${JSON.stringify(s).replace(/"/g,'&quot;')})">
      <span class="grade-badge grade-badge--${(s.grade || 'c').toLowerCase()}">${s.grade || '?'}</span>
      <div class="store-pick-row__info">
        <div class="fw-bold">${escHtml(s.name)}</div>
        <div class="text-sm text-muted">${[s.channel_type, s.state].filter(Boolean).join(' · ')}</div>
      </div>
      <div class="text-sm ${visitStatusClass(s.days_since_visit)}">${visitStatusLabel(s.days_since_visit)}</div>
    </div>`).join('');
}

function selectLogVisitStore(store) {
  _logVisitSelected = store;
  el('log-visit-phase1').classList.add('hidden');
  el('log-visit-phase2').classList.remove('hidden');
  el('log-visit-back').style.visibility = 'visible';
  el('log-visit-title').textContent = 'Confirm Visit';

  el('log-visit-selected-card').innerHTML = `
    <div class="selected-store-card__inner">
      <span class="grade-badge grade-badge--${(store.grade || 'c').toLowerCase()}">${store.grade || '?'}</span>
      <div>
        <div class="fw-bold">${escHtml(store.name)}</div>
        <div class="text-sm text-muted">${[store.channel_type, store.state].filter(Boolean).join(' · ')}</div>
      </div>
    </div>`;

  el('log-visit-note').focus();
}

el('log-visit-submit').addEventListener('click', async () => {
  if (!_logVisitSelected) return;
  clearError('log-visit-error');

  const btn  = el('log-visit-submit');
  const note = el('log-visit-note').value.trim();

  btn.disabled = true;
  btn.textContent = 'Logging…';

  const result = await api('POST', '/api/visits', {
    store_id: _logVisitSelected.id,
    note:     note || null,
  });

  btn.disabled = false;
  btn.textContent = 'Log Visit';

  if (!result || result.error) {
    showError('log-visit-error', result?.error || 'Failed to log visit.');
    return;
  }

  const storeName = result.store_name;
  closeLogVisitModal();

  // Refresh visits list
  if (currentTab === 'visits') loadRecentVisits();
  // Invalidate store list cache
  _logVisitStoresAll = null;

  toast(`Visit logged — ${storeName}`, async () => {
    await undoVisit(result.id, storeName);
  }, 8000);
});

async function undoVisit(visitId, storeName) {
  const result = await api('DELETE', `/api/visits/${visitId}`);
  if (!result || result.error) {
    toast(result?.error || 'Could not undo — undo window may have expired.');
    return;
  }
  toast(`Visit to ${storeName} removed.`);
  if (currentTab === 'visits') loadRecentVisits();
}
window.undoVisit = undoVisit;

// ── Manager visit analytics ────────────────────────────────────────
async function loadManagerAnalytics(repId) {
  const wrap = el('analytics-wrap');
  if (!wrap) return;

  const url = repId ? `/api/visits/analytics?rep_id=${repId}` : '/api/visits/analytics';
  const data = await api('GET', url);

  if (!data || data.error) {
    wrap.innerHTML = '<p class="text-muted" style="padding:var(--space-4);">Failed to load analytics.</p>';
    return;
  }

  _analyticsData = data;
  renderAnalyticsTable(_analyticsData);
}

function analyticsRepChanged(repId) {
  _analyticsRepFilter = repId || null;
  loadManagerAnalytics(_analyticsRepFilter);
}
window.analyticsRepChanged = analyticsRepChanged;

function visitStatusClass(days) {
  if (days === null || days === undefined) return 'visit-status--never';
  if (days <= 30)  return 'visit-status--fresh';
  if (days <= 60)  return 'visit-status--warn';
  return 'visit-status--overdue';
}

function visitStatusLabel(days) {
  if (days === null || days === undefined) return 'Never';
  if (days === 0) return 'Today';
  if (days <= 30)  return `${days}d ago`;
  if (days <= 60)  return `${days}d ago`;
  return `${days}d ago`;
}

function visitStatusChip(days) {
  if (days === null || days === undefined) return '<span class="status-chip status-chip--never">Never</span>';
  if (days <= 30)  return `<span class="status-chip status-chip--ok">OK</span>`;
  if (days <= 60)  return `<span class="status-chip status-chip--warn">Due</span>`;
  return `<span class="status-chip status-chip--overdue">Overdue</span>`;
}

function sortAnalytics(col) {
  if (_visitSort.col === col) {
    _visitSort.dir = _visitSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    _visitSort.col = col;
    _visitSort.dir = col === 'days_since' ? 'desc' : 'asc';
  }
  renderAnalyticsTable(_analyticsData);
}
window.sortAnalytics = sortAnalytics;

function renderAnalyticsTable(data) {
  const wrap = el('analytics-wrap');
  if (!wrap) return;

  const sorted = [...data].sort((a, b) => {
    let av = a[_visitSort.col], bv = b[_visitSort.col];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === 'string') av = av.toLowerCase(), bv = bv.toLowerCase();
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return _visitSort.dir === 'asc' ? cmp : -cmp;
  });

  const arrow = col =>
    _visitSort.col === col ? (_visitSort.dir === 'asc' ? ' ▲' : ' ▼') : '';

  wrap.innerHTML = `
    <div class="table-scroll">
      <table class="analytics-table">
        <thead>
          <tr>
            <th onclick="sortAnalytics('name')">Store${arrow('name')}</th>
            <th onclick="sortAnalytics('rep_name')">Rep${arrow('rep_name')}</th>
            <th onclick="sortAnalytics('grade')">Grade${arrow('grade')}</th>
            <th onclick="sortAnalytics('days_since_visit')">Last Visit${arrow('days_since_visit')}</th>
            <th onclick="sortAnalytics('days_since_visit')">Days${arrow('days_since_visit')}</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(r => `
            <tr onclick="openStoreDetail(${r.id})" style="cursor:pointer;">
              <td class="fw-bold">${escHtml(r.name)}</td>
              <td class="text-muted">${escHtml(r.rep_name || '—')}</td>
              <td><span class="grade-badge grade-badge--${(r.grade || 'c').toLowerCase()}">${r.grade || '—'}</span></td>
              <td class="text-sm">${r.last_visit_at ? new Date(r.last_visit_at).toLocaleDateString('en-AU') : '—'}</td>
              <td class="${visitStatusClass(r.days_since_visit)}">${r.days_since_visit !== null ? r.days_since_visit : '—'}</td>
              <td>${visitStatusChip(r.days_since_visit)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function exportAnalyticsCSV() {
  if (!_analyticsData.length) return;
  const headers = ['Store', 'Rep', 'Grade', 'State', 'Last Visit', 'Days Since', 'Status', 'Visit Count'];
  const rows = _analyticsData.map(r => [
    csvEsc(r.name), csvEsc(r.rep_name || ''), r.grade || '',
    r.state || '',
    r.last_visit_at ? new Date(r.last_visit_at).toLocaleDateString('en-AU') : '',
    r.days_since_visit ?? '',
    r.days_since_visit === null ? 'Never' : r.days_since_visit <= 30 ? 'OK' : r.days_since_visit <= 60 ? 'Due' : 'Overdue',
    r.visit_count || 0,
  ]);

  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `visit-analytics-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
window.exportAnalyticsCSV = exportAnalyticsCSV;

function csvEsc(s) {
  if (!s) return '';
  const str = String(s);
  return str.includes(',') || str.includes('"') || str.includes('\n')
    ? `"${str.replace(/"/g, '""')}"` : str;
}

// ═══════════════════════════════════════════════════════════════════
//  STORES
// ═══════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────
let _storesView         = 'list';   // 'list' | 'new-doors' | 'grade-review'
let _storesSearch       = '';
let _storesGrade        = '';
let _storesState        = '';
let _storesVisitStatus  = '';
let _storesRepFilter    = '';
let _storesShowProspects = false;
let _storesCurrentId    = null;
let _storesCurrentData  = null;  // full store object from /api/stores/:id
let _newDoorsMonth      = null;

// ── Entry point ────────────────────────────────────────────────────
async function loadStores() {
  const page = el('page-stores');
  const isManager = ['manager', 'executive'].includes(currentUser.role);

  // Reset search state on fresh load
  _storesSearch = ''; _storesGrade = ''; _storesState = '';
  _storesVisitStatus = ''; _storesRepFilter = ''; _storesShowProspects = false;

  page.innerHTML = `
    <!-- View toggle -->
    <div class="page-header" style="margin-bottom:0;">
      <div class="view-toggle">
        <button class="view-toggle__btn ${_storesView === 'list' ? 'active' : ''}" onclick="switchStoresView('list')">Stores</button>
        <button class="view-toggle__btn ${_storesView === 'new-doors' ? 'active' : ''}" onclick="switchStoresView('new-doors')">New Customers</button>
        ${isManager ? `<button class="view-toggle__btn ${_storesView === 'grade-review' ? 'active' : ''}" onclick="switchStoresView('grade-review')">Grade Review</button>` : ''}
      </div>
    </div>

    <!-- Store list view -->
    <div id="stores-list-view" class="${_storesView !== 'list' ? 'hidden' : ''}">
      <div class="filter-row" id="stores-filter-row">
        <input id="stores-search" type="search" class="form-input filter-search"
               placeholder="Search stores…" value="${_storesSearch}" oninput="storesSearchChanged(this.value)" autocomplete="off">
        <select class="form-select filter-select" onchange="storesFilterChanged('grade', this.value)">
          <option value="">All Grades</option>
          <option value="A">A</option><option value="B">B</option><option value="C">C</option>
        </select>
        <select class="form-select filter-select" onchange="storesFilterChanged('visit_status', this.value)">
          <option value="">All Status</option>
          <option value="ok">OK (≤30d)</option>
          <option value="amber">Due (31–60d)</option>
          <option value="overdue">Overdue / Never</option>
        </select>
        ${isManager ? `
          <select class="form-select filter-select" id="stores-rep-filter" onchange="storesFilterChanged('rep', this.value)">
            <option value="">All Reps</option>
          </select>
          <button class="filter-prospect-btn ${_storesShowProspects ? 'active' : ''}"
                  id="prospect-toggle-btn"
                  onclick="storesFilterChanged('prospects', null)">
            ${_storesShowProspects ? 'Prospects' : 'Prospects'}
          </button>` : ''}
      </div>
      <div id="stores-list">
        <div class="skeleton-block"></div>
        <div class="skeleton-block skeleton-block--sm"></div>
      </div>
    </div>

    <!-- New Customers view -->
    <div id="new-doors-view" class="${_storesView !== 'new-doors' ? 'hidden' : ''}">
      <div id="new-doors-content">
        <div class="skeleton-block"></div>
        <div class="skeleton-block skeleton-block--sm"></div>
      </div>
    </div>

    <!-- Grade Review view (managers only) -->
    ${isManager ? `<div id="grade-review-view" class="${_storesView !== 'grade-review' ? 'hidden' : ''}">
      <div id="grade-review-content">
        <div class="skeleton-block"></div>
        <div class="skeleton-block skeleton-block--sm"></div>
      </div>
    </div>` : ''}
  `;

  // Populate rep filter for managers
  if (isManager) {
    const reps = await api('GET', '/api/users?role=rep');
    if (reps && !reps.error) {
      const sel = el('stores-rep-filter');
      if (sel) reps.forEach(r => {
        const o = document.createElement('option');
        o.value = r.id; o.textContent = r.name;
        sel.appendChild(o);
      });
    }
  }

  if (_storesView === 'list') {
    loadStoreList();
  } else if (_storesView === 'grade-review') {
    loadGradeReview();
  } else {
    loadNewDoors(_newDoorsMonth);
  }
}

function switchStoresView(view) {
  _storesView = view;
  const listView    = el('stores-list-view');
  const doorsView   = el('new-doors-view');
  const gradeView   = el('grade-review-view');
  document.querySelectorAll('.view-toggle__btn').forEach(b => {
    const t = b.textContent.trim();
    const isActive = (view === 'list' && t === 'Stores') ||
                     (view === 'new-doors' && t === 'New Customers') ||
                     (view === 'grade-review' && t === 'Grade Review');
    b.classList.toggle('active', isActive);
  });
  listView?.classList.toggle('hidden', view !== 'list');
  doorsView?.classList.toggle('hidden', view !== 'new-doors');
  gradeView?.classList.toggle('hidden', view !== 'grade-review');
  if (view === 'list') {
    loadStoreList();
  } else if (view === 'grade-review') {
    loadGradeReview();
  } else {
    loadNewDoors(_newDoorsMonth);
  }
}
window.switchStoresView = switchStoresView;

let _storesSearchDebounce = null;
function storesSearchChanged(v) {
  _storesSearch = v;
  clearTimeout(_storesSearchDebounce);
  _storesSearchDebounce = setTimeout(loadStoreList, 300);
}
window.storesSearchChanged = storesSearchChanged;

function storesFilterChanged(key, value) {
  if (key === 'grade')        _storesGrade       = value;
  if (key === 'visit_status') _storesVisitStatus = value;
  if (key === 'rep')          _storesRepFilter   = value;
  if (key === 'prospects') {
    _storesShowProspects = !_storesShowProspects;
    const btn = el('prospect-toggle-btn');
    if (btn) btn.classList.toggle('active', _storesShowProspects);
  }
  loadStoreList();
}
window.storesFilterChanged = storesFilterChanged;

async function loadStoreList() {
  const wrap = el('stores-list');
  if (!wrap) return;
  wrap.innerHTML = '<div class="skeleton-block"></div>';

  const params = new URLSearchParams();
  if (_storesSearch)        params.set('q', _storesSearch);
  if (_storesGrade && !_storesShowProspects) params.set('grade', _storesGrade);
  if (_storesVisitStatus && !_storesShowProspects) params.set('visit_status', _storesVisitStatus);
  if (_storesRepFilter)     params.set('rep_id', _storesRepFilter);
  if (_storesShowProspects) params.set('show_prospects', 'true');

  const stores = await api('GET', `/api/stores?${params}`);

  if (!stores || stores.error) {
    wrap.innerHTML = '<p class="text-muted" style="padding:var(--space-4);">Failed to load stores.</p>';
    return;
  }

  if (stores.length === 0) {
    wrap.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">🏪</div>
        <div class="empty-state__title">No stores found</div>
        <div class="empty-state__desc">${_storesSearch ? 'Try a different search.' : 'Stores sync from Zoho every 60 minutes.'}</div>
      </div>`;
    return;
  }

  const isManager = ['manager', 'executive'].includes(currentUser.role);

  const countLabel = _storesShowProspects
    ? `${stores.length} prospect${stores.length !== 1 ? 's' : ''}`
    : `${stores.length} store${stores.length !== 1 ? 's' : ''}`;

  wrap.innerHTML = `
    <div class="section-label">${countLabel}</div>
    ${stores.map(s => `
      <div class="card store-row" onclick="openStoreDetail(${s.id})">
        <div class="store-row__main">
          <span class="grade-badge grade-badge--${s.is_prospect ? 'p' : (s.grade || 'c').toLowerCase()}">${s.is_prospect ? 'P' : (s.grade || '?')}</span>
          <div class="store-row__info">
            <div class="store-row__name">${escHtml(s.name)}</div>
            <div class="store-row__sub text-sm text-muted">
              ${[s.channel_type, s.state].filter(Boolean).join(' · ')}
              ${isManager && s.rep_name ? ` · ${escHtml(s.rep_name)}` : ''}
            </div>
          </div>
          <div class="store-row__visit">
            ${s.is_prospect ? '' : `
              <div class="text-sm ${visitStatusClass(s.days_since_visit)} fw-bold">
                ${visitStatusLabel(s.days_since_visit)}
              </div>
              ${s.last_visit_at ? `<div class="text-xs text-muted">${new Date(s.last_visit_at).toLocaleDateString('en-AU', { day:'numeric', month:'short'})}</div>` : ''}`}
          </div>
        </div>
      </div>`).join('')}`;
}

// ── Store Detail Sheet ────────────────────────────────────────────
async function openStoreDetail(storeId) {
  _storesCurrentId = storeId;
  const sheet = el('modal-store-detail');
  const body  = el('store-detail-body');

  // Reset and open
  el('store-detail-name').textContent  = 'Loading…';
  el('store-detail-meta').textContent  = '';
  el('store-detail-grade').textContent = '';
  el('store-detail-grade').className   = 'grade-badge';
  body.innerHTML = '<div class="skeleton-block"></div><div class="skeleton-block skeleton-block--sm"></div>';
  sheet.classList.remove('hidden');
  sheet.classList.add('open');

  const data = await api('GET', `/api/stores/${storeId}`);

  if (!data || data.error) {
    body.innerHTML = `<p class="text-muted" style="padding:var(--space-4);">${data?.error || 'Failed to load store.'}</p>`;
    return;
  }

  _storesCurrentData = data;
  el('store-detail-name').textContent  = data.name;
  el('store-detail-meta').textContent  = [data.channel_type, data.state, data.rep_name].filter(Boolean).join(' · ');
  if (data.is_prospect) {
    el('store-detail-grade').textContent = 'P';
    el('store-detail-grade').className   = 'grade-badge grade-badge--p grade-badge--lg';
    el('store-detail-grade').title       = 'Prospect — no orders or visits in 24 months';
  } else if (data.grade) {
    el('store-detail-grade').textContent = data.grade;
    el('store-detail-grade').className   = `grade-badge grade-badge--${data.grade.toLowerCase()} grade-badge--lg`;
    if (data.grade_locked) {
      el('store-detail-grade').title = 'Grade locked — will not change automatically';
    }
  } else {
    el('store-detail-grade').textContent = '?';
    el('store-detail-grade').className   = 'grade-badge grade-badge--c grade-badge--lg';
  }

  const trendHtml = data.trend_pct !== null
    ? `<span class="${data.trend_pct >= 0 ? 'text-success' : 'text-danger'}">${data.trend_pct >= 0 ? '+' : ''}${data.trend_pct}%</span>`
    : '<span class="text-muted">—</span>';

  const visitHistHtml = data.visit_history.length === 0
    ? '<p class="text-muted text-sm">No visits recorded in this app yet.</p>'
    : data.visit_history.map(v => `
        <div class="visit-hist-row">
          <div class="text-sm fw-bold">${new Date(v.visited_at).toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' })}</div>
          <div class="text-sm text-muted">${escHtml(v.rep_name)}</div>
          ${v.note ? `<div class="text-sm visit-hist-note">${escHtml(v.note)}</div>` : ''}
        </div>`).join('');

  body.innerHTML = `
    <!-- Revenue -->
    <div class="section-label">Revenue (Last 12 Months)</div>
    <div class="stat-grid stat-grid--3" style="margin-bottom:var(--space-4);">
      <div class="card stat-mini">
        <div class="stat-mini__val">${fmt(data.revenue_12m, true)}</div>
        <div class="stat-mini__lbl">12m Total</div>
      </div>
      <div class="card stat-mini">
        <div class="stat-mini__val">${trendHtml}</div>
        <div class="stat-mini__lbl">H2 vs H1</div>
      </div>
      <div class="card stat-mini">
        <div class="stat-mini__val">${data.sku_count}</div>
        <div class="stat-mini__lbl">SKUs</div>
      </div>
    </div>

    <!-- Order info + grade lock -->
    <div class="card" style="padding:var(--space-3);">
      <div class="detail-kv-row">
        <span class="text-muted text-sm">Last Order</span>
        <span class="text-sm fw-bold">${data.last_order_date
          ? new Date(data.last_order_date).toLocaleDateString('en-AU', {day:'numeric',month:'short',year:'numeric'})
          : '—'}</span>
      </div>
      <div class="detail-kv-row">
        <span class="text-muted text-sm">Last Visit</span>
        <span class="text-sm fw-bold">${data.visit_history[0]
          ? new Date(data.visit_history[0].visited_at).toLocaleDateString('en-AU', {day:'numeric',month:'short',year:'numeric'})
          : '—'}</span>
      </div>
      <div class="detail-kv-row">
        <span class="text-muted text-sm">Last Visit Note</span>
        <span class="text-sm">${data.visit_history[0]?.note ? escHtml(data.visit_history[0].note) : '—'}</span>
      </div>
      ${['manager','executive'].includes(currentUser.role) && data.is_prospect ? `
      <div class="detail-kv-row" style="margin-top:var(--space-2);padding-top:var(--space-2);border-top:1px solid var(--color-border);">
        <span class="text-muted text-sm">No invoice or visit history</span>
        <button class="prospect-convert-btn" onclick="convertProspect(${data.id})">
          Convert to Customer
        </button>
      </div>` : ''}
      ${['manager','executive'].includes(currentUser.role) && !data.is_prospect ? `
      <div class="detail-kv-row" style="margin-top:var(--space-2);padding-top:var(--space-2);border-top:1px solid var(--color-border);">
        <span class="text-muted text-sm">${data.grade_locked ? '🔒 Grade Locked' : '🔓 Grade Unlocked'}</span>
        <button class="store-lock-btn ${data.grade_locked ? 'store-lock-btn--locked' : ''}"
                id="grade-lock-btn"
                onclick="toggleGradeLock(${data.id}, ${data.grade_locked})">
          ${data.grade_locked ? 'Unlock' : 'Lock Grade'}
        </button>
      </div>` : ''}
    </div>

    <!-- Visit history -->
    <div class="section-label">Visit History</div>
    <div class="card" style="padding:var(--space-3);">
      ${visitHistHtml}
    </div>

    <!-- Grade history -->
    ${data.grade_history && data.grade_history.length > 0 ? `
    <div class="section-label">Grade History</div>
    <div class="card" style="padding:var(--space-3);">
      ${data.grade_history.map(h => `
        <div class="grade-hist-row">
          <div class="grade-hist-badges">
            ${h.old_grade ? `<span class="grade-badge grade-badge--${h.old_grade.toLowerCase()}">${h.old_grade}</span>` : '<span class="grade-badge grade-badge--c">—</span>'}
            <span class="grade-hist-arrow">→</span>
            ${h.new_grade ? `<span class="grade-badge grade-badge--${h.new_grade.toLowerCase()}">${h.new_grade}</span>` : '<span class="grade-badge grade-badge--c">—</span>'}
          </div>
          <div class="grade-hist-info">
            <div class="text-sm">${escHtml(h.reason || '')}</div>
            <div class="text-xs text-muted">
              ${new Date(h.changed_at).toLocaleDateString('en-AU', {day:'numeric',month:'short',year:'numeric'})}
              · ${escHtml(h.changed_by || 'system')}
              ${h.locked ? ' · 🔒' : ''}
            </div>
          </div>
        </div>`).join('')}
    </div>` : ''}

    <!-- Behaviour (managers only — loaded async) -->
    <div id="store-behaviour-wrap"></div>`;

  // Load buying behaviour classification for managers
  if (['manager', 'executive'].includes(currentUser.role)) {
    loadStoreBehaviour(storeId);
  }
}

function closeStoreDetail() {
  const sheet = el('modal-store-detail');
  sheet.classList.remove('open');
  setTimeout(() => sheet.classList.add('hidden'), 300);
  _storesCurrentId   = null;
  _storesCurrentData = null;
}

el('store-detail-close').addEventListener('click', closeStoreDetail);
el('store-detail-log-btn').addEventListener('click', () => {
  const storeData = _storesCurrentData;
  closeStoreDetail();
  setTimeout(() => {
    if (storeData) openLogVisitModal(storeData);
  }, 350);
});

window.openStoreDetail = openStoreDetail;

async function toggleGradeLock(storeId, currentlyLocked) {
  const btn = el('grade-lock-btn');
  if (btn) btn.disabled = true;

  const newLocked = !currentlyLocked;
  const result = await api('PATCH', `/api/stores/${storeId}/lock-grade`, { locked: newLocked });

  if (!result || result.error) {
    if (btn) btn.disabled = false;
    alert('Failed to update grade lock. Please try again.');
    return;
  }

  // Refresh store detail to show updated state
  openStoreDetail(storeId);
}
window.toggleGradeLock = toggleGradeLock;

async function convertProspect(storeId) {
  if (!confirm('Convert this prospect to an active customer? They will be assigned grade C.')) return;

  const result = await api('POST', `/api/stores/${storeId}/convert-prospect`);
  if (!result || result.error) {
    alert(result?.error || 'Failed to convert prospect. Please try again.');
    return;
  }

  // Refresh store detail to show grade C
  openStoreDetail(storeId);
}
window.convertProspect = convertProspect;

// ── New Doors ─────────────────────────────────────────────────────
async function loadNewDoors(month) {
  const now = new Date();
  const curM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (!month) month = curM;
  _newDoorsMonth = month;

  const wrap = el('new-doors-content');
  if (!wrap) return;
  wrap.innerHTML = '<div class="skeleton-block"></div>';

  const isManager = ['manager', 'executive'].includes(currentUser.role);

  const params = new URLSearchParams({ month });
  if (_storesRepFilter) params.set('rep_id', _storesRepFilter);
  const data = await api('GET', `/api/stores/new-doors?${params}`);

  if (!data || data.error) {
    wrap.innerHTML = '<p class="text-muted" style="padding:var(--space-4);">Failed to load new doors.</p>';
    return;
  }

  const monthSel = `
    <div style="display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-4);">
      <label class="form-label" style="margin:0;">Month</label>
      <input type="month" class="form-input" style="width:auto;"
             value="${month}" max="${curM}" onchange="loadNewDoors(this.value)">
    </div>`;

  const summaryCard = `
    <div class="card dash-hero" style="text-align:center;padding:var(--space-6);">
      <div class="dash-hero__actual">${data.totals.count}</div>
      <div class="dash-hero__target text-muted">New Customers in ${fmtMonthLong(month)}</div>
      <div class="text-sm text-muted" style="margin-top:var(--space-2);">Total value: ${fmt(data.totals.value)}</div>
    </div>`;

  if (data.doors.length === 0) {
    wrap.innerHTML = monthSel + summaryCard + `
      <div class="empty-state">
        <div class="empty-state__icon">🏪</div>
        <div class="empty-state__title">No new customers</div>
        <div class="empty-state__desc">No new customers invoiced in ${fmtMonthLong(month)} (based on last 12 months of history).</div>
      </div>`;
    return;
  }

  // Group by rep for managers
  let doorsHtml = '';
  if (isManager) {
    const byRep = {};
    for (const d of data.doors) {
      const k = d.rep_name || '—';
      if (!byRep[k]) byRep[k] = [];
      byRep[k].push(d);
    }
    for (const [repName, doors] of Object.entries(byRep).sort()) {
      doorsHtml += `<div class="section-label">${escHtml(repName)} (${doors.length})</div>`;
      doorsHtml += doors.map(d => newDoorCard(d)).join('');
    }
  } else {
    doorsHtml = data.doors.map(d => newDoorCard(d)).join('');
  }

  wrap.innerHTML = monthSel + summaryCard + doorsHtml;
}
window.loadNewDoors = loadNewDoors;

function newDoorCard(d) {
  return `
    <div class="card new-door-card" ${d.store_id ? `onclick="openStoreDetail(${d.store_id})" style="cursor:pointer;"` : ''}>
      <div style="display:flex;align-items:flex-start;gap:var(--space-3);">
        ${d.grade ? `<span class="grade-badge grade-badge--${d.grade.toLowerCase()}">${d.grade}</span>` : '<span class="grade-badge grade-badge--c">?</span>'}
        <div style="flex:1;">
          <div class="fw-bold">${escHtml(d.customer_name)}</div>
          ${d.state ? `<div class="text-sm text-muted">${escHtml(d.state)}</div>` : ''}
        </div>
        <div class="text-right">
          <div class="text-sm fw-bold">${fmt(d.first_order_value, true)}</div>
          <div class="text-xs text-muted">${d.first_order_date ? new Date(d.first_order_date).toLocaleDateString('en-AU', {day:'numeric',month:'short'}) : ''}</div>
        </div>
      </div>
    </div>`;
}

// ── Grade Review ──────────────────────────────────────────────────

async function loadGradeReview() {
  const wrap = el('grade-review-content');
  if (!wrap) return;
  wrap.innerHTML = '<div class="skeleton-block"></div><div class="skeleton-block skeleton-block--sm"></div>';

  const data = await api('GET', '/api/stores/grade-review');
  if (!data || data.error) {
    wrap.innerHTML = '<p class="text-muted" style="padding:16px;">Failed to load grade review.</p>';
    return;
  }

  const { upgrades, downgrades, visit_mismatch, summary } = data;

  function gradeArrow(cur, sug) {
    const up   = (cur === 'B' && sug === 'A') || (cur === 'C' && sug !== 'C');
    const down = (cur === 'A' && sug !== 'A') || (cur === 'B' && sug === 'C');
    return up ? '↑' : down ? '↓' : '→';
  }

  function grBadge(g, cls = '') {
    if (!g) return `<span class="grade-badge grade-badge--c" ${cls}>?</span>`;
    return `<span class="grade-badge grade-badge--${g.toLowerCase()}" ${cls}>${g}</span>`;
  }

  function grRow(r, showVisit = false) {
    const arrow = gradeArrow(r.current_grade, r.suggested_grade);
    const arrowClass = arrow === '↑' ? 'gr-arrow--up' : arrow === '↓' ? 'gr-arrow--down' : '';
    const vmBadge = showVisit && r.visit_mismatch
      ? `<span class="gr-vm-badge gr-vm-badge--${r.visit_mismatch_direction}">${r.visit_mismatch_direction === 'under' ? 'Under-visited' : 'Over-visited'}</span>`
      : '';
    return `
      <div class="gr-row card" ${r.store_id ? `onclick="openStoreDetail(${r.store_id})" style="cursor:pointer;"` : ''}>
        <div class="gr-row__grades">
          ${grBadge(r.current_grade)}
          <span class="gr-arrow ${arrowClass}">${arrow}</span>
          ${grBadge(r.suggested_grade)}
        </div>
        <div class="gr-row__info">
          <div class="gr-row__name">${escHtml(r.name)}</div>
          <div class="gr-row__sub">${r.state ? escHtml(r.state) + ' · ' : ''}${r.rep_name ? escHtml(r.rep_name) : ''}</div>
        </div>
        <div class="gr-row__metrics">
          <div class="gr-metric"><span class="gr-metric__val">${fmt(r.metrics.revenue_12m, true)}</span><span class="gr-metric__lbl">12m rev</span></div>
          <div class="gr-metric"><span class="gr-metric__val">${r.metrics.order_count}</span><span class="gr-metric__lbl">orders</span></div>
          <div class="gr-metric"><span class="gr-metric__val">${r.metrics.sku_depth}</span><span class="gr-metric__lbl">SKUs</span></div>
          <div class="gr-metric"><span class="gr-metric__val">${r.metrics.visit_count}</span><span class="gr-metric__lbl">visits</span></div>
        </div>
        ${vmBadge}
      </div>`;
  }

  function grSection(title, rows, emptyMsg, showVisit = false, colorClass = '') {
    return `
      <div class="gr-section">
        <div class="gr-section__header ${colorClass}">
          <span class="gr-section__title">${title}</span>
          <span class="gr-section__count">${rows.length}</span>
        </div>
        ${rows.length
          ? rows.map(r => grRow(r, showVisit)).join('')
          : `<p class="text-muted text-sm" style="padding:12px 16px;">${emptyMsg}</p>`}
      </div>`;
  }

  wrap.innerHTML = `
    <div class="gr-summary">
      <div class="gr-summary__item gr-summary__item--up">
        <span class="gr-summary__num">${summary.upgrades}</span>
        <span class="gr-summary__lbl">Possible upgrades</span>
      </div>
      <div class="gr-summary__item gr-summary__item--down">
        <span class="gr-summary__num">${summary.downgrades}</span>
        <span class="gr-summary__lbl">Possible downgrades</span>
      </div>
      <div class="gr-summary__item gr-summary__item--vm">
        <span class="gr-summary__num">${summary.visit_mismatch}</span>
        <span class="gr-summary__lbl">Visit mismatch</span>
      </div>
    </div>
    <p class="text-xs text-muted" style="padding:4px 16px 8px;">Based on rolling 12-month revenue, order frequency, SKU depth, and visit count.</p>
    ${grSection('Possible Upgrades ↑', upgrades, 'No upgrade candidates.', false, 'gr-section__header--up')}
    ${grSection('Possible Downgrades ↓', downgrades, 'No downgrade candidates.', false, 'gr-section__header--down')}
    ${grSection('Visit Frequency Mismatch', visit_mismatch, 'No visit mismatches.', true, '')}
  `;
}
window.loadGradeReview = loadGradeReview;

// ── Shared utilities ──────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Targets ───────────────────────────────────────────────────────────────────
async function loadTargets() {
  const wrap = el('target-grid-wrap');
  wrap.innerHTML = '<div class="skeleton-block" style="margin:16px;height:120px;"></div>';

  // Fetch reps and targets in parallel
  const [reps, allTargets] = await Promise.all([
    api('GET', '/api/users?role=rep'),
    api('GET', '/api/targets/rep'),
  ]);

  if (!reps || !allTargets) {
    wrap.innerHTML = '<p class="text-muted" style="padding:16px;">Failed to load targets.</p>';
    return;
  }

  targetReps   = reps;
  targetMonths = getRollingMonths();
  targetMap    = {};
  prevYearMap  = {};

  // Build lookup maps
  allTargets.forEach(t => {
    targetMap[`${t.rep_id}-${t.month}`] = parseFloat(t.amount);
  });

  // For previous-year reference, also include prior-year data from allTargets
  // (those months won't be in rolling 12, so we already have them via the same endpoint)
  allTargets.forEach(t => {
    // Check if this month corresponds to a prev-year reference for our rolling 12
    targetMonths.forEach(m => {
      if (prevYearMonth(m) === t.month && t.rep_id) {
        prevYearMap[`${t.rep_id}-${m}`] = parseFloat(t.amount);
      }
    });
  });

  renderTargetGrid(wrap);
  renderBrandTargets();
  loadIncentiveTargets(targetReps);
}

function renderTargetGrid(wrap) {
  if (targetReps.length === 0) {
    wrap.innerHTML = '<p class="text-muted" style="padding:16px;">No reps found. Add users in the Team tab.</p>';
    return;
  }

  const rows = targetReps.map(rep => {
    const cells = targetMonths.map(month => {
      const key   = `${rep.id}-${month}`;
      const amt   = targetMap[key];
      const prev  = prevYearMap[key];
      return `
        <td class="tg-cell" data-rep="${rep.id}" data-month="${month}" data-amount="${amt ?? ''}">
          <div class="tg-cell__val">${amt !== undefined ? fmt(amt, true) : '<span class="tg-cell__empty">—</span>'}</div>
          ${prev !== undefined ? `<div class="tg-cell__ref">${fmt(prev, true)}</div>` : ''}
        </td>`;
    }).join('');

    return `<tr>
      <th class="tg-rep">${rep.name}</th>
      ${cells}
    </tr>`;
  }).join('');

  const headers = targetMonths.map(m =>
    `<th class="tg-month">${fmtMonth(m)}</th>`
  ).join('');

  wrap.innerHTML = `
    <div class="tg-scroll">
      <table class="tg-table">
        <thead>
          <tr>
            <th class="tg-rep tg-rep--head">Rep</th>
            ${headers}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  // Attach tap handlers
  wrap.querySelectorAll('.tg-cell').forEach(cell => {
    cell.addEventListener('click', () => beginEditCell(cell));
  });
}

function beginEditCell(cell) {
  if (cell.querySelector('input')) return; // already editing

  const repId  = cell.dataset.rep;
  const month  = cell.dataset.month;
  const oldAmt = cell.dataset.amount !== '' ? parseFloat(cell.dataset.amount) : '';

  cell.innerHTML = `<input class="tg-input" type="number" min="0" step="100"
    value="${oldAmt}" placeholder="0" inputmode="numeric">`;

  const input = cell.querySelector('input');
  input.focus();
  input.select();

  async function commit() {
    const raw = input.value.trim();
    const newAmt = raw === '' ? null : parseFloat(raw);

    // Restore old display while saving
    cell.innerHTML = `<div class="tg-cell__val">${newAmt !== null ? fmt(newAmt, true) : '<span class="tg-cell__empty">—</span>'}</div>`;

    if (newAmt === oldAmt || (newAmt === null && oldAmt === '')) return;

    // Optimistic update
    const key = `${repId}-${month}`;
    const prevVal = targetMap[key];
    if (newAmt !== null) {
      targetMap[key] = newAmt;
    } else {
      delete targetMap[key];
    }
    cell.dataset.amount = newAmt ?? '';

    // Save to API
    const result = await api('POST', '/api/targets/rep', {
      rep_id: parseInt(repId),
      month,
      amount: newAmt ?? 0,
    });

    if (!result || result.error) {
      // Revert on error
      if (prevVal !== undefined) { targetMap[key] = prevVal; }
      else { delete targetMap[key]; }
      cell.dataset.amount = prevVal ?? '';
      cell.innerHTML = `<div class="tg-cell__val">${prevVal !== undefined ? fmt(prevVal, true) : '<span class="tg-cell__empty">—</span>'}</div>`;
      toast('Failed to save. Please try again.');
      return;
    }

    const repName = targetReps.find(r => r.id === parseInt(repId))?.name || 'Rep';
    const label   = `${repName} · ${fmtMonth(month)} → ${fmt(newAmt ?? 0)}`;

    toast(label, async () => {
      // Undo: restore previous value
      const undoAmt = prevVal ?? 0;
      await api('POST', '/api/targets/rep', {
        rep_id: parseInt(repId),
        month,
        amount: undoAmt,
      });
      if (prevVal !== undefined) { targetMap[key] = prevVal; }
      else { delete targetMap[key]; }
      cell.dataset.amount = prevVal ?? '';
      cell.innerHTML = `<div class="tg-cell__val">${prevVal !== undefined ? fmt(prevVal, true) : '<span class="tg-cell__empty">—</span>'}</div>`;
    });
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { input.blur(); }
    if (e.key === 'Escape') {
      cell.innerHTML = `<div class="tg-cell__val">${oldAmt !== '' ? fmt(oldAmt, true) : '<span class="tg-cell__empty">—</span>'}</div>`;
    }
  });
}

function renderBrandTargets() {
  const wrap = el('brand-targets-list');
  wrap.innerHTML = `
    <div class="card">
      <p class="text-muted" style="font-size:0.875rem;">Brand target management coming in a later update.</p>
    </div>`;
}

// ── Admin / User Management ───────────────────────────────────────────────────
async function loadAdmin() {
  const list = el('user-list');
  list.innerHTML = '<div class="skeleton-block"></div>';

  const users = await api('GET', '/api/users');
  if (!users || users.error) {
    list.innerHTML = '<p class="text-muted">Failed to load users.</p>';
    return;
  }

  usersCache = users;

  if (users.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">👥</div>
        <div class="empty-state__title">No users yet</div>
        <div class="empty-state__desc">Add team members to get started.</div>
      </div>`;
    return;
  }

  const roleBadge = r => {
    const cls = { rep: 'badge-role--rep', manager: 'badge-role--manager', executive: 'badge-role--exec' }[r] || '';
    return `<span class="badge-role ${cls}">${r}</span>`;
  };

  list.innerHTML = users.map(u => `
    <div class="user-row card">
      <div class="user-row__info">
        <div class="user-row__name">${u.name} ${roleBadge(u.role)}</div>
        <div class="user-row__email text-muted text-sm">${u.email}</div>
        ${u.zoho_salesperson_id ? `<div class="user-row__zoho text-sm text-muted">Zoho: ${u.zoho_salesperson_id}</div>` : ''}
        ${!u.active ? '<div class="text-sm text-danger">Inactive</div>' : ''}
        ${u.must_change_password ? '<div class="text-sm text-warning">Must set password</div>' : ''}
      </div>
      <div class="user-row__actions">
        <button class="btn btn--ghost btn--sm" onclick="openUserModal(${u.id})">Edit</button>
        <button class="btn btn--ghost btn--sm" onclick="resetPassword(${u.id}, '${u.name.replace(/'/g, "\\'")}')">Reset PW</button>
      </div>
    </div>`).join('');
}

// ── User Modal ────────────────────────────────────────────────────────────────
el('btn-add-user').addEventListener('click', () => openUserModal(null));

function openUserModal(userId) {
  el('user-form-id').value         = userId || '';
  el('user-form-name').value       = '';
  el('user-form-email').value      = '';
  el('user-form-role').value       = 'rep';
  el('user-form-zoho').value       = '';
  el('user-form-email').disabled   = false;
  el('modal-user-title').textContent = userId ? 'Edit User' : 'Add User';
  clearError('user-form-error');

  if (userId) {
    // Pre-fill from cached user list
    const u = usersCache.find(u => u.id === userId);
    if (u) {
      el('user-form-name').value  = u.name;
      el('user-form-email').value = u.email;
      el('user-form-role').value  = u.role;
      el('user-form-zoho').value  = u.zoho_salesperson_id || '';
      el('user-form-email').disabled = true; // Email is identity
    }
  }

  el('modal-user').classList.remove('hidden');
  el('user-form-name').focus();
}

function closeUserModal() {
  el('modal-user').classList.add('hidden');
}

el('modal-user-close').addEventListener('click', closeUserModal);
el('modal-user-cancel').addEventListener('click', closeUserModal);
el('modal-user-backdrop').addEventListener('click', closeUserModal);

el('form-user').addEventListener('submit', async e => {
  e.preventDefault();
  clearError('user-form-error');

  const userId = el('user-form-id').value;
  const btn    = el('user-form-submit');

  const body = {
    name:               el('user-form-name').value.trim(),
    role:               el('user-form-role').value,
    zoho_salesperson_id: el('user-form-zoho').value.trim() || null,
  };

  if (!userId) {
    body.email = el('user-form-email').value.trim();
  }

  if (!body.name || (!userId && !body.email)) {
    showError('user-form-error', 'Name and email are required.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  const method = userId ? 'PUT' : 'POST';
  const path   = userId ? `/api/users/${userId}` : '/api/users';
  const result = await api(method, path, body);

  btn.disabled = false;
  btn.textContent = 'Save';

  if (!result || result.error) {
    showError('user-form-error', result?.error || 'Failed to save user.');
    return;
  }

  closeUserModal();
  toast(userId ? 'User updated.' : `User created. They can log in with ${body.email} — no password needed yet.`, null, 6000);
  loadAdmin();
});

async function resetPassword(userId, name) {
  if (!confirm(`Reset ${name}'s password?\nThey will be prompted to set a new one next time they log in.`)) return;

  const result = await api('POST', `/api/users/${userId}/reset-password`);
  if (!result || result.error) {
    toast(result?.error || 'Failed to reset password.');
    return;
  }
  toast(`Password reset for ${name}.`);
  loadAdmin();
}

// ── Alert rendering ───────────────────────────────────────────────────────────

const ALERT_TYPE_LABELS = {
  a_grade_visit_breach: 'A-Grade Visit Breach',
  high_value_unvisited: 'High-Value Unvisited',
  churn_risk:           'Churn Risk',
  sku_gap:              'SKU Gap',
  rep_activity_drop:    'Rep Activity Drop',
  store_outperforming:  'Outperforming Store',
  new_door_high_value:  'New Customer',
  brand_underindex:     'Brand Under-Index',
  focus_line:           'Focus Line',
};

// Renders alert cards into the #alerts-container div (already in DOM).
// Called by loadDashboardAlerts() after the dashboard has rendered.
function renderAlertsSection(alerts) {
  const container = el('alerts-container');
  if (!container) return;

  if (!Array.isArray(alerts) || alerts.length === 0) {
    const isManager = currentUser && ['manager', 'executive'].includes(currentUser.role);
    const runBtn    = isManager
      ? `<button class="btn btn--ghost btn--sm" onclick="runAlerts()">Run Alert Engine</button>` : '';
    container.innerHTML = `
      <div class="section-label" style="margin-top:var(--space-4);">Alerts ${runBtn}</div>
      <p class="text-muted text-sm" style="padding:0 4px;">No active alerts.</p>`;
    return;
  }

  const tier1 = alerts.filter(a => a.tier === 1);
  const tier2 = alerts.filter(a => a.tier === 2);

  const renderCard = (a) => {
    const typeLabel  = ALERT_TYPE_LABELS[a.alert_type] || a.alert_type;
    const isManager  = currentUser && ['manager', 'executive'].includes(currentUser.role);
    const repLine    = isManager && a.rep_name
      ? `<span class="alert-card__rep">${escHtml(a.rep_name)}</span>` : '';
    const storeLine  = a.store_name
      ? `<span class="alert-card__store" onclick="openStoreDetail(${a.store_id})">${escHtml(a.store_name)}${a.store_grade ? ` <span class="grade-badge grade-badge--${a.store_grade.toLowerCase()}">${a.store_grade}</span>` : ''}</span>` : '';
    const riskLine   = a.revenue_at_risk
      ? `<span class="alert-card__risk">At risk: ${fmt(a.revenue_at_risk)}</span>` : '';
    const upliftLine = a.estimated_uplift
      ? `<span class="alert-card__uplift">Uplift: ${fmt(a.estimated_uplift)}</span>` : '';
    const metaLine   = [riskLine, upliftLine].filter(Boolean).join(' · ');

    return `
      <div class="alert-card alert-card--tier${a.tier}" data-alert-id="${a.id}">
        <div class="alert-card__body">
          <div class="alert-card__type">${typeLabel}</div>
          <div class="alert-card__title">${escHtml(a.alert_title)}</div>
          ${storeLine || repLine ? `<div class="alert-card__meta">${storeLine}${repLine}</div>` : ''}
          ${metaLine ? `<div class="alert-card__numbers">${metaLine}</div>` : ''}
        </div>
        <button class="alert-card__ack" onclick="ackAlert(${a.id})" title="Acknowledge">✓</button>
      </div>`;
  };

  const tier1Html = tier1.length > 0 ? `
    <div class="alerts-group">
      <div class="alerts-group__label alerts-group__label--t1">Action Required (${tier1.length})</div>
      ${tier1.map(renderCard).join('')}
    </div>` : '';

  const tier2Html = tier2.length > 0 ? `
    <div class="alerts-group">
      <div class="alerts-group__label alerts-group__label--t2">Insights (${tier2.length})</div>
      ${tier2.map(renderCard).join('')}
    </div>` : '';

  const isExec    = currentUser?.role === 'executive';
  const isManager = currentUser && ['manager', 'executive'].includes(currentUser.role);
  const runBtn    = isManager
    ? `<button class="btn btn--ghost btn--sm" onclick="runAlerts()">Run Alerts</button>` : '';
  const gradeBtn  = isExec
    ? `<button class="btn btn--ghost btn--sm" onclick="runGrading()" style="margin-left:var(--space-2);">Run Grading</button>` : '';
  const cacheBtn  = isExec
    ? `<button class="btn btn--ghost btn--sm" onclick="refreshInvoiceCache()" style="margin-left:var(--space-2);">Refresh Data</button>` : '';

  container.innerHTML = `
    <div class="section-label" style="margin-top:var(--space-4);">Alerts ${runBtn}${gradeBtn}${cacheBtn}</div>
    ${tier1Html}${tier2Html}`;
}

async function loadDashboardAlerts() {
  const alerts = await api('GET', '/api/alerts?limit=20');
  renderAlertsSection(Array.isArray(alerts) ? alerts : []);
}

async function ackAlert(alertId) {
  const card = document.querySelector(`[data-alert-id="${alertId}"]`);
  if (card) card.style.opacity = '0.4';

  const result = await api('POST', `/api/alerts/${alertId}/acknowledge`);
  if (!result || result.error) {
    if (card) card.style.opacity = '';
    toast(result?.error || 'Failed to acknowledge alert.');
    return;
  }

  if (card) card.remove();

  // Remove empty group labels
  document.querySelectorAll('.alerts-group').forEach(g => {
    if (!g.querySelector('.alert-card')) g.remove();
  });

  // If no alerts remain, show 'no alerts' message
  if (!document.querySelector('.alert-card')) {
    renderAlertsSection([]);
  }
}

async function runAlerts() {
  toast('Running alert engine…', null, 60000);
  const result = await api('POST', '/api/alerts/run');
  if (!result || result.error) {
    toast(result?.error || 'Alert engine failed.');
    return;
  }
  toast(`Alert engine complete — ${result.inserted} new alert${result.inserted !== 1 ? 's' : ''} generated.`, null, 5000);
  loadDashboardAlerts();
}

async function runGrading() {
  toast('Running grading engine… (may take 60s)', null, 90000);
  const result = await api('POST', '/api/grades/run-auto');
  if (!result || result.error) {
    toast(result?.error || 'Grading failed.');
    return;
  }
  const ag  = result.auto_grade  || {};
  const cl  = result.classify    || {};
  const pr  = result.promote     || {};
  const la  = result.lapsed      || {};

  if (ag.skipped) {
    toast('Grading skipped — Zoho invoice fetch returned 0 results. Check Zoho connection.', null, 8000);
    return;
  }

  const msg = [
    `Graded: ${ag.graded ?? 0}`,
    `Prospects: ${cl.prospected ?? 0}`,
    `Promoted: ${pr.promoted ?? 0}`,
    `Lapsed: ${la.downgraded ?? 0}`,
    ag.errors ? `Errors: ${ag.errors}` : null,
  ].filter(Boolean).join(' · ');

  toast(`Grading done — ${msg}`, null, 8000);

  // Reload dashboard to show updated grades
  loadDashboard(true);
}

async function refreshInvoiceCache() {
  toast('Clearing invoice cache and requesting fresh Zoho data…', null, 90000);
  const result = await api('POST', '/api/debug/cache-refresh');
  if (!result || result.error) {
    toast(result?.error || 'Cache refresh failed.');
    return;
  }
  toast('Cache cleared. Zoho re-fetch started in background (~60s). Dashboard will reload automatically.', null, 65000);
  // Reload dashboard after 65s to pick up fresh data
  setTimeout(() => loadDashboard(true), 65000);
}

// ═══════════════════════════════════════════════════════════════════
//  PRODUCTS (manager / executive only)
// ═══════════════════════════════════════════════════════════════════

let _productsRepFilter     = '';
let _productsGradeFilter   = '';
let _productsChannelFilter = '';

async function loadProducts() {
  const isManager = ['manager', 'executive'].includes(currentUser.role);
  if (!isManager) return;

  const page = el('page-products');
  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Products</h1>
      <span class="page-subtitle">Last 12 months</span>
    </div>
    <div class="filter-row">
      <select class="form-select filter-select" id="prod-grade-filter" onchange="productsFilterChanged('grade', this.value)">
        <option value="">All Grades</option>
        <option value="A">A</option>
        <option value="B">B</option>
        <option value="C">C</option>
      </select>
      <select class="form-select filter-select" id="prod-channel-filter" onchange="productsFilterChanged('channel_type', this.value)">
        <option value="">All Channels</option>
        <option value="gift">Gift</option>
        <option value="toy">Toy</option>
        <option value="book">Book</option>
        <option value="garden">Garden</option>
        <option value="homewares">Homewares</option>
        <option value="pharmacy">Pharmacy</option>
      </select>
      <select class="form-select filter-select" id="prod-rep-filter" onchange="productsFilterChanged('rep_id', this.value)">
        <option value="">All Reps</option>
      </select>
    </div>
    <div id="products-wrap">
      <div class="skeleton-block"></div>
      <div class="skeleton-block skeleton-block--sm"></div>
    </div>`;

  _productsRepFilter = ''; _productsGradeFilter = ''; _productsChannelFilter = '';

  const reps = await api('GET', '/api/users?role=rep');
  if (reps && !reps.error) {
    const sel = el('prod-rep-filter');
    if (sel) reps.forEach(r => {
      const o = document.createElement('option');
      o.value = r.id; o.textContent = r.name;
      sel.appendChild(o);
    });
  }

  fetchProductsData();
}

function productsFilterChanged(key, value) {
  if (key === 'grade')        _productsGradeFilter   = value;
  if (key === 'channel_type') _productsChannelFilter = value;
  if (key === 'rep_id')       _productsRepFilter     = value;
  fetchProductsData();
}
window.productsFilterChanged = productsFilterChanged;

async function fetchProductsData() {
  const wrap = el('products-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="skeleton-block"></div><div class="skeleton-block skeleton-block--sm"></div>';

  const params = new URLSearchParams();
  if (_productsGradeFilter)   params.set('grade',        _productsGradeFilter);
  if (_productsChannelFilter) params.set('channel_type', _productsChannelFilter);
  if (_productsRepFilter)     params.set('rep_id',       _productsRepFilter);

  const data = await api('GET', `/api/products?${params}`);
  if (!data || data.error) {
    wrap.innerHTML = '<p class="text-muted" style="padding:var(--space-4);">Failed to load product data.</p>';
    return;
  }

  const { topSkus, brandSummary } = data;

  const brandCards = brandSummary.filter(b => b.rate !== null).length === 0 ? '' : `
    <div class="section-label">Brand Reorder Rate</div>
    <div class="brand-summary-grid">
      ${brandSummary.map(b => `
        <div class="card brand-summary-card">
          <div class="brand-summary-card__name">${escHtml(b.name)}</div>
          <div class="brand-summary-card__stat">${b.rate !== null ? b.rate + '%' : '—'}</div>
          <div class="brand-summary-card__lbl">Reorder Rate</div>
          <div class="brand-summary-card__meta text-muted text-sm">${b.orderedBy} stores</div>
        </div>`).join('')}
    </div>`;

  const skuRows = topSkus.length === 0
    ? '<tr><td colspan="4" class="text-muted text-sm" style="padding:var(--space-4);text-align:center;">No SKU data yet — Zoho line items needed.</td></tr>'
    : topSkus.map(s => `
        <tr onclick="openSkuDetail(${JSON.stringify(s.itemId).replace(/"/g,'&quot;')})" style="cursor:pointer;">
          <td class="fw-bold">${escHtml(s.name)}</td>
          <td class="text-muted">${escHtml(s.brand || '—')}</td>
          <td class="text-right"><span class="reorder-pill ${reorderPillClass(s.reorderRate)}">${s.reorderRate !== null ? s.reorderRate + '%' : '—'}</span></td>
          <td class="text-right text-muted">${s.orderedBy}</td>
        </tr>`).join('');

  wrap.innerHTML = brandCards + `
    <div class="section-label" style="margin-top:var(--space-2);">Top SKUs by Reorder Rate</div>
    <div class="card" style="padding:0;overflow:hidden;">
      <div class="table-scroll">
        <table class="sku-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Brand</th>
              <th class="text-right">Reorder %</th>
              <th class="text-right">Stores</th>
            </tr>
          </thead>
          <tbody>${skuRows}</tbody>
        </table>
      </div>
    </div>`;
}

function reorderPillClass(rate) {
  if (rate === null || rate === undefined) return 'reorder-pill--low';
  if (rate >= 70) return 'reorder-pill--high';
  if (rate >= 40) return 'reorder-pill--mid';
  return 'reorder-pill--low';
}

// ── SKU Detail Sheet ───────────────────────────────────────────────

function openSkuDetail(itemId) {
  const sheet = el('modal-sku-detail');
  const body  = el('sku-detail-body');

  el('sku-detail-name').textContent  = 'Loading…';
  el('sku-detail-brand').textContent = '';
  body.innerHTML = '<div class="skeleton-block"></div><div class="skeleton-block skeleton-block--sm"></div>';
  sheet.classList.remove('hidden');
  sheet.classList.add('open');

  api('GET', `/api/products/sku/${encodeURIComponent(itemId)}`).then(data => {
    if (!data || data.error) {
      body.innerHTML = `<p class="text-muted" style="padding:var(--space-4);">${data?.error || 'Failed to load SKU.'}</p>`;
      return;
    }

    el('sku-detail-name').textContent  = data.name || itemId;
    el('sku-detail-brand').textContent = data.brand || '';

    const stockingHtml = !data.stockingStores || data.stockingStores.length === 0
      ? '<p class="text-muted text-sm" style="padding:var(--space-3);">None in current window.</p>'
      : data.stockingStores.map(s => `
          <div class="sku-store-row" onclick="closeSkuDetail(); setTimeout(() => openStoreDetail(${s.id}), 350)">
            <span class="grade-badge grade-badge--${(s.grade || 'c').toLowerCase()}">${s.grade || '?'}</span>
            <div class="sku-store-row__info">
              <div class="fw-bold">${escHtml(s.name)}</div>
              <div class="text-sm text-muted">${escHtml(s.rep_name || '—')}</div>
            </div>
          </div>`).join('');

    const droppedHtml = !data.droppedStores || data.droppedStores.length === 0
      ? '<p class="text-muted text-sm" style="padding:var(--space-3);">None detected.</p>'
      : data.droppedStores.map(s => `
          <div class="sku-store-row sku-store-row--dropped" onclick="closeSkuDetail(); setTimeout(() => openStoreDetail(${s.id}), 350)">
            <span class="grade-badge grade-badge--${(s.grade || 'c').toLowerCase()}">${s.grade || '?'}</span>
            <div class="sku-store-row__info">
              <div class="fw-bold">${escHtml(s.name)}</div>
              <div class="text-sm text-muted">${escHtml(s.rep_name || '—')}</div>
            </div>
            <div class="text-right text-sm text-muted">${s.lastOrderDate ? new Date(s.lastOrderDate).toLocaleDateString('en-AU', {day:'numeric',month:'short'}) : '—'}</div>
          </div>`).join('');

    body.innerHTML = `
      <div class="section-label">Key Metrics</div>
      <div class="stat-grid stat-grid--3">
        <div class="card stat-mini">
          <div class="stat-mini__val">${data.reorderRate !== null ? data.reorderRate + '%' : '—'}</div>
          <div class="stat-mini__lbl">Reorder Rate</div>
        </div>
        <div class="card stat-mini">
          <div class="stat-mini__val">${data.orderedBy}</div>
          <div class="stat-mini__lbl">Stores</div>
        </div>
        <div class="card stat-mini">
          <div class="stat-mini__val">${data.timeToReorder !== null ? data.timeToReorder + 'd' : '—'}</div>
          <div class="stat-mini__lbl">Avg Reorder</div>
        </div>
      </div>

      <div class="section-label" style="margin-top:var(--space-2);">Currently Stocking (${data.stockingStores?.length || 0})</div>
      <div class="card" style="padding:0;overflow:hidden;">${stockingHtml}</div>

      <div class="section-label" style="margin-top:var(--space-4);">Stopped Stocking (${data.droppedStores?.length || 0})</div>
      <div class="card" style="padding:0;overflow:hidden;">${droppedHtml}</div>`;
  });
}

function closeSkuDetail() {
  const sheet = el('modal-sku-detail');
  sheet.classList.remove('open');
  setTimeout(() => sheet.classList.add('hidden'), 300);
}

el('sku-detail-close').addEventListener('click', closeSkuDetail);

// ── Store Behaviour ────────────────────────────────────────────────

async function loadStoreBehaviour(storeId) {
  const wrap = el('store-behaviour-wrap');
  if (!wrap) return;

  const data = await api('GET', `/api/products/store/${storeId}/behaviour`);
  if (!data || data.error) return; // Silently fail — behaviour is supplementary

  const cls = (data.classification || '').toLowerCase().replace(/[^a-z]/g, '-');

  const evidenceHtml = (data.evidence || []).map(e => `
    <div class="detail-kv-row">
      <span class="text-muted text-sm">${escHtml(e.label)}</span>
      <span class="text-sm fw-bold">${escHtml(String(e.value))}</span>
    </div>`).join('');

  wrap.innerHTML = `
    <div class="section-label" style="margin-top:var(--space-4);">Buying Behaviour</div>
    <div class="card" style="padding:var(--space-3);">
      <div style="margin-bottom:var(--space-3);">
        <span class="behaviour-badge behaviour-badge--${cls}">${escHtml(data.classification)}</span>
      </div>
      ${evidenceHtml}
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════
//  SCOREBOARD
// ═══════════════════════════════════════════════════════════════════

async function loadScoreboard() {
  const page = el('page-scoreboard');
  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Scoreboard</h1>
      <span class="page-subtitle">Rolling 12 months</span>
    </div>
    <div class="skeleton-block"></div>
    <div class="skeleton-block skeleton-block--sm"></div>`;

  const data = await api('GET', '/api/scoreboard');
  if (!data || data.error) {
    page.innerHTML = `
      <div class="page-header"><h1 class="page-title">Scoreboard</h1></div>
      <div class="empty-state">
        <div class="empty-state__icon">📊</div>
        <div class="empty-state__title">Could not load scoreboard</div>
        <div class="empty-state__desc">${data?.error || 'Try again later.'}</div>
      </div>`;
    return;
  }

  const { reps } = data;

  function scoreSection(title, metric, rankKey, fmtFn, subtitle) {
    const sorted = [...reps].sort((a, b) => (a[rankKey] || 99) - (b[rankKey] || 99));
    const rows = sorted.map((r, i) => {
      const val = r[metric];
      const displayVal = (val === null || val === undefined) ? '—' : fmtFn(val);
      return `
        <div class="score-row${i === 0 ? ' score-row--top' : ''}">
          <div class="score-row__rank${i === 0 ? ' score-row__rank--gold' : ''}">${i + 1}</div>
          <div class="score-row__name">${escHtml(r.name)}</div>
          <div class="score-row__val">${displayVal}</div>
        </div>`;
    }).join('');
    return `
      <div class="section-label" style="margin-top:var(--space-4);">${title}</div>
      <div class="card" style="padding:0;overflow:hidden;">
        ${subtitle ? `<div class="score-subtitle">${subtitle}</div>` : ''}
        <div class="score-list">${rows}</div>
      </div>`;
  }

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Scoreboard</h1>
      <span class="page-subtitle">Rolling 12 months</span>
    </div>
    ${scoreSection('Revenue per Visit', 'revPerVisit', 'revPerVisitRank', v => fmt(v, true), 'Total revenue ÷ visits logged')}
    ${scoreSection('Territory Growth', 'growthPct', 'growthPctRank', v => `${v >= 0 ? '+' : ''}${v}%`, 'H2 vs H1 of the 12-month window')}
    ${scoreSection('New Customers This Month', 'newDoors', 'newDoorsRank', v => String(v), 'First-ever invoiced customers in this calendar month')}
    ${scoreSection('Reactivation Revenue', 'reactivationPct', 'reactivationPctRank', v => `${v}%`, 'Revenue from stores re-engaging after a 3-month gap')}`;
}

// ── CSV Import ────────────────────────────────────────────────────────────────

let _importFile = null;

function openImportModal() {
  resetImportModal();
  el('modal-import').classList.remove('hidden');
}

function closeImportModal() {
  el('modal-import').classList.add('hidden');
}

function resetImportModal() {
  _importFile = null;
  el('import-file-input').value = '';
  el('import-file-name').textContent = '';
  el('import-step-preview').classList.add('hidden');
  el('import-step-result').classList.add('hidden');
  el('import-step-pick').classList.remove('hidden');
  el('import-error').classList.add('hidden');
}

async function importFileSelected() {
  const input = el('import-file-input');
  if (!input.files || !input.files[0]) return;
  _importFile = input.files[0];
  el('import-file-name').textContent = _importFile.name + ' (' + (_importFile.size / 1024).toFixed(0) + ' KB)';

  // Show loading state
  el('import-step-pick').classList.add('hidden');
  el('import-step-preview').classList.remove('hidden');
  el('import-parse-stats').innerHTML = '<div class="skeleton-block skeleton-block--sm"></div>';
  el('import-preview-table').innerHTML = '';
  el('import-run-btn').disabled = true;

  // Upload for preview
  const form = new FormData();
  form.append('csv', _importFile);

  try {
    const res = await fetch('/api/visits/import/preview', { method: 'POST', body: form, credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok || data.error) {
      el('import-parse-stats').innerHTML = '';
      el('import-error').textContent = data.error || 'Preview failed.';
      el('import-error').classList.remove('hidden');
      return;
    }

    // Stats bar
    el('import-parse-stats').innerHTML = `
      <div class="import-stats">
        <span class="import-stat import-stat--muted">${data.totalRows.toLocaleString()} rows</span>
        <span class="import-stat import-stat--ok">${data.validRows.toLocaleString()} valid</span>
        ${data.nonZoho   ? `<span class="import-stat import-stat--muted">${data.nonZoho.toLocaleString()} non-Zoho skipped</span>` : ''}
        ${data.noStore   ? `<span class="import-stat import-stat--warn">${data.noStore.toLocaleString()} store not found</span>` : ''}
        ${data.noRep     ? `<span class="import-stat import-stat--warn">${data.noRep.toLocaleString()} rep not matched</span>` : ''}
        ${data.badDate   ? `<span class="import-stat import-stat--warn">${data.badDate.toLocaleString()} bad date</span>` : ''}
      </div>`;

    // Preview table
    if (data.preview && data.preview.length > 0) {
      el('import-preview-table').innerHTML = `
        <thead>
          <tr>
            <th>Date</th><th>Start</th><th>Account</th>
            <th>Rep</th><th>Type</th><th>Note</th>
          </tr>
        </thead>
        <tbody>
          ${data.preview.map(r => `
            <tr>
              <td>${r.date}</td>
              <td>${r.start}</td>
              <td title="${r.account}">${r.account.slice(-6)}</td>
              <td>${r.rep_code}</td>
              <td>${r.category}</td>
              <td title="${r.note}">${r.note ? r.note.slice(0, 40) + (r.note.length > 40 ? '…' : '') : ''}</td>
            </tr>`).join('')}
        </tbody>`;
    } else {
      el('import-preview-table').innerHTML = '<caption style="padding:1rem;color:var(--color-muted);">No importable rows found.</caption>';
    }

    el('import-run-btn').disabled = data.validRows === 0;
  } catch (err) {
    el('import-parse-stats').innerHTML = '';
    el('import-error').textContent = 'Network error: ' + err.message;
    el('import-error').classList.remove('hidden');
  }
}

async function runImport() {
  if (!_importFile) return;
  const btn = el('import-run-btn');
  btn.disabled = true;
  btn.textContent = 'Importing…';

  const form = new FormData();
  form.append('csv', _importFile);

  try {
    const res = await fetch('/api/visits/import/run', { method: 'POST', body: form, credentials: 'same-origin' });
    const data = await res.json();

    if (!res.ok || data.error) {
      el('import-error').textContent = data.error || 'Import failed.';
      el('import-error').classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Import All Valid Rows';
      return;
    }

    // Show results
    el('import-step-preview').classList.add('hidden');
    el('import-step-result').classList.remove('hidden');
    el('import-result-card').innerHTML = `
      <div class="section-label" style="margin-bottom:var(--space-3);">Import Complete</div>
      <div class="import-stats" style="flex-direction:column;align-items:flex-start;gap:var(--space-2);">
        <span class="import-stat import-stat--ok">✓ ${data.imported.toLocaleString()} visits imported</span>
        ${data.duplicates       ? `<span class="import-stat import-stat--muted">${data.duplicates.toLocaleString()} duplicates skipped</span>` : ''}
        ${data.skipped_non_zoho ? `<span class="import-stat import-stat--muted">${data.skipped_non_zoho.toLocaleString()} non-Zoho rows skipped</span>` : ''}
        ${data.skipped_no_store ? `<span class="import-stat import-stat--warn">${data.skipped_no_store.toLocaleString()} store not found</span>` : ''}
        ${data.skipped_no_rep   ? `<span class="import-stat import-stat--warn">${data.skipped_no_rep.toLocaleString()} rep code not matched</span>` : ''}
        ${data.skipped_bad_date ? `<span class="import-stat import-stat--warn">${data.skipped_bad_date.toLocaleString()} bad date/time</span>` : ''}
      </div>`;
  } catch (err) {
    el('import-error').textContent = 'Network error: ' + err.message;
    el('import-error').classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Import All Valid Rows';
  }
}

// ═══════════════════════════════════════════════════════════════════
//  KPI INCENTIVE TRACKER
// ═══════════════════════════════════════════════════════════════════

// ── Rep KPI card ──────────────────────────────────────────────────

async function loadKpiCard() {
  const wrap = el('kpi-card-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="skeleton-block" style="margin-top:var(--space-4);height:220px;"></div>';
  const data = await api('GET', '/api/kpi/my');
  if (!data || data.error) { wrap.innerHTML = ''; return; }
  renderKpiCard(data);
}

function kpiStatusClass(pct, target) {
  if (pct === null || pct === undefined) return 'grey';
  if (pct >= target) return 'green';
  if (pct >= target - 25) return 'amber';
  return 'red';
}

function renderKpiCard(data) {
  const wrap = el('kpi-card-wrap');
  if (!wrap) return;

  const { quarter_label, targets, actuals } = data;

  const kpiRows = [];

  // 1. New Customers
  const ncAct = actuals.new_customers.actual;
  const ncPct = actuals.new_customers.pct;
  const ncCls = kpiStatusClass(ncPct, 100);
  kpiRows.push(kpiRow('New Customers', `${ncAct} / ${targets.new_customers}`, ncPct, ncCls));

  // 2. Reactivations
  const rxAct = actuals.reactivations.actual;
  const rxPct = actuals.reactivations.pct;
  const rxCls = kpiStatusClass(rxPct, 100);
  kpiRows.push(kpiRow('Reactivations', `${rxAct} / ${targets.reactivations}`, rxPct, rxCls));

  // 3. Coverage
  const cov = actuals.coverage;
  const covPct = cov.pct;
  const covCls = kpiStatusClass(covPct, targets.coverage_pct);
  kpiRows.push(kpiRow('Territory Coverage', `${cov.covered} / ${cov.total} stores`, covPct, covCls));

  // 4. Weekly Plan
  const wp = actuals.weekly_plan;
  const wpCls = wp.submitted ? 'green' : 'red';
  const wpLabel = wp.submitted ? 'Submitted' : 'Not submitted';
  const wpAction = !wp.submitted
    ? `<button class="btn btn--sm btn--accent" style="padding:2px 10px;font-size:12px;" onclick="submitWeeklyPlan()">Submit</button>`
    : '';
  kpiRows.push(`
    <div class="kpi-row">
      <div class="kpi-dot kpi-dot--${wpCls}"></div>
      <div class="kpi-row__label">Weekly Plan</div>
      <div class="kpi-row__value">${wpLabel} ${wpAction}</div>
    </div>`);

  // 5. Territory Growth
  const gr = actuals.growth;
  const grPct = gr.pct;
  const grCls = grPct === null ? 'grey' : grPct >= targets.growth_pct ? 'green' : grPct >= 0 ? 'amber' : 'red';
  const grLabel = grPct === null ? '—' : `${grPct >= 0 ? '+' : ''}${grPct}%`;
  kpiRows.push(kpiRow('Territory Growth', grLabel, grPct === null ? null : Math.min(Math.max(grPct + 100, 0), 200) / 2, grCls, true));

  wrap.innerHTML = `
    <div class="section-label" style="margin-top:var(--space-4);">KPI Tracker</div>
    <div class="card kpi-card">
      <div class="kpi-card__header">
        <span class="kpi-card__title">${escHtml(quarter_label)}</span>
        <span class="kpi-card__sub text-muted text-sm">Quarterly incentive</span>
      </div>
      <div class="kpi-rows">
        ${kpiRows.join('')}
      </div>
    </div>`;
}

function kpiRow(label, value, pct, cls, noBar) {
  const barHtml = noBar ? '' : `<div class="progress kpi-row__bar"><div class="progress__fill progress__fill--${cls === 'green' ? 'success' : cls === 'amber' ? 'warning' : cls === 'red' ? 'danger' : 'muted'}" style="width:${Math.min(pct ?? 0, 100)}%"></div></div>`;
  return `
    <div class="kpi-row">
      <div class="kpi-dot kpi-dot--${cls}"></div>
      <div class="kpi-row__label">${label}</div>
      <div class="kpi-row__value">${value}</div>
      ${barHtml}
    </div>`;
}

async function submitWeeklyPlan() {
  const result = await api('POST', '/api/kpi/weekly-plan');
  if (!result || result.error) {
    toast(result?.error || 'Failed to submit plan.');
    return;
  }
  toast('Weekly plan submitted!');
  loadKpiCard();
}

// ── Incentive target grid (manager/exec, in Targets tab) ──────────

let _incentiveTargets = [];

async function loadIncentiveTargets(reps) {
  const wrap = el('incentive-target-wrap');
  if (!wrap) return;
  if (!currentUser || !['manager', 'executive'].includes(currentUser.role)) {
    wrap.innerHTML = '';
    return;
  }
  if (!reps || reps.length === 0) { wrap.innerHTML = ''; return; }

  const targets = await api('GET', '/api/kpi/targets');
  if (!targets || targets.error) { wrap.innerHTML = '<p class="text-muted" style="padding:16px;">Could not load KPI targets.</p>'; return; }
  _incentiveTargets = targets;

  // Build quarter selector: current quarter ± 2 quarters
  const now = new Date();
  const curQ = Math.floor(now.getMonth() / 3) + 1;
  const curY = now.getFullYear();
  const quarters = [];
  for (let offset = -2; offset <= 2; offset++) {
    let q = curQ + offset;
    let y = curY;
    while (q < 1) { q += 4; y--; }
    while (q > 4) { q -= 4; y++; }
    quarters.push({ q, y, label: `Q${q} ${y}` });
  }

  const selId = 'incentive-quarter-sel';
  const curIdx = quarters.findIndex(x => x.q === curQ && x.y === curY);

  wrap.innerHTML = `
    <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-3) 0;">
      <label class="text-sm text-muted" for="${selId}">Quarter:</label>
      <select id="${selId}" class="form-control" style="width:auto;min-width:120px;" onchange="renderIncentiveGrid()">
        ${quarters.map((x, i) => `<option value="${x.q}:${x.y}" ${i === curIdx ? 'selected' : ''}>${x.label}</option>`).join('')}
      </select>
    </div>
    <div id="incentive-grid-wrap"></div>`;

  window._incentiveReps = reps;
  renderIncentiveGrid();
}

function renderIncentiveGrid() {
  const wrap = el('incentive-grid-wrap');
  if (!wrap) return;

  const sel = el('incentive-quarter-sel');
  if (!sel) return;
  const [qStr, yStr] = sel.value.split(':');
  const quarter = parseInt(qStr, 10);
  const year    = parseInt(yStr, 10);
  const reps    = window._incentiveReps || [];

  const COLS = [
    { key: 'new_customers', label: 'New Cust', dflt: 5 },
    { key: 'reactivations', label: 'Reactiv', dflt: 5 },
    { key: 'coverage_pct',  label: 'Cover %', dflt: 90 },
    { key: 'growth_pct',    label: 'Growth %', dflt: 5 },
  ];

  const headers = COLS.map(c => `<th class="tg-month">${c.label}</th>`).join('');

  const rows = reps.map(rep => {
    const t = _incentiveTargets.find(x => x.rep_id === rep.id && x.quarter === quarter && x.year === year) || {};
    const cells = COLS.map(c => {
      const val = t[c.key] !== undefined ? t[c.key] : c.dflt;
      return `<td class="tg-cell itg-cell" data-rep="${rep.id}" data-col="${c.key}" data-quarter="${quarter}" data-year="${year}">
        <div class="tg-cell__val">${val}</div>
      </td>`;
    }).join('');
    return `<tr><th class="tg-rep">${escHtml(rep.name)}</th>${cells}</tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="tg-scroll">
      <table class="tg-table">
        <thead>
          <tr>
            <th class="tg-rep tg-rep--head">Rep</th>
            ${headers}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  // Attach click handlers
  wrap.querySelectorAll('.itg-cell').forEach(cell => {
    cell.addEventListener('click', () => beginEditIncentiveCell(cell));
  });
}

function beginEditIncentiveCell(cell) {
  if (cell.querySelector('input')) return;
  const cur = cell.querySelector('.tg-cell__val')?.textContent?.trim() || '';
  const input = document.createElement('input');
  input.type  = 'number';
  input.value = cur;
  input.min   = '0';
  input.className = 'tg-cell__input';
  cell.innerHTML  = '';
  cell.appendChild(input);
  input.focus();
  input.select();

  const save = async () => {
    const val = parseInt(input.value, 10);
    if (isNaN(val) || val < 0) { cell.innerHTML = `<div class="tg-cell__val">${cur}</div>`; return; }
    cell.innerHTML = `<div class="tg-cell__val">${val}</div>`;

    const repId   = parseInt(cell.dataset.rep,     10);
    const col     = cell.dataset.col;
    const quarter = parseInt(cell.dataset.quarter, 10);
    const year    = parseInt(cell.dataset.year,    10);

    // Optimistic update local cache
    let existing = _incentiveTargets.find(x => x.rep_id === repId && x.quarter === quarter && x.year === year);
    if (!existing) {
      existing = { rep_id: repId, quarter, year, new_customers: 5, reactivations: 5, coverage_pct: 90, growth_pct: 5 };
      _incentiveTargets.push(existing);
    }
    existing[col] = val;

    const payload = { rep_id: repId, quarter, year, [col]: val };
    const result = await api('POST', '/api/kpi/targets', payload);
    if (!result || result.error) {
      toast(result?.error || 'Failed to save KPI target.');
      cell.innerHTML = `<div class="tg-cell__val">${cur}</div>`;
    }
  };

  input.addEventListener('blur',  save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { input.blur(); }
    if (e.key === 'Escape') { cell.innerHTML = `<div class="tg-cell__val">${cur}</div>`; }
  });
}

// ── Team KPI traffic light table ──────────────────────────────────

async function loadKpiTeam() {
  const wrap = el('kpi-team-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="skeleton-block" style="margin-top:var(--space-4);height:160px;"></div>';
  const data = await api('GET', '/api/kpi/team');
  if (!data || data.error || !Array.isArray(data.reps)) { wrap.innerHTML = ''; return; }
  renderKpiTeamTable(data);
}

function renderKpiTeamTable(data) {
  const wrap = el('kpi-team-wrap');
  if (!wrap) return;

  const { quarter_label, reps } = data;

  const rows = reps.map(r => {
    const a = r.actuals;
    const t = r.targets;

    const ncCls  = kpiStatusClass(a.new_customers.pct, 100);
    const rxCls  = kpiStatusClass(a.reactivations.pct, 100);
    const covCls = kpiStatusClass(a.coverage.pct, t.coverage_pct);
    const wpCls  = a.weekly_plan.submitted ? 'green' : 'red';
    const grPct  = a.growth.pct;
    const grCls  = grPct === null ? 'grey' : grPct >= t.growth_pct ? 'green' : grPct >= 0 ? 'amber' : 'red';
    const grText = grPct === null ? '—' : `${grPct >= 0 ? '+' : ''}${grPct}%`;

    return `<tr>
      <td class="kpi-team__rep">${escHtml(r.name)}</td>
      <td><span class="kpi-dot kpi-dot--${ncCls}"></span>${a.new_customers.actual}/${t.new_customers}</td>
      <td><span class="kpi-dot kpi-dot--${rxCls}"></span>${a.reactivations.actual}/${t.reactivations}</td>
      <td><span class="kpi-dot kpi-dot--${covCls}"></span>${a.coverage.pct ?? 0}%</td>
      <td><span class="kpi-dot kpi-dot--${wpCls}"></span>${a.weekly_plan.submitted ? 'Yes' : 'No'}</td>
      <td><span class="kpi-dot kpi-dot--${grCls}"></span>${grText}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="section-label" style="margin-top:var(--space-4);">
      Team KPI Status
      <button class="btn btn--ghost btn--sm" style="margin-left:var(--space-3);" onclick="exportKpiCsv()">Export CSV</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden;">
      <div class="kpi-team-header text-sm text-muted" style="padding:var(--space-2) var(--space-3);">${escHtml(quarter_label)}</div>
      <div class="table-scroll">
        <table class="kpi-team-table">
          <thead>
            <tr>
              <th>Rep</th>
              <th>New Cust</th>
              <th>Reactiv</th>
              <th>Coverage</th>
              <th>Wkly Plan</th>
              <th>Growth</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

async function exportKpiCsv() {
  try {
    const res = await fetch('/api/kpi/team/csv', { credentials: 'same-origin' });
    if (!res.ok) { toast('CSV export failed.'); return; }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'kpi-export.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    toast('CSV export failed.');
  }
}

// ═══════════════════════════════════════════════════════════════════
//  CALL PLANNER
// ═══════════════════════════════════════════════════════════════════

let _plannerWeek          = null;      // currently active ISO Monday (used by add-store etc.)
let _plannerRepId         = null;      // rep being viewed (null = self)
let _plannerRepName       = null;      // name of rep being viewed
let _plannerQuarter       = null;      // 1–4
let _plannerYear          = null;      // YYYY
let _plannerWeekCache     = new Map(); // week → {submitted, days}
let _plannerExpandedWeeks = new Set(); // weeks currently open in accordion
let _planActionItemId     = null;      // item id in the actions sheet
let _planActionWeek       = null;      // week of that item
let _addPlanDay           = 1;         // day selected in add-store sheet
let _moveDayFromWeek      = null;
let _moveDayFromDay       = null;
let _moveDayTargetDay     = 1;
let _moveStoreTargetDay   = 1;

// ── Date / quarter helpers ─────────────────────────────────────────

function _isoMonday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function _currentPlannerWeek() {
  return _isoMonday(new Date().toISOString().slice(0, 10));
}

function _currentQuarter() {
  const now = new Date();
  return { quarter: Math.ceil((now.getMonth() + 1) / 3), year: now.getFullYear() };
}

function _quarterWeeks(quarter, year) {
  const monthStart = (quarter - 1) * 3;
  const qEnd = new Date(Date.UTC(year, monthStart + 3, 0));
  let d = new Date(Date.UTC(year, monthStart, 1));
  const dow = d.getUTCDay();
  if (dow !== 1) d.setUTCDate(d.getUTCDate() + (dow === 0 ? 1 : 8 - dow));
  const weeks = [];
  while (d <= qEnd) {
    weeks.push(d.toISOString().slice(0, 10));
    d = new Date(d); d.setUTCDate(d.getUTCDate() + 7);
  }
  return weeks;
}

function _fmtPlannerWeek(w) {
  const mon = new Date(w + 'T00:00:00Z');
  const fri = new Date(w + 'T00:00:00Z');
  fri.setUTCDate(fri.getUTCDate() + 4);
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${mon.getUTCDate()} ${M[mon.getUTCMonth()]} – ${fri.getUTCDate()} ${M[fri.getUTCMonth()]} ${fri.getUTCFullYear()}`;
}

function _fmtWeekShort(w) {
  const mon = new Date(w + 'T00:00:00Z');
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${mon.getUTCDate()} ${M[mon.getUTCMonth()]}`;
}

const _dayNames = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const _dayShort = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

// ── Load planner page (quarter accordion) ──────────────────────────

async function loadPlanner() {
  const page = el('page-planner');
  const isManager = ['manager', 'executive'].includes(currentUser.role);

  if (!_plannerQuarter) {
    const cq = _currentQuarter();
    _plannerQuarter = cq.quarter;
    _plannerYear    = cq.year;
  }
  if (!_plannerWeek) _plannerWeek = _currentPlannerWeek();
  if (_plannerExpandedWeeks.size === 0) _plannerExpandedWeeks.add(_plannerWeek);

  // Show skeleton only on first load (no accordion rendered yet)
  if (!document.getElementById('planner-quarter-weeks')) {
    page.innerHTML = `
      <div class="page-header"><h1 class="page-title">Planner</h1></div>
      <div class="skeleton-block" style="height:48px;margin-bottom:12px;"></div>
      <div class="skeleton-block" style="height:300px;"></div>`;
  }

  const repParam = _plannerRepId ? `&rep_id=${_plannerRepId}` : '';
  const data = await api('GET', `/api/planner/quarter?quarter=${_plannerQuarter}&year=${_plannerYear}${repParam}`);

  if (!data || data.error) {
    page.innerHTML = `
      <div class="page-header"><h1 class="page-title">Planner</h1></div>
      <div class="empty-state">
        <div class="empty-state__title">Could not load planner</div>
        <div class="empty-state__desc">${data?.error || 'Please try again.'}</div>
        <button class="btn btn--accent" onclick="loadPlanner()">Retry</button>
      </div>`;
    return;
  }

  // Pre-load detail for all currently expanded weeks
  await Promise.all([..._plannerExpandedWeeks].map(async (week) => {
    if (!_plannerWeekCache.has(week)) {
      const wd = await api('GET', `/api/planner/week?week=${week}${repParam}`);
      if (wd && !wd.error) _plannerWeekCache.set(week, wd);
    }
  }));

  renderPlannerPage(page, data, isManager);
}

// ── Render quarter accordion ────────────────────────────────────────

function renderPlannerPage(page, qData, isManager) {
  const { quarter, year, weeks } = qData;

  let managerBar = '';
  if (isManager) {
    const lbl = _plannerRepId && _plannerRepName ? `Viewing: ${_plannerRepName}` : 'My plan';
    const btn = _plannerRepId
      ? `<button class="btn btn--ghost btn--sm" onclick="resetPlannerToSelf()">My Plan</button>`
      : `<button class="btn btn--ghost btn--sm" onclick="openPlannerTeamView()">Team View</button>`;
    managerBar = `<div class="planner-manager-bar"><span class="text-sm text-muted">${lbl}</span>${btn}</div>`;
  }

  page.innerHTML = `
    ${managerBar}
    <div class="planner-quarter-nav">
      <button class="btn-icon-sm" onclick="shiftPlannerQuarter(-1)">&#8592;</button>
      <div class="planner-quarter-label">Q${quarter} ${year}</div>
      <button class="btn-icon-sm" onclick="shiftPlannerQuarter(1)">&#8594;</button>
      <button class="btn btn--ghost btn--sm" onclick="generatePlannerQuarter()" style="margin-left:auto;">&#9889; Generate Quarter</button>
    </div>
    <div id="planner-quarter-weeks">
      ${weeks.map(w => renderQuarterWeekRow(w)).join('')}
    </div>`;
}

// ── Render one week row (collapsed or expanded) ─────────────────────

function renderQuarterWeekRow(w) {
  const isExpanded = _plannerExpandedWeeks.has(w.week);
  const isCurrent  = w.week === _currentPlannerWeek();

  const parts = [];
  if (w.total === 0) parts.push('Empty');
  else {
    parts.push(`${w.total} store${w.total !== 1 ? 's' : ''}`);
    if (w.confirmed > 0) parts.push(`${w.confirmed} confirmed`);
    if (w.completed > 0) parts.push(`${w.completed} done`);
    if (w.suggested > 0 && w.total > 0) parts.push(`${w.suggested} to plan`);
  }

  const badges = [
    isCurrent  ? `<span class="pqw-badge pqw-badge--current">This week</span>` : '',
    w.submitted ? `<span class="pqw-badge pqw-badge--submitted">Submitted ✓</span>` : '',
  ].filter(Boolean).join('');

  const wd = _plannerWeekCache.get(w.week);
  const detailHtml = isExpanded
    ? `<div class="plan-quarter-week__detail">${wd ? renderWeekDetail(w.week, wd) : '<div class="planner-week-loading">Loading…</div>'}</div>`
    : '';

  return `
    <div class="plan-quarter-week${isExpanded ? ' plan-quarter-week--expanded' : ''}${isCurrent ? ' plan-quarter-week--current' : ''}" id="plan-week-${w.week}">
      <div class="plan-quarter-week__header" onclick="togglePlannerWeek('${w.week}')">
        <div class="plan-quarter-week__info">
          <span class="plan-quarter-week__label">${w.label}</span>
          ${badges}
        </div>
        <div class="plan-quarter-week__right">
          <span class="plan-quarter-week__summary">${parts.join(' · ')}</span>
          <span class="plan-quarter-week__chevron">${isExpanded ? '▲' : '▼'}</span>
        </div>
      </div>
      ${detailHtml}
    </div>`;
}

// ── Render expanded week detail ─────────────────────────────────────

function renderWeekDetail(week, wd) {
  const { submitted, days } = wd;
  const total = Object.values(days).reduce((s, a) => s + a.length, 0);
  const dayCards = [1,2,3,4,5].map(d => renderPlanDayCard(d, days[d] || [], submitted, week)).join('');
  const submitHtml = submitted
    ? `<div class="planner-submitted-badge">Plan submitted ✓</div>`
    : `<button class="btn btn--accent btn--full planner-submit-btn" onclick="submitPlannerWeek('${week}')">Submit Plan${total > 0 ? ` (${total} stores)` : ''}</button>`;
  return `
    <div class="planner-actions-row">
      <button class="btn btn--ghost btn--sm" onclick="generatePlannerWeek('${week}')">&#9889; Week</button>
      <button class="btn btn--ghost btn--sm" onclick="openAddPlanStore('${week}')">+ Store</button>
    </div>
    ${total === 0 ? `<div class="empty-state" style="padding:var(--space-3) var(--space-2);"><div class="empty-state__desc">No stores planned. Generate or add manually.</div></div>` : dayCards}
    <div style="padding:var(--space-2) 0 var(--space-1);">${submitHtml}</div>`;
}

// ── Toggle week accordion ───────────────────────────────────────────

async function togglePlannerWeek(week) {
  if (_plannerExpandedWeeks.has(week)) {
    _plannerExpandedWeeks.delete(week);
    const container = document.getElementById(`plan-week-${week}`);
    if (container) {
      container.classList.remove('plan-quarter-week--expanded');
      container.querySelector('.plan-quarter-week__detail')?.remove();
      container.querySelector('.plan-quarter-week__chevron').textContent = '▼';
    }
    return;
  }

  _plannerExpandedWeeks.add(week);
  _plannerWeek = week;

  const container = document.getElementById(`plan-week-${week}`);
  if (!container) return;
  container.classList.add('plan-quarter-week--expanded');
  container.querySelector('.plan-quarter-week__chevron').textContent = '▲';

  let detail = container.querySelector('.plan-quarter-week__detail');
  if (!detail) {
    detail = document.createElement('div');
    detail.className = 'plan-quarter-week__detail';
    container.appendChild(detail);
  }

  if (_plannerWeekCache.has(week)) {
    detail.innerHTML = renderWeekDetail(week, _plannerWeekCache.get(week));
    return;
  }

  detail.innerHTML = '<div class="planner-week-loading">Loading…</div>';
  const repParam = _plannerRepId ? `&rep_id=${_plannerRepId}` : '';
  const wd = await api('GET', `/api/planner/week?week=${week}${repParam}`);
  if (wd && !wd.error) {
    _plannerWeekCache.set(week, wd);
    detail.innerHTML = renderWeekDetail(week, wd);
  } else {
    detail.innerHTML = '<div class="text-muted text-sm" style="padding:12px;">Could not load week data.</div>';
  }
}
window.togglePlannerWeek = togglePlannerWeek;

// ── Quarter navigation ─────────────────────────────────────────────

function shiftPlannerQuarter(dir) {
  let q = _plannerQuarter + dir;
  let y = _plannerYear;
  if (q > 4) { q = 1; y++; }
  if (q < 1) { q = 4; y--; }
  _plannerQuarter = q;
  _plannerYear    = y;
  _plannerWeekCache.clear();
  _plannerExpandedWeeks.clear();
  const cw = _currentPlannerWeek();
  if (_quarterWeeks(q, y).includes(cw)) _plannerExpandedWeeks.add(cw);
  loadPlanner();
}
window.shiftPlannerQuarter = shiftPlannerQuarter;

// ── Generate quarter ───────────────────────────────────────────────

async function generatePlannerQuarter() {
  const btn = document.querySelector('.planner-quarter-nav .btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
  const body = { scope: 'quarter', quarter: _plannerQuarter, year: _plannerYear };
  if (_plannerRepId) body.rep_id = _plannerRepId;
  const result = await api('POST', '/api/planner/generate', body);
  if (btn) { btn.disabled = false; btn.textContent = '⚡ Generate Quarter'; }
  if (!result || result.error) { toast(result?.error || 'Generate failed.'); return; }
  toast(result.generated > 0
    ? `Quarter planned — ${result.generated} stores across ${result.weeks_planned} week${result.weeks_planned !== 1 ? 's' : ''}.`
    : (result.message || 'No stores to schedule.'));
  _plannerWeekCache.clear();
  loadPlanner();
}
window.generatePlannerQuarter = generatePlannerQuarter;

// ── Generate single week ───────────────────────────────────────────

async function generatePlannerWeek(week) {
  if (week) _plannerWeek = week;
  const body = { week: _plannerWeek };
  if (_plannerRepId) body.rep_id = _plannerRepId;
  const result = await api('POST', '/api/planner/generate', body);
  if (!result || result.error) { toast(result?.error || 'Generate failed.'); return; }
  toast(result.generated > 0
    ? `Generated ${result.generated} stores.`
    : (result.message || 'No overdue stores found.'));
  _plannerWeekCache.delete(_plannerWeek);
  loadPlanner();
}
window.generatePlannerWeek = generatePlannerWeek;

// ── Submit plan for a week ─────────────────────────────────────────

async function submitPlannerWeek(week) {
  if (week) _plannerWeek = week;
  const body = { week: _plannerWeek };
  if (_plannerRepId) body.rep_id = _plannerRepId;
  const result = await api('POST', '/api/planner/submit', body);
  if (!result || result.error) { toast(result?.error || 'Submit failed.'); return; }
  toast('Plan submitted.');
  _plannerWeekCache.delete(_plannerWeek);
  loadPlanner();
}
window.submitPlannerWeek = submitPlannerWeek;

// ── Render day card ────────────────────────────────────────────────

function renderPlanDayCard(dayNum, items, submitted, week) {
  if (items.length === 0) return '';
  const moveDayBtn = !submitted
    ? `<button class="btn btn--ghost btn--xs" onclick="openMoveDayModal('${week}',${dayNum})">Move Day</button>`
    : '';
  const itemsHtml = items.map((item, idx) =>
    renderPlanItem(item, dayNum, idx, items.length, submitted, week)
  ).join('');
  return `
    <div class="plan-day-card">
      <div class="plan-day-header">
        <span class="plan-day-name">${_dayNames[dayNum]}</span>
        <span class="plan-day-count">${items.length} store${items.length !== 1 ? 's' : ''}</span>
        ${moveDayBtn}
      </div>
      ${itemsHtml}
    </div>`;
}

// ── Render plan item row ───────────────────────────────────────────

function renderPlanItem(item, dayNum, idx, total, submitted, week) {
  const gradeHtml = item.grade
    ? `<span class="grade-badge grade-badge--${item.grade}">${item.grade}</span>`
    : `<span class="grade-badge grade-badge--P">P</span>`;
  const meta = [item.state, item.postcode].filter(Boolean).join(' ');
  const overdue = item.days_since_visit != null ? `${item.days_since_visit}d` : '';
  const timeHtml = item.confirmed_time
    ? `<span class="plan-item__time">⏰ ${item.confirmed_time}</span>` : '';
  const statusClass = item.status === 'confirmed' ? 'plan-item--confirmed'
    : item.status === 'completed' ? 'plan-item--completed'
    : item.status === 'skipped'   ? 'plan-item--skipped' : '';
  const moveHtml = !submitted ? `
    <div class="plan-item__move">
      ${idx > 0         ? `<button class="plan-item__move-btn" onclick="movePlanItemUp(${item.id})" title="Move up">↑</button>` : '<span></span>'}
      ${idx < total - 1 ? `<button class="plan-item__move-btn" onclick="movePlanItemDown(${item.id})" title="Move down">↓</button>` : '<span></span>'}
    </div>` : '';
  const actionsBtn = !submitted
    ? `<button class="plan-item__actions-btn" onclick="openPlanActions(${item.id})" title="Actions">⋮</button>` : '';
  return `
    <div class="plan-item ${statusClass}" data-plan-id="${item.id}" data-day="${dayNum}" data-week="${week}">
      ${gradeHtml}
      <div class="plan-item__info">
        <div class="plan-item__name">${item.store_name}</div>
        <div class="plan-item__meta">${[meta, overdue].filter(Boolean).join(' · ')}${timeHtml}</div>
      </div>
      ${moveHtml}
      ${actionsBtn}
    </div>`;
}

// ── Move up / down within a day ────────────────────────────────────

async function movePlanItemUp(id) {
  const item = document.querySelector(`[data-plan-id="${id}"]`);
  if (!item) return;
  const week   = item.dataset.week;
  const dayNum = parseInt(item.dataset.day);
  const siblings = [...document.querySelectorAll(`[data-day="${dayNum}"]`)]
    .filter(node => node.closest(`#plan-week-${week}`));
  const idx = siblings.indexOf(item);
  if (idx <= 0) return;
  const aboveId = parseInt(siblings[idx - 1].dataset.planId);
  await Promise.all([
    api('PATCH', `/api/planner/items/${id}`,      { position: idx }),
    api('PATCH', `/api/planner/items/${aboveId}`, { position: idx + 1 }),
  ]);
  _plannerWeekCache.delete(week);
  loadPlanner();
}
window.movePlanItemUp = movePlanItemUp;

async function movePlanItemDown(id) {
  const item = document.querySelector(`[data-plan-id="${id}"]`);
  if (!item) return;
  const week   = item.dataset.week;
  const dayNum = parseInt(item.dataset.day);
  const siblings = [...document.querySelectorAll(`[data-day="${dayNum}"]`)]
    .filter(node => node.closest(`#plan-week-${week}`));
  const idx = siblings.indexOf(item);
  if (idx >= siblings.length - 1) return;
  const belowId = parseInt(siblings[idx + 1].dataset.planId);
  await Promise.all([
    api('PATCH', `/api/planner/items/${id}`,      { position: idx + 2 }),
    api('PATCH', `/api/planner/items/${belowId}`, { position: idx + 1 }),
  ]);
  _plannerWeekCache.delete(week);
  loadPlanner();
}
window.movePlanItemDown = movePlanItemDown;

// ── Plan actions sheet ─────────────────────────────────────────────

function openPlanActions(itemId) {
  _planActionItemId = itemId;

  const itemEl = document.querySelector(`[data-plan-id="${itemId}"]`);
  const name = itemEl?.querySelector('.plan-item__name')?.textContent || 'Store';
  _planActionWeek = itemEl?.dataset.week || _plannerWeek;

  el('plan-actions-title').textContent = name;
  el('plan-confirm-time').value = '';

  // Populate move-to-week selector
  const weeks = _plannerQuarter ? _quarterWeeks(_plannerQuarter, _plannerYear) : [];
  const sel = el('plan-move-week-select');
  sel.innerHTML = weeks.map(w => {
    const label = _fmtWeekShort(w);
    return `<option value="${w}"${w === _planActionWeek ? ' selected' : ''}>${label}</option>`;
  }).join('');

  // Reset day selector
  _moveStoreTargetDay = 1;
  document.querySelectorAll('.move-store-day-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.day) === 1)
  );

  el('modal-plan-actions').classList.remove('hidden');
}
window.openPlanActions = openPlanActions;

function closePlanActions() {
  el('modal-plan-actions').classList.add('hidden');
  _planActionItemId = null;
  _planActionWeek   = null;
}

el('plan-actions-close').addEventListener('click', closePlanActions);
el('plan-actions-backdrop').addEventListener('click', closePlanActions);

el('plan-confirm-btn').addEventListener('click', async () => {
  const time = el('plan-confirm-time').value;
  if (!time) { toast('Enter a time first.'); return; }
  const result = await api('PATCH', `/api/planner/items/${_planActionItemId}`, {
    status: 'confirmed',
    confirmed_time: time,
  });
  if (!result || result.error) { toast(result?.error || 'Update failed.'); return; }
  _plannerWeekCache.delete(_planActionWeek);
  closePlanActions();
  loadPlanner();
});

el('plan-remove-btn').addEventListener('click', async () => {
  const result = await api('DELETE', `/api/planner/items/${_planActionItemId}`);
  if (!result || result.error) { toast(result?.error || 'Remove failed.'); return; }
  _plannerWeekCache.delete(_planActionWeek);
  closePlanActions();
  loadPlanner();
});

async function setPlanItemStatus(status) {
  const result = await api('PATCH', `/api/planner/items/${_planActionItemId}`, { status });
  if (!result || result.error) { toast(result?.error || 'Update failed.'); return; }
  _plannerWeekCache.delete(_planActionWeek);
  closePlanActions();
  loadPlanner();
}
window.setPlanItemStatus = setPlanItemStatus;

async function movePlanItemToDay(day) {
  const result = await api('PATCH', `/api/planner/items/${_planActionItemId}`, { day_of_week: day });
  if (!result || result.error) { toast(result?.error || 'Move failed.'); return; }
  _plannerWeekCache.delete(_planActionWeek);
  closePlanActions();
  loadPlanner();
}
window.movePlanItemToDay = movePlanItemToDay;

function selectMoveStoreDay(day) {
  _moveStoreTargetDay = day;
  document.querySelectorAll('.move-store-day-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.day) === day)
  );
}
window.selectMoveStoreDay = selectMoveStoreDay;

async function confirmMoveStoreToWeek() {
  const targetWeek = el('plan-move-week-select').value;
  if (!targetWeek) return;
  const result = await api('PATCH', `/api/planner/items/${_planActionItemId}`, {
    planned_week: targetWeek,
    day_of_week:  _moveStoreTargetDay,
  });
  if (!result || result.error) { toast(result?.error || 'Move failed.'); return; }
  _plannerWeekCache.delete(_planActionWeek);
  _plannerWeekCache.delete(targetWeek);
  closePlanActions();
  loadPlanner();
}
window.confirmMoveStoreToWeek = confirmMoveStoreToWeek;

// ── Move Day modal ─────────────────────────────────────────────────

function openMoveDayModal(week, day) {
  _moveDayFromWeek = week;
  _moveDayFromDay  = parseInt(day);
  const DAY_NAMES  = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

  el('move-day-title').textContent = `Move ${DAY_NAMES[_moveDayFromDay] || 'Day'} stores`;

  // Populate week selector (exclude source week)
  const weeks = _plannerQuarter ? _quarterWeeks(_plannerQuarter, _plannerYear) : [];
  const sel = el('move-day-week-select');
  sel.innerHTML = weeks.map(w => {
    const label = _fmtWeekShort(w);
    return `<option value="${w}"${w === week ? ' selected' : ''}>${label}</option>`;
  }).join('');

  // Reset target day
  _moveDayTargetDay = 1;
  document.querySelectorAll('.move-day-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.day) === 1)
  );

  el('modal-move-day').classList.remove('hidden');
}
window.openMoveDayModal = openMoveDayModal;

function closeMoveDayModal() {
  el('modal-move-day').classList.add('hidden');
  _moveDayFromWeek = null;
  _moveDayFromDay  = null;
}

el('move-day-close').addEventListener('click', closeMoveDayModal);
el('move-day-backdrop').addEventListener('click', closeMoveDayModal);

function selectMoveDayTarget(day) {
  _moveDayTargetDay = day;
  document.querySelectorAll('.move-day-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.day) === day)
  );
}
window.selectMoveDayTarget = selectMoveDayTarget;

el('move-day-confirm-btn').addEventListener('click', async () => {
  const targetWeek = el('move-day-week-select').value;
  if (!targetWeek || !_moveDayFromWeek) return;
  const result = await api('POST', '/api/planner/move-day', {
    from_week:   _moveDayFromWeek,
    from_day:    _moveDayFromDay,
    to_week:     targetWeek,
    to_day:      _moveDayTargetDay,
    rep_id:      _plannerRepId || undefined,
  });
  if (!result || result.error) { toast(result?.error || 'Move failed.'); return; }
  _plannerWeekCache.delete(_moveDayFromWeek);
  _plannerWeekCache.delete(targetWeek);
  closeMoveDayModal();
  toast(`Moved ${result.moved ?? ''} stores.`);
  loadPlanner();
});

// ── Add store manually ─────────────────────────────────────────────

let _addPlanStoreSearchTimer = null;

function openAddPlanStore(week) {
  if (week) _plannerWeek = week;
  _addPlanDay = 1;
  document.querySelectorAll('.add-day-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.day) === 1)
  );
  el('add-plan-store-search').value = '';
  el('add-plan-store-list').innerHTML = '<div class="text-muted text-sm" style="padding:16px">Type to search stores…</div>';
  el('modal-add-plan-store').classList.remove('hidden');
  setTimeout(() => el('add-plan-store-search').focus(), 100);
}
window.openAddPlanStore = openAddPlanStore;

function closeAddPlanStore() {
  el('modal-add-plan-store').classList.add('hidden');
}
window.closeAddPlanStore = closeAddPlanStore;

function selectAddPlanDay(day) {
  _addPlanDay = day;
  document.querySelectorAll('.add-day-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.day) === day)
  );
}
window.selectAddPlanDay = selectAddPlanDay;

el('add-plan-store-search').addEventListener('input', () => {
  clearTimeout(_addPlanStoreSearchTimer);
  _addPlanStoreSearchTimer = setTimeout(searchAddPlanStores, 250);
});

async function searchAddPlanStores() {
  const q = el('add-plan-store-search').value.trim();
  const list = el('add-plan-store-list');

  const repParam = _plannerRepId ? `&rep_id=${_plannerRepId}` : '';
  const stores = await api('GET', `/api/planner/overdue-stores?q=${encodeURIComponent(q)}${repParam}`);

  if (!stores || !Array.isArray(stores)) {
    list.innerHTML = '<div class="text-muted text-sm" style="padding:16px">No results.</div>';
    return;
  }

  if (stores.length === 0) {
    list.innerHTML = '<div class="text-muted text-sm" style="padding:16px">No stores found.</div>';
    return;
  }

  list.innerHTML = stores.map(s => {
    const grade = s.grade || 'P';
    const meta = [s.state, s.postcode, s.days_since_visit != null ? `${s.days_since_visit}d overdue` : ''].filter(Boolean).join(' · ');
    return `
      <div class="store-pick-row" onclick="addStoreToPlan(${s.id})">
        <span class="grade-badge grade-badge--${grade}" style="flex-shrink:0;">${grade}</span>
        <div class="store-pick-row__info">
          <div style="font-weight:600;font-size:0.875rem;">${s.name}</div>
          <div style="font-size:0.75rem;color:var(--color-muted);">${meta}</div>
        </div>
      </div>`;
  }).join('');
}

async function addStoreToPlan(storeId) {
  const body = {
    store_id:     storeId,
    planned_week: _plannerWeek,
    day_of_week:  _addPlanDay,
  };
  if (_plannerRepId) body.rep_id = _plannerRepId;

  const result = await api('POST', '/api/planner/items', body);
  if (!result || result.error) {
    toast(result?.error || 'Failed to add store.');
    return;
  }
  _plannerWeekCache.delete(_plannerWeek);
  closeAddPlanStore();
  toast('Store added to plan.');
  loadPlanner();
}
window.addStoreToPlan = addStoreToPlan;

// ── Manager team view ──────────────────────────────────────────────

async function openPlannerTeamView() {
  const { quarter, year } = _currentQuarter();
  const teamWeek = _plannerWeek || _quarterWeeks(quarter, year)[0];
  const page = el('page-planner');
  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Team Plans</h1>
    </div>
    <div class="planner-quarter-nav">
      <button class="btn-icon-sm" onclick="shiftPlannerTeamWeek(-1)">&#8592;</button>
      <div class="planner-week-label" id="planner-team-week-label">${_fmtPlannerWeek(teamWeek)}</div>
      <button class="btn-icon-sm" onclick="shiftPlannerTeamWeek(1)">&#8594;</button>
    </div>
    <div id="planner-team-wrap">
      <div class="skeleton-block" style="height:160px;margin-top:12px;"></div>
    </div>`;

  loadPlannerTeamData(teamWeek);
}
window.openPlannerTeamView = openPlannerTeamView;

function shiftPlannerTeamWeek(dir) {
  const labelEl = el('planner-team-week-label');
  const curWeek = labelEl?._week || _plannerWeek || _quarterWeeks(_plannerQuarter || _currentQuarter().quarter, _plannerYear || _currentQuarter().year)[0];
  const nextWeek = dir < 0 ? _prevWeek(curWeek) : _nextWeek(curWeek);
  if (labelEl) { labelEl.textContent = _fmtPlannerWeek(nextWeek); labelEl._week = nextWeek; }
  loadPlannerTeamData(nextWeek);
}
window.shiftPlannerTeamWeek = shiftPlannerTeamWeek;

async function loadPlannerTeamData(week) {
  const wrap = el('planner-team-wrap');
  if (!wrap) return;
  const w = week || _plannerWeek || _quarterWeeks(_plannerQuarter || _currentQuarter().quarter, _plannerYear || _currentQuarter().year)[0];
  const data = await api('GET', `/api/planner/team?week=${w}`);
  if (!data || data.error || !data.reps) {
    wrap.innerHTML = '<div class="empty-state__desc">Could not load team plans.</div>';
    return;
  }
  renderPlannerTeamTable(wrap, data);
}

function renderPlannerTeamTable(wrap, data) {
  const rows = data.reps.map(rep => {
    const submittedBadge = rep.submitted
      ? '<span class="kpi-dot kpi-dot--green" title="Submitted"></span>'
      : '<span class="kpi-dot kpi-dot--red"   title="Not submitted"></span>';
    return `
      <tr>
        <td class="kpi-team__rep">
          <button class="btn btn--ghost btn--sm" onclick="viewRepPlan(${rep.rep_id}, '${rep.rep_name.replace(/'/g, '\\&#39;')}')" style="font-weight:600;">
            ${rep.rep_name}
          </button>
        </td>
        <td>${submittedBadge}</td>
        <td>${rep.total}</td>
        <td>${rep.confirmed}</td>
        <td>${rep.completed}</td>
      </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="card" style="padding:0;overflow:hidden;margin-top:12px;">
      <table class="kpi-team-table">
        <thead>
          <tr>
            <th>Rep</th>
            <th>Submitted</th>
            <th>Stores</th>
            <th>Confirmed</th>
            <th>Done</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <button class="btn btn--ghost btn--full" onclick="loadPlanner()" style="margin-top:var(--space-3);">
      ← Back to My Plan
    </button>`;
}

async function viewRepPlan(repId, repName) {
  _plannerRepId   = repId;
  _plannerRepName = repName || 'Rep';
  _plannerWeekCache.clear();
  _plannerExpandedWeeks.clear();
  loadPlanner();
}
window.viewRepPlan = viewRepPlan;

function resetPlannerToSelf() {
  _plannerRepId   = null;
  _plannerRepName = null;
  _plannerWeekCache.clear();
  _plannerExpandedWeeks.clear();
  loadPlanner();
}
window.resetPlannerToSelf = resetPlannerToSelf;

// ── Expose globals for inline onclick handlers ────────────────────────────────
window.openUserModal      = openUserModal;
window.resetPassword      = resetPassword;
window.openLogVisitModal  = openLogVisitModal;
window.closeLogVisitModal = closeLogVisitModal;
window.ackAlert           = ackAlert;
window.runAlerts          = runAlerts;
window.openSkuDetail      = openSkuDetail;
window.closeSkuDetail     = closeSkuDetail;
window.openImportModal    = openImportModal;
window.closeImportModal   = closeImportModal;
window.importFileSelected = importFileSelected;
window.runImport          = runImport;
window.resetImportModal   = resetImportModal;
window.submitWeeklyPlan    = submitWeeklyPlan;
window.renderIncentiveGrid = renderIncentiveGrid;
window.exportKpiCsv        = exportKpiCsv;
window.runGrading          = runGrading;
window.refreshInvoiceCache = refreshInvoiceCache;
window.openAddPlanStore       = openAddPlanStore;
window.closeAddPlanStore      = closeAddPlanStore;
window.selectAddPlanDay       = selectAddPlanDay;
window.addStoreToPlan         = addStoreToPlan;
window.openPlanActions        = openPlanActions;
window.setPlanItemStatus      = setPlanItemStatus;
window.movePlanItemToDay      = movePlanItemToDay;
window.movePlanItemUp         = movePlanItemUp;
window.movePlanItemDown       = movePlanItemDown;
window.selectMoveStoreDay     = selectMoveStoreDay;
window.confirmMoveStoreToWeek = confirmMoveStoreToWeek;
window.openMoveDayModal       = openMoveDayModal;
window.selectMoveDayTarget    = selectMoveDayTarget;
window.generatePlannerWeek    = generatePlannerWeek;
window.generatePlannerQuarter = generatePlannerQuarter;
window.submitPlannerWeek      = submitPlannerWeek;
window.shiftPlannerQuarter    = shiftPlannerQuarter;
window.togglePlannerWeek      = togglePlannerWeek;
window.openPlannerTeamView    = openPlannerTeamView;
window.shiftPlannerTeamWeek   = shiftPlannerTeamWeek;
window.viewRepPlan            = viewRepPlan;
window.resetPlannerToSelf     = resetPlannerToSelf;

// ── Boot ──────────────────────────────────────────────────────────────────────
boot();
