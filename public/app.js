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

  // Show skeletons
  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Dashboard</h1>
      <button class="btn-icon-sm" id="btn-dash-refresh" title="Refresh data">↻</button>
    </div>
    <div class="skeleton-block" style="height:140px;"></div>
    <div class="skeleton-block" style="height:80px;"></div>
    <div class="skeleton-block" style="height:180px;"></div>
    <div class="skeleton-block skeleton-block--sm"></div>`;

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

// ── Visits (placeholder — content in Prompt 5) ───────────────────────────────
function loadVisits() {
  // Placeholder — real implementation in Prompt 5
}

// ── Stores (placeholder — content in Prompt 6) ───────────────────────────────
function loadStores() {
  // Placeholder — real implementation in Prompt 6
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
window.openUserModal  = openUserModal;
window.resetPassword  = resetPassword;

// ── Boot ──────────────────────────────────────────────────────────────────────
boot();
