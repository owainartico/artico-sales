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
    case 'dashboard': loadDashboard(); break;
    case 'visits':    loadVisits();    break;
    case 'stores':    loadStores();    break;
    case 'targets':   loadTargets();   break;
    case 'admin':     loadAdmin();     break;
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

  if (_dashChart) { _dashChart.destroy(); _dashChart = null; }

  if (isManager) renderTeamDashboard(page, data);
  else           renderRepDashboard(page, data);
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
  const { hero, ytd, monthly_history, brand_breakdown, quick_stats, month } = d;
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
        <div class="stat-mini__lbl">New Doors</div>
      </div>
      <div class="card stat-mini">
        <div class="stat-mini__val">${quick_stats.visits_this_month}</div>
        <div class="stat-mini__lbl">Visits</div>
      </div>
      <div class="card stat-mini ${quick_stats.overdue_stores > 0 ? 'stat-mini--alert' : ''}">
        <div class="stat-mini__val">${quick_stats.overdue_stores}</div>
        <div class="stat-mini__lbl">60d Unvisited</div>
      </div>
    </div>`;

  renderSparkline('chart-monthly', monthly_history);
}

// ── Team dashboard renderer ───────────────────────────────────────────────────

function renderTeamDashboard(page, d) {
  const { leaderboard, totals, ytd, brand_performance, new_doors_by_rep, monthly_history, month } = d;

  const leaderRows = leaderboard.map((r, i) => {
    const pc = pctClass(r.percentage);
    return `
      <div class="leader-row">
        <div class="leader-row__rank text-muted">${i + 1}</div>
        <div class="leader-row__info">
          <div class="leader-row__name">${r.name}</div>
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

    <!-- Company sparkline -->
    <div class="card">
      <div class="card__title">Company Revenue — Last 12 Months</div>
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

    <!-- New doors -->
    <div class="card">
      <div class="card__title">New Doors This Month</div>
      ${doorRows}
    </div>`;

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
let _storesView         = 'list';   // 'list' | 'new-doors'
let _storesSearch       = '';
let _storesGrade        = '';
let _storesState        = '';
let _storesVisitStatus  = '';
let _storesRepFilter    = '';
let _storesCurrentId    = null;
let _storesCurrentData  = null;  // full store object from /api/stores/:id
let _newDoorsMonth      = null;

// ── Entry point ────────────────────────────────────────────────────
async function loadStores() {
  const page = el('page-stores');
  const isManager = ['manager', 'executive'].includes(currentUser.role);

  // Reset search state on fresh load
  _storesSearch = ''; _storesGrade = ''; _storesState = '';
  _storesVisitStatus = ''; _storesRepFilter = '';

  page.innerHTML = `
    <!-- View toggle -->
    <div class="page-header" style="margin-bottom:0;">
      <div class="view-toggle">
        <button class="view-toggle__btn ${_storesView === 'list' ? 'active' : ''}" onclick="switchStoresView('list')">Stores</button>
        <button class="view-toggle__btn ${_storesView === 'new-doors' ? 'active' : ''}" onclick="switchStoresView('new-doors')">New Doors</button>
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
          </select>` : ''}
      </div>
      <div id="stores-list">
        <div class="skeleton-block"></div>
        <div class="skeleton-block skeleton-block--sm"></div>
      </div>
    </div>

    <!-- New Doors view -->
    <div id="new-doors-view" class="${_storesView !== 'new-doors' ? 'hidden' : ''}">
      <div id="new-doors-content">
        <div class="skeleton-block"></div>
        <div class="skeleton-block skeleton-block--sm"></div>
      </div>
    </div>`;

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
  } else {
    loadNewDoors(_newDoorsMonth);
  }
}

function switchStoresView(view) {
  _storesView = view;
  const listView   = el('stores-list-view');
  const doorsView  = el('new-doors-view');
  document.querySelectorAll('.view-toggle__btn').forEach(b =>
    b.classList.toggle('active', b.textContent.trim().toLowerCase().replace(' ', '-') === view ||
      (view === 'list' && b.textContent.includes('Stores')))
  );
  if (view === 'list') {
    listView?.classList.remove('hidden');
    doorsView?.classList.add('hidden');
    loadStoreList();
  } else {
    listView?.classList.add('hidden');
    doorsView?.classList.remove('hidden');
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
  loadStoreList();
}
window.storesFilterChanged = storesFilterChanged;

async function loadStoreList() {
  const wrap = el('stores-list');
  if (!wrap) return;
  wrap.innerHTML = '<div class="skeleton-block"></div>';

  const params = new URLSearchParams();
  if (_storesSearch)      params.set('q', _storesSearch);
  if (_storesGrade)       params.set('grade', _storesGrade);
  if (_storesVisitStatus) params.set('visit_status', _storesVisitStatus);
  if (_storesRepFilter)   params.set('rep_id', _storesRepFilter);

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

  wrap.innerHTML = `
    <div class="section-label">${stores.length} store${stores.length !== 1 ? 's' : ''}</div>
    ${stores.map(s => `
      <div class="card store-row" onclick="openStoreDetail(${s.id})">
        <div class="store-row__main">
          <span class="grade-badge grade-badge--${(s.grade || 'c').toLowerCase()}">${s.grade || '?'}</span>
          <div class="store-row__info">
            <div class="store-row__name">${escHtml(s.name)}</div>
            <div class="store-row__sub text-sm text-muted">
              ${[s.channel_type, s.state].filter(Boolean).join(' · ')}
              ${isManager && s.rep_name ? ` · ${escHtml(s.rep_name)}` : ''}
            </div>
          </div>
          <div class="store-row__visit">
            <div class="text-sm ${visitStatusClass(s.days_since_visit)} fw-bold">
              ${visitStatusLabel(s.days_since_visit)}
            </div>
            ${s.last_visit_at ? `<div class="text-xs text-muted">${new Date(s.last_visit_at).toLocaleDateString('en-AU', { day:'numeric', month:'short'})}</div>` : ''}
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
  if (data.grade) {
    el('store-detail-grade').textContent = data.grade;
    el('store-detail-grade').className   = `grade-badge grade-badge--${data.grade.toLowerCase()}`;
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

    <!-- Order info -->
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
    </div>

    <!-- Visit history -->
    <div class="section-label">Visit History</div>
    <div class="card" style="padding:var(--space-3);">
      ${visitHistHtml}
    </div>`;
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
      <div class="dash-hero__target text-muted">New Doors in ${fmtMonthLong(month)}</div>
      <div class="text-sm text-muted" style="margin-top:var(--space-2);">Total value: ${fmt(data.totals.value)}</div>
    </div>`;

  if (data.doors.length === 0) {
    wrap.innerHTML = monthSel + summaryCard + `
      <div class="empty-state">
        <div class="empty-state__icon">🚪</div>
        <div class="empty-state__title">No new doors</div>
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

// ── Expose globals for inline onclick handlers ────────────────────────────────
window.openUserModal     = openUserModal;
window.resetPassword     = resetPassword;
window.openLogVisitModal = openLogVisitModal;
window.closeLogVisitModal = closeLogVisitModal;

// ── Boot ──────────────────────────────────────────────────────────────────────
boot();
