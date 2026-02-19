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

// ── Dashboard (placeholder — content in Prompt 4) ────────────────────────────
function loadDashboard() {
  const now = new Date();
  el('dash-subtitle').textContent = now.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });

  // Skeletons will be replaced with real data in Prompt 4
  document.querySelectorAll('#page-dashboard .skeleton-block').forEach(s => {
    s.style.display = 'block';
  });
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
