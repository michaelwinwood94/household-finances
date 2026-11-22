import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js?v=202611230055';
import { parseBankCsv, parseWestpacActivity, splitAccounts, linesFromItems } from './csv.js?v=202611230055';
import { readPayslip, toLines } from './payslip.js?v=202611230055';
import { toast, softDelete, busy, friendlyError, watchOnline, info, wireInfoTips, skeleton, wireInstall, applyPrefs, settingsMenu, prefs, setPref, store } from './ui.js?v=202611230055';
import { columnChart, hbarChart, SERIES, moneyRound, moneyCompact } from './charts.js?v=202611230055';

const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');

// ---------- small helpers ----------
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
const money = n => n == null || n === '' ? '—' : AUD.format(Number(n));
const today = () => new Date().toLocaleDateString('en-CA'); // yyyy-mm-dd in local time
const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const daysFromToday = d => Math.round((new Date(d + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);
async function q(promise) {
  const { data, error } = await promise;
  if (error) { console.error(error); toast(friendlyError(error), { ms: 7000, kind: 'bad' }); throw error; }
  return data;
}
const label = (s) => String(s ?? '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

// ---------- lookups (accounts, categories, debts) ----------
const cache = { accounts: [], categories: [], debts: [], settings: null };
async function loadLookups() {
  const [a, c, d, s] = await Promise.all([
    q(sb.from('accounts').select('*').order('name')),
    q(sb.from('categories').select('*').order('sort_order').order('name')),
    q(sb.from('debts').select('id, creditor, status').order('creditor')),
    q(sb.from('settings').select('*').maybeSingle()),
  ]);
  Object.assign(cache, { accounts: a, categories: c, debts: d, settings: s });
}
const refOptions = {
  accounts: () => cache.accounts.map(a => [a.id, a.name]),
  categories: () => cache.categories.map(c => [c.id, `${c.name} (${c.kind})`]),
  debts: () => cache.debts.map(d => [d.id, d.creditor]),
};
const refName = (ref, id) => { if (!id) return '—'; const o = refOptions[ref]().find(([v]) => v === id); return o ? o[1].replace(/ \((income|expense|transfer)\)$/, '') : '—'; };

const FREQ = ['once', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly'];
const PER_MONTH = { once: 0, weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
const sum = (rows, fn) => rows.reduce((t, r) => t + Number(fn(r) || 0), 0);

// ---------- table definitions for the add/edit forms ----------
const TABLES = {
  accounts: {
    title: 'Bank accounts', order: ['name'],
    fields: [
      { k: 'name', label: 'Account name', type: 'text', required: true, hint: 'e.g. Westpac Everyday' },
      { k: 'institution', label: 'Bank', type: 'select', options: ['Westpac', 'CommBank', 'Other'] },
      { k: 'account_type', label: 'Type', type: 'select', options: ['transaction', 'savings', 'offset', 'credit_card', 'loan', 'mortgage', 'cash', 'other'] },
      { k: 'nickname_last4', label: 'Last 4 digits (optional)', type: 'text', hint: 'Only the last 4 digits — never the full number' },
      { k: 'opening_balance', label: 'Balance at start date', type: 'number', default: 0 },
      { k: 'opening_date', label: 'Start date', type: 'date', default: today, hint: 'Balance is calculated from this date using imported transactions' },
      { k: 'is_joint', label: 'Joint / shared account', type: 'checkbox', hint: 'e.g. an account shared with your ex-partner' },
      { k: 'my_share_pct', label: 'My share % (joint accounts)', type: 'number', default: 100 },
      { k: 'is_active', label: 'Active', type: 'checkbox', default: true },
    ],
    columns: ['name', 'institution', 'account_type', 'nickname_last4', 'is_joint', 'my_share_pct'],
  },
  categories: {
    title: 'Categories', order: ['sort_order', 'name'],
    fields: [
      { k: 'name', label: 'Name', type: 'text', required: true },
      { k: 'kind', label: 'Kind', type: 'select', options: ['expense', 'income', 'transfer'] },
      { k: 'is_essential', label: 'Essential (must-pay)', type: 'checkbox' },
      { k: 'monthly_budget', label: 'Monthly budget', type: 'number', hint: 'Leave blank for no budget' },
      { k: 'sort_order', label: 'Sort order', type: 'number', default: 100 },
    ],
    columns: ['name', 'kind', 'is_essential', 'monthly_budget'],
    footer: rows => ({ monthly_budget: money(sum(rows, r => r.monthly_budget)) }),
  },
  category_rules: {
    title: 'Auto-categorising rules', order: ['priority', 'match_text'],
    fields: [
      { k: 'match_text', label: 'If the description contains', type: 'text', required: true, hint: 'Not case sensitive, e.g. WOOLWORTHS' },
      { k: 'match_type', label: 'Match type', type: 'select', options: ['contains', 'starts_with', 'exact'] },
      { k: 'direction', label: 'Applies to', type: 'select', options: ['any', 'in', 'out'], hint: 'in = money in, out = money out' },
      { k: 'category_id', label: 'Then set category to', type: 'ref', ref: 'categories', required: true },
      { k: 'mark_shared', label: 'Also add to shared costs', type: 'checkbox' },
      { k: 'priority', label: 'Priority (lower wins)', type: 'number', default: 100 },
      { k: 'is_active', label: 'Active', type: 'checkbox', default: true },
    ],
    columns: ['match_text', 'direction', 'category_id', 'mark_shared', 'priority'],
  },
  recurring_items: {
    title: 'Bills & income', order: ['next_due'],
    fields: [
      { k: 'name', label: 'Name', type: 'text', required: true, hint: 'e.g. Synergy power, Centrelink' },
      { k: 'direction', label: 'Money in or out', type: 'select', options: ['out', 'in'] },
      { k: 'amount', label: 'Amount (full bill)', type: 'number', required: true },
      { k: 'frequency', label: 'How often', type: 'select', options: FREQ, default: 'monthly' },
      { k: 'next_due', label: 'Next due date', type: 'date', required: true, default: today },
      { k: 'category_id', label: 'Category', type: 'ref', ref: 'categories' },
      { k: 'account_id', label: 'Paid from / into', type: 'ref', ref: 'accounts' },
      { k: 'debt_id', label: 'Linked debt', type: 'ref', ref: 'debts', hint: 'Set this for a loan repayment — it then counts once, under Debts, on the Budget page' },
      { k: 'match_text', label: 'Text on bank statement', type: 'text', hint: 'When an imported transaction contains this, the bill is marked paid and the due date moves on' },
      { k: 'is_shared', label: 'Shared with ex-partner', type: 'checkbox' },
      { k: 'my_share_pct', label: 'My share %', type: 'number', default: 100 },
      { k: 'is_active', label: 'Active', type: 'checkbox', default: true },
      { k: 'notes', label: 'Notes', type: 'textarea' },
    ],
    columns: ['name', 'direction', 'amount', 'frequency', 'next_due', 'is_shared', 'my_share_pct'],
    footer: rows => {
      const m = (dir, share) => sum(rows.filter(r => r.is_active && r.direction === dir), r => r.amount * PER_MONTH[r.frequency] * (share ? r.my_share_pct / 100 : 1));
      const inAll = m('in'), outAll = m('out'), inMe = m('in', 1), outMe = m('out', 1);
      return `Per month (including loan repayments) — <b>household:</b> in ${money(inAll)} · out ${money(outAll)} · left ${money(inAll - outAll)}
        &nbsp;|&nbsp; <b>${esc(cache.settings?.display_name || 'my')} share:</b> in ${money(inMe)} · out ${money(outMe)} · left ${money(inMe - outMe)}
        <br><span class="hint">Afterpay, Deferit and Latitude aren't bills here — they're counted under Debts.</span>`;
    },
  },
  debts: {
    title: 'Debts', order: ['priority', 'creditor'],
    fields: [
      { k: 'creditor', label: 'Who is owed', type: 'text', required: true },
      { k: 'debt_type', label: 'Type', type: 'select', options: ['mortgage', 'car_loan', 'personal_loan', 'credit_card', 'bnpl', 'utility', 'tax', 'fine', 'court', 'centrelink', 'family', 'other'] },
      { k: 'current_balance', label: 'Current balance', type: 'number', required: true, hint: 'Updates automatically if a loan account is linked below' },
      { k: 'account_id', label: 'Linked loan account', type: 'ref', ref: 'accounts', hint: 'For home loans etc. — the balance then follows your imported statements' },
      { k: 'balance_as_at', label: 'Balance as at', type: 'date', default: today },
      { k: 'original_balance', label: 'Original amount', type: 'number' },
      { k: 'arrears_amount', label: 'Arrears (overdue amount)', type: 'number', default: 0 },
      { k: 'interest_rate_pct', label: 'Interest rate %', type: 'number' },
      { k: 'min_payment', label: 'Minimum payment', type: 'number' },
      { k: 'payment_frequency', label: 'Payment frequency', type: 'select', options: FREQ, default: 'monthly' },
      { k: 'priority', label: 'Priority (1 = most urgent)', type: 'select', options: ['1', '2', '3', '4', '5'], default: '3', hint: '1 = keeps a roof over your head / power on' },
      { k: 'hardship_status', label: 'Hardship arrangement', type: 'select', options: ['none', 'to_request', 'requested', 'approved', 'declined', 'expired'] },
      { k: 'hardship_until', label: 'Hardship ends', type: 'date' },
      { k: 'status', label: 'Status', type: 'select', options: ['active', 'paid_off', 'closed', 'disputed'] },
      { k: 'is_shared', label: 'Shared debt', type: 'checkbox' },
      { k: 'my_share_pct', label: 'My share %', type: 'number', default: 100 },
      { k: 'reference_note', label: 'Reference', type: 'text', hint: 'e.g. "loan ending 4417" — never full account numbers' },
      { k: 'notes', label: 'Notes', type: 'textarea' },
    ],
    columns: ['priority', 'creditor', 'debt_type', 'current_balance', 'arrears_amount', 'min_payment', 'hardship_status', 'status'],
    footer: rows => {
      const act = rows.filter(r => r.status === 'active');
      return {
        current_balance: money(sum(act, r => r.current_balance)),
        arrears_amount: money(sum(act, r => r.arrears_amount)),
        min_payment: `${money(sum(act, r => r.min_payment * PER_MONTH[r.payment_frequency || 'monthly']))}<br><span class="hint">per month</span>`,
        hardship_status: `<span class="hint">active debts only</span>`,
      };
    },
  },
  debt_contacts: {
    title: 'Contact log', order: ['contact_date'], desc: true,
    fields: [
      { k: 'contact_date', label: 'Date', type: 'date', default: today },
      { k: 'method', label: 'How', type: 'select', options: ['phone', 'email', 'letter', 'online', 'in_person', 'counsellor'] },
      { k: 'spoke_to', label: 'Spoke to', type: 'text' },
      { k: 'reference_number', label: 'Call / reference number', type: 'text' },
      { k: 'summary', label: 'What was discussed', type: 'textarea', required: true },
      { k: 'agreed', label: 'What was agreed', type: 'textarea' },
      { k: 'follow_up_date', label: 'Follow up by', type: 'date' },
      { k: 'follow_up_done', label: 'Follow-up done', type: 'checkbox' },
    ],
    columns: ['contact_date', 'method', 'spoke_to', 'summary', 'agreed', 'follow_up_date', 'follow_up_done'],
  },
  shared_ledger: {
    title: 'Shared costs', order: ['entry_date'], desc: true,
    fields: [
      { k: 'entry_date', label: 'Date', type: 'date', default: today },
      { k: 'entry_type', label: 'Type', type: 'select', options: ['expense', 'settlement'], hint: 'settlement = money paid between you to square up' },
      { k: 'description', label: 'What for', type: 'text', required: true },
      { k: 'total_amount', label: 'Total amount', type: 'number', required: true },
      { k: 'paid_by', label: 'Paid by', type: 'select', options: ['me', 'partner'] },
      { k: 'my_share_pct', label: 'My share %', type: 'number', default: () => cache.settings?.default_my_share_pct ?? 50, hint: 'Ignored for settlements' },
      { k: 'notes', label: 'Notes', type: 'textarea' },
    ],
    columns: ['entry_date', 'entry_type', 'description', 'total_amount', 'paid_by', 'my_share_pct'],
    footer: rows => {
      const exp = rows.filter(r => r.entry_type === 'expense'), set = rows.filter(r => r.entry_type === 'settlement');
      const partner = esc(cache.settings?.partner_label || 'Ex-partner');
      return `Shared expenses ${money(sum(exp, r => r.total_amount))} (you paid ${money(sum(exp.filter(r => r.paid_by === 'me'), r => r.total_amount))}, ${partner} paid ${money(sum(exp.filter(r => r.paid_by === 'partner'), r => r.total_amount))})
        · Settlements ${money(sum(set, r => r.total_amount))}`;
    },
  },
};

function cell(def, row, k) {
  if (VIRTUAL[k]) return VIRTUAL[k].html(row);
  const f = def.fields.find(x => x.k === k); const v = row[k];
  if (!f) return esc(v);
  if (f.type === 'ref') return esc(refName(f.ref, v));
  if (f.type === 'checkbox') return v ? '✔' : '';
  if (f.type === 'date') return esc(fmtDate(v));
  if (f.type === 'number' && /amount|balance|payment|budget/.test(k)) return money(v);
  if (k === 'hardship_status') return `<span class="pill ${v === 'approved' ? 'good' : v === 'to_request' ? 'warn' : ''}">${esc(label(v))}</span>`;
  if (k === 'creditor') return `<b>${esc(v)}</b>${row.priority <= 1 ? ' <span class="pill bad">priority</span>' : ''}${row.status !== 'active' ? ` <span class="pill">${esc(label(row.status))}</span>` : ''}`;
  if (k === 'priority' && def === TABLES.debts) return `<span class="pill ${v <= 1 ? 'bad' : v <= 2 ? 'warn' : ''}">${esc(v)}</span>`;
  if (k === 'paid_by') return v === 'partner' ? esc(cache.settings?.partner_label || 'Ex-partner') : 'Me';
  return esc(label(v));
}

TABLES.tax_extras = { title: 'Other costs or income', addTitle: 'cost or income', order: ['entry_date'],
  fields: [
    { k: 'kind', label: 'Type', type: 'select', options: ['expense', 'income'] },
    { k: 'description', label: 'What for', type: 'text', required: true, hint: 'e.g. toilet paper & cleaning supplies (cash), plumber' },
    { k: 'amount', label: 'Amount', type: 'number', required: true },
    { k: 'entry_date', label: 'Date', type: 'date', default: today },
    { k: 'apportion', label: 'Shared household cost (apportioned)', type: 'checkbox', default: true },
  ],
  columns: ['entry_date', 'kind', 'description', 'amount', 'apportion'],
  footer: rows => ({ amount: money(sum(rows.filter(r => r.kind === 'expense'), r => r.amount)) + '<div class="hint">costs</div>' }),
};

// Two views of the same bills/income table, with friendlier columns
const FREQ_WORD = { once: 'once', weekly: 'week', fortnightly: 'fortnight', monthly: 'month', quarterly: 'quarter', yearly: 'year' };
TABLES.bills = { ...TABLES.recurring_items, table: 'recurring_items', title: 'Your bills', order: ['next_due'], addTitle: 'bill',
  columns: ['name', 'amount_freq', 'who_month', 'next', 'share'],
  footer: rows => {
    const act = rows.filter(r => r.is_active);
    return { who_month: `<b>${money(sum(act, r => r.amount * PER_MONTH[r.frequency] * shareFor(r.my_share_pct)))}</b>`,
             name: `<b>Total per month</b><br><span class="hint">including loan repayments</span>` };
  } };
TABLES.income = { ...TABLES.recurring_items, table: 'recurring_items', title: 'Your income', order: ['next_due'], addTitle: 'income',
  fields: TABLES.recurring_items.fields.filter(f => f.k !== 'debt_id').map(f => f.k === 'match_text' ? { ...f, hint: 'When an imported deposit contains this, it is marked received and the date moves on' } : f),
  columns: ['name', 'amount_freq', 'who_month', 'next', 'share'],
  footer: rows => {
    const act = rows.filter(r => r.is_active);
    return { who_month: `<b>${money(sum(act, r => r.amount * PER_MONTH[r.frequency] * shareFor(r.my_share_pct)))}</b>`, name: `<b>Total per month</b>` };
  } };
TABLES.debts.columns = ['creditor', 'current_balance', 'arrears_amount', 'monthly', 'hardship_status', 'share'];
TABLES.debts.headers = { creditor: 'Owed to', current_balance: 'Balance', arrears_amount: 'Overdue', hardship_status: 'Hardship' };
TABLES.debts.footer = rows => {
  const act = rows.filter(r => r.status === 'active');
  return { creditor: '<b>Total</b> <span class="hint">(active)</span>', current_balance: `<b>${money(sum(act, r => r.current_balance))}</b>`,
    arrears_amount: money(sum(act, r => r.arrears_amount)), monthly: `<b>${money(sum(act, r => r.min_payment * PER_MONTH[r.payment_frequency || 'monthly']))}</b>` };
};
// Whose view a Bills/Income page is showing: 'all' | 'me' | 'partner'
let personView = (() => { try { return localStorage.getItem('personView') || 'all'; } catch { return 'all'; } })();
if (!['all', 'me', 'partner'].includes(personView)) personView = 'all';
const personNames = () => ({ all: 'Household', me: cache.settings?.display_name || 'Me', partner: cache.settings?.partner_label || 'Partner' });
const personName = () => personNames()[personView];
// Pages that change with the person switch; others show household figures and say so
const PERSON_PAGES = ['dashboard', 'budget', 'bills', 'income', 'debts', 'pay', 'tax'];
function renderWhoSwitch() {
  const box = $('#whoswitch'); if (!box) return;
  box.innerHTML = `<span class="who-label">Showing</span>` + Object.entries(personNames()).map(([k, v]) =>
    `<button class="${k === personView ? 'on' : ''}" data-person="${k}" aria-pressed="${k === personView}">${esc(v)}</button>`).join('');
  box.classList.toggle('dim', !PERSON_PAGES.includes(currentView));
  box.title = PERSON_PAGES.includes(currentView) ? '' : 'This page shows household figures';
  box.querySelectorAll('[data-person]').forEach(b => b.onclick = () => {
    personView = b.dataset.person; try { localStorage.setItem('personView', personView); } catch {}
    renderWhoSwitch(); if (PERSON_PAGES.includes(currentView)) show(currentView);
  });
}
const shareFor = (pct, who = personView) => { const m = Number(pct ?? 100) / 100; return who === 'me' ? m : who === 'partner' ? 1 - m : 1; };
const EMPTY = {
  accounts: 'No bank accounts yet. The easiest way is to <b>Import</b> a statement — accounts are created for you.',
  categories: 'No categories yet.', category_rules: 'No rules yet. Use <b>Make rule</b> on the Transactions or To sort page to create one from a real transaction.',
  bills: 'No bills yet. Add regular payments like power, insurance and loan repayments — or import statements and they’re found for you.',
  income: 'No income yet. Add JobSeeker, wages or board so the Budget can work out what’s left over.',
  debts: 'No debts recorded. Add each one — even small ones — so nothing gets forgotten.',
  debt_contacts: 'No calls logged yet. After every call or letter, add who you spoke to and what was agreed.',
  shared_ledger: 'No shared costs yet. Tick "Shared" on a transaction, or add one here.',
  tax_extras: 'Nothing extra yet.',
};
setTimeout(() => { for (const [k, v] of Object.entries(EMPTY)) if (TABLES[k]) TABLES[k].empty = v; });
const VIRTUAL = {
  who_month: { label: 'Per month', num: true, html: r => r.debt_id && r.direction === 'out' && personView === 'all' ? `${money(r.amount * PER_MONTH[r.frequency])}<div class="hint">in Debts</div>`
    : money(r.amount * PER_MONTH[r.frequency] * shareFor(r.my_share_pct)) },
  amount_freq: { label: 'Amount', num: true, html: r => `${money(r.amount)} <span class="hint">/ ${FREQ_WORD[r.frequency] || r.frequency}</span>` },
  per_month: { label: 'Per month', num: true, html: r => r.debt_id ? '<span class="hint">in Debts</span>' : money(r.amount * PER_MONTH[r.frequency]) },
  monthly: { label: 'Per month', num: true, html: r => r.min_payment ? money(r.min_payment * PER_MONTH[r.payment_frequency || 'monthly']) : '<span class="hint">—</span>' },
  next: { label: 'Next due', html: r => {
    if (!r.is_active) return '<span class="pill">paused</span>';
    const d = daysFromToday(r.next_due);
    const pill = d < 0 ? `<span class="pill bad">${r.direction === 'in' ? 'late' : 'overdue'}</span>` : d === 0 ? '<span class="pill warn">today</span>' : d <= 7 ? `<span class="pill warn">in ${d} day${d === 1 ? '' : 's'}</span>` : '';
    return `${esc(fmtDate(r.next_due))} ${pill}`; } },
  share: { label: 'Split', html: r => {
    const p = Number(r.my_share_pct ?? 100), who = cache.settings?.partner_label || 'partner';
    return `<span class="nowrap">${p === 100 ? 'All yours' : p === 0 ? `All ${esc(who)}'s` : `${p}% yours`}</span>`; } },
};

// ---------- categories: picker with "+ New category…" ----------
function catOptions(selected, { blank = '— choose —' } = {}) {
  const groups = { expense: 'Spending', income: 'Income', transfer: 'Not counted (transfers, loan interest)' };
  return `<option value="">${blank}</option>` + Object.entries(groups).map(([kind, lbl]) => {
    const list = cache.categories.filter(c => c.kind === kind);
    return list.length ? `<optgroup label="${lbl}">${list.map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>` : '';
  }).join('') + `<option value="__new">+ New category…</option>`;
}
function newCategoryDialog(defaultKind = 'expense') {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog"><h2>New category</h2>
      <label>Name <input name="n" required maxlength="60" placeholder="e.g. Pet costs"></label>
      <label>Kind <select name="k"><option value="expense">Spending</option><option value="income">Income</option><option value="transfer">Transfer (not counted as income or spending)</option></select></label>
      <label><input type="checkbox" name="e"> Essential (must-pay)</label>
      <label>Monthly budget (optional) <input type="number" step="0.01" name="b"></label>
      <div class="row"><button class="primary" value="save">Create</button><button value="cancel" formnovalidate>Cancel</button></div></form>`;
    document.body.appendChild(dlg);
    const f = $('form', dlg); f.k.value = defaultKind;
    let done = false;
    f.addEventListener('submit', async e => {
      if (e.submitter?.value !== 'save') return;
      e.preventDefault();
      try {
        const row = await q(sb.from('categories').insert({ name: f.n.value.trim(), kind: f.k.value, is_essential: f.e.checked,
          monthly_budget: f.b.value === '' ? null : Number(f.b.value) }).select().single());
        await loadLookups(); toast(`Category "${row.name}" created`); done = true; dlg.close(); resolve(row.id);
      } catch { /* e.g. name already exists — toast shown */ }
    });
    dlg.addEventListener('close', () => { dlg.remove(); if (!done) resolve(null); });
    dlg.showModal();
  });
}
// Wire a category <select>: handles "+ New category…" then calls onPick(id)
function wireCatSelect(sel, onPick, kindHint) {
  let prev = sel.value === '__new' ? '' : sel.value;
  sel.onchange = async () => {
    if (sel.value === '__new') {
      const id = await newCategoryDialog(kindHint);
      if (!id) { sel.value = prev; return; }
      sel.innerHTML = catOptions(id); sel.value = id;
    }
    prev = sel.value; await onPick(sel.value || null);
  };
}

// ---------- generic add / edit dialog ----------
function openForm(key, row = null, fixed = {}) {
  const def = TABLES[key];
  const table = def.table || key;
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    const fieldsHtml = def.fields.filter(f => !(f.k in fixed)).map(f => {
      let val = row ? row[f.k] : (typeof f.default === 'function' ? f.default() : f.default);
      const req = f.required ? 'required' : '';
      const hint = f.hint ? `<span class="hint">${esc(f.hint)}</span>` : '';
      if (f.type === 'checkbox') return `<label><input type="checkbox" name="${f.k}" ${val ? 'checked' : ''}> ${esc(f.label)} ${hint}</label>`;
      if (f.type === 'select' || f.type === 'ref') {
        if (f.type === 'ref' && f.ref === 'categories') return `<label>${esc(f.label)} ${hint}<select name="${f.k}" ${req} data-cat>${catOptions(val, { blank: '— none —' })}</select></label>`;
        const opts = f.type === 'ref' ? refOptions[f.ref]() : f.options.map(o => [o, label(o)]);
        const blank = f.type === 'ref' ? `<option value="">— none —</option>` : '';
        return `<label>${esc(f.label)} ${hint}<select name="${f.k}" ${req}>${blank}${opts.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(val ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
      }
      if (f.type === 'textarea') return `<label>${esc(f.label)} ${hint}<textarea name="${f.k}" rows="2" ${req}>${esc(val)}</textarea></label>`;
      const step = f.type === 'number' ? 'step="0.01"' : '';
      return `<label>${esc(f.label)} ${hint}<input type="${f.type}" name="${f.k}" value="${esc(val)}" ${step} ${req}></label>`;
    }).join('');
    dlg.innerHTML = `<form method="dialog"><h2>${row ? 'Edit' : 'Add'} — ${esc(def.addTitle || def.title)}</h2>
      <div class="formgrid">${fieldsHtml}</div>
      <div class="row"><button class="primary" value="save">Save</button><button value="cancel" formnovalidate>Cancel</button></div></form>`;
    document.body.appendChild(dlg);
    const form = $('form', dlg);
    form.querySelectorAll('select[data-cat]').forEach(sel => wireCatSelect(sel, () => {}));
    form.addEventListener('submit', async (e) => {
      if (e.submitter?.value !== 'save') return;
      e.preventDefault();
      const out = { ...fixed };
      for (const f of def.fields) {
        if (f.k in fixed) continue;
        const el = form.elements[f.k];
        if (f.type === 'checkbox') out[f.k] = el.checked;
        else if (f.type === 'number') out[f.k] = el.value === '' ? null : Number(el.value);
        else out[f.k] = el.value === '' ? null : el.value;
        if (f.k === 'priority' && out[f.k] != null) out[f.k] = Number(out[f.k]);
      }
      try {
        await busy(e.submitter, async () => {
          if (row) await q(sb.from(table).update(out).eq('id', row.id));
          else await q(sb.from(table).insert(out));
        });
        toast('Saved ✓'); dlg.close(); dlg.remove(); resolve(true);
      } catch { /* toast already shown; keep dialog open */ }
    });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(false); });
    dlg.showModal();
  });
}

function footerHtml(def, rows) {
  if (!def.footer || !rows.length) return '';
  const f = def.footer(rows);
  if (typeof f === 'string') return `<tfoot><tr class="total"><td colspan="${def.columns.length + 1}">${f}</td></tr></tfoot>`;
  return `<tfoot><tr class="total">${def.columns.map((k, i) => `<td class="${VIRTUAL[k]?.num || /amount|balance|payment|budget/.test(k) ? 'num' : ''}">${f[k] ?? (i === 0 ? `<b>Total</b> <span class="hint">(${rows.length})</span>` : '')}</td>`).join('')}<td></td></tr></tfoot>`;
}

async function renderCrud(container, key, { filter = {}, title, onChange, extra, subtitle, rowFilter, headers } = {}) {
  const def = TABLES[key];
  let query = sb.from(def.table || key).select('*');
  for (const [k, v] of Object.entries(filter)) query = query.eq(k, v);
  for (const o of def.order) query = query.order(o, { ascending: !def.desc });
  const rows = (await q(query)).filter(r => !rowFilter || rowFilter(r));
  const isNum = k => VIRTUAL[k]?.num || /amount|balance|payment|budget/.test(k);
  container.innerHTML = `<div class="sec-head"><div><h2>${esc(title || def.title)}</h2>${subtitle ? `<p class="hint">${subtitle}</p>` : ''}</div>
      <button class="primary add">+ Add</button></div>
    ${rows.length ? `<div class="tablewrap"><table class="list"><thead><tr>${def.columns.map(k => `<th class="${isNum(k) ? 'num' : ''}">${esc(headers?.[k] || def.headers?.[k] || VIRTUAL[k]?.label || def.fields.find(f => f.k === k)?.label || label(k))}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr class="${r.is_active === false ? 'muted' : ''}">${def.columns.map(k => `<td class="${isNum(k) ? 'num' : ''}" data-label="${esc(headers?.[k] || def.headers?.[k] || VIRTUAL[k]?.label || def.fields.find(f => f.k === k)?.label || label(k))}">${cell(def, r, k)}</td>`).join('')}
        <td class="actions">${extra ? extra(r, i) : ''}<button class="small edit" data-i="${i}">Edit</button><button class="small ghost del" data-i="${i}" title="Delete" aria-label="Delete">✕</button></td></tr>`).join('')}</tbody>
      ${footerHtml(def, rows)}</table></div>`
      : `<div class="empty-state">${def.empty || 'Nothing here yet.'}<br><button class="primary small add2">+ Add the first one</button></div>`}`;
  const changed = async () => { await loadLookups(); onChange ? await onChange() : await renderCrud(container, key, { filter, title, onChange, extra, subtitle, rowFilter, headers }); };
  $('.add', container).onclick = async () => { if (await openForm(key, null, filter)) await changed(); };
  $('.add2', container)?.addEventListener('click', async () => { if (await openForm(key, null, filter)) await changed(); });
  container.querySelectorAll('.edit').forEach(b => b.onclick = async () => { if (await openForm(key, rows[b.dataset.i], filter)) await changed(); });
  container.querySelectorAll('.del').forEach(b => b.onclick = () => {
    const tr = b.closest('tr'), row = rows[b.dataset.i];
    softDelete({ label: `Deleted "${row.name || row.creditor || row.description || row.match_text || 'entry'}"`,
      hide: () => tr.classList.add('hidden'), restore: () => tr.classList.remove('hidden'),
      commit: async () => { await q(sb.from(def.table || key).delete().eq('id', row.id)); await changed(); } });
  });
  return rows;
}

async function markPaid(itemId, due, after) {
  const next = await q(sb.rpc('mark_item_paid', { p_item_id: itemId }));
  // clear any alert about this due date
  await sb.from('alerts').update({ dismissed: true }).like('source_key', `%${itemId}:${due}`);
  toast(next ? `Marked paid — next due ${fmtDate(next)}` : 'Marked paid', { ms: 7000, action: 'Undo', onAction: async () => {
    await q(sb.from('recurring_items').update({ next_due: due, is_active: true }).eq('id', itemId));
    await sb.from('alerts').update({ dismissed: false }).like('source_key', `%${itemId}:${due}`);
    toast('Undone — still due ' + fmtDate(due)); await after();
  } });
  await after();
}

// ---------- WEEKLY CHECK (guided routine) ----------
async function weeklyCheck(step = store.get('weeklyStep', 0)) {
  document.querySelector('dialog.weekly')?.remove();
  const dlg = document.createElement('dialog'); dlg.className = 'weekly';
  const STEPS = ['Bring in new statements', 'Sort new transactions', 'Tick off paid bills', 'Check alerts', 'All done'];
  store.set('weeklyStep', step);
  const [bal, uncat, up, alerts] = await Promise.all([
    q(sb.from('v_account_balances').select('name, last_transaction_date, is_active').eq('is_active', true)),
    sb.from('transactions').select('id', { count: 'exact', head: true }).is('category_id', null).gte('txn_date', new Date(Date.now() - 60 * 864e5).toLocaleDateString('en-CA')),
    q(sb.rpc('upcoming_items', { p_days: 7 })),
    q(sb.from('alerts').select('*').eq('dismissed', false)),
  ]);
  const body = [
    () => `<p>Download the latest CSV or PDF from <b>Westpac</b> and <b>CommBank</b>, then import them. Already-imported transactions are skipped automatically.</p>
      <ul class="checklist">${bal.map(a => { const d = a.last_transaction_date ? -daysFromToday(a.last_transaction_date) : null;
        return `<li class="${d != null && d <= 7 ? 'done' : ''}"><span class="tick">${d != null && d <= 7 ? '✓' : ''}</span><div class="what">${esc(a.name)}</div><span class="hint">${d == null ? 'no data' : d <= 0 ? 'up to date' : d + ' days old'}</span></li>`; }).join('')}</ul>
      <button data-go="import">Open Import</button> <span class="hint">Come back with ✓ Weekly check on Home.</span>`,
    () => `<p><b>${uncat.count || 0}</b> transaction${uncat.count === 1 ? '' : 's'} from the last two months ${uncat.count === 1 ? 'needs' : 'need'} a category.</p>
      ${uncat.count ? '<button data-go="sort">Open To sort</button>' : '<p class="callout good">Nothing to sort ✓</p>'}`,
    () => { const due = up.filter(u => u.direction === 'out');
      return due.length ? `<p>Bills due this week or overdue — press <b>Paid</b> on each one that's been paid:</p>
        <ul class="due-list">${due.map(u => `<li class="${u.overdue ? 'is-late' : ''}"><div class="due-date"><b>${new Date(u.due_date + 'T00:00:00').getDate()}</b><span>${new Date(u.due_date + 'T00:00:00').toLocaleDateString('en-AU', { month: 'short' })}</span></div>
          <div class="due-main"><b>${esc(u.name)}</b><div class="hint">${u.overdue ? 'overdue' : 'due ' + fmtDate(u.due_date)}</div></div><div class="due-amt">${money(u.amount)}</div>
          <button class="small w-paid" data-id="${u.item_id}" data-due="${u.due_date}">Paid</button></li>`).join('')}</ul>` : '<p class="callout good">No bills due this week ✓</p>'; },
    () => alerts.length ? `<p>Read each alert and dismiss the ones that are dealt with:</p>${alerts.map(a => `<div class="alert ${a.severity}"><span class="alert-icon">${a.severity === 'urgent' ? '!' : '•'}</span><div><b>${esc(a.title)}</b><div class="hint">${esc(a.body)}</div></div>
      <button class="small ghost w-dismiss" data-id="${a.id}" aria-label="Dismiss">✕</button></div>`).join('')}` : '<p class="callout good">No alerts ✓</p>',
    () => `<p class="callout good"><b>Weekly check done.</b> Your figures are up to date.</p><p>Next check: <b>${new Date(Date.now() + 7 * 864e5).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })}</b>.</p>`,
  ];
  dlg.innerHTML = `<h2>Weekly check — ${esc(STEPS[step])}</h2><div class="steps" aria-hidden="true">${STEPS.map((_, i) => `<span class="${i <= step ? 'on' : ''}"></span>`).join('')}</div>
    <p class="hint">Step ${step + 1} of ${STEPS.length}</p><div class="w-body">${body[step]()}</div>
    <div class="row" style="margin-top:1rem;justify-content:space-between"><button class="ghost w-close">Close</button>
      <div class="row">${step > 0 && step < 4 ? '<button class="w-back">Back</button>' : ''}<button class="primary w-next">${step === 4 ? 'Finish' : 'Next'}</button></div></div>`;
  document.body.appendChild(dlg); dlg.showModal();
  dlg.querySelector('.w-close').onclick = () => dlg.close();
  dlg.querySelector('.w-back')?.addEventListener('click', () => { dlg.remove(); weeklyCheck(step - 1); });
  dlg.querySelector('.w-next').onclick = () => {
    dlg.remove();
    if (step === 4) { store.set('lastWeekly', today()); store.set('weeklyStep', 0); toast('Weekly check done ✓'); if (currentView === 'dashboard') dashboard(); }
    else weeklyCheck(step + 1);
  };
  dlg.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { dlg.close(); show(b.dataset.go); });
  dlg.querySelectorAll('.w-paid').forEach(b => b.onclick = () => busy(b, () => markPaid(b.dataset.id, b.dataset.due, async () => { if (!b.isConnected) return; b.closest('li').classList.add('done'); b.replaceWith(Object.assign(document.createElement('span'), { className: 'hint', textContent: 'paid ✓' })); })));
  dlg.querySelectorAll('.w-dismiss').forEach(b => b.onclick = async () => { await q(sb.from('alerts').update({ dismissed: true }).eq('id', b.dataset.id)); b.closest('.alert').remove(); });
  dlg.addEventListener('close', () => dlg.remove());
}

// ---------- DASHBOARD ----------
let spendPeriod = 'this';
async function dashboard() {
  view.innerHTML = '<p class="loading">Loading…</p>';
  const rank = { urgent: 0, warning: 1, info: 2 };
  const monthStart = today().slice(0, 8) + '01';
  let [alertsRaw, bal, cash, debt, shared, upcoming, followups, catSpend, uncat, lastTxn, debtRows] = await Promise.all([
    q(sb.from('alerts').select('*').eq('dismissed', false).order('due_date')),
    q(sb.from('v_account_balances').select('*').eq('is_active', true)),
    q(sb.from('v_monthly_cashflow').select('*').order('month', { ascending: false }).limit(12)),
    q(sb.from('v_debt_summary').select('*').maybeSingle()),
    q(sb.from('v_shared_balance').select('*').maybeSingle()),
    q(sb.rpc('upcoming_items', { p_days: 14 })),
    q(sb.from('debt_contacts').select('follow_up_date, summary, debt_id').eq('follow_up_done', false).not('follow_up_date', 'is', null).lte('follow_up_date', new Date(Date.now() + 7 * 864e5).toLocaleDateString('en-CA')).order('follow_up_date')),
    q(sb.from('v_category_spend_month').select('*').order('month', { ascending: false }).limit(400)),
    sb.from('transactions').select('id', { count: 'exact', head: true }).is('category_id', null),
    q(sb.from('transactions').select('txn_date').order('txn_date', { ascending: false }).limit(1)),
    q(sb.from('debts').select('current_balance, my_share_pct, arrears_amount').eq('status', 'active')),
  ]);
  const lastMonthStart = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toLocaleDateString('en-CA');
  const [recent, debtsAll, items, taxRow, contacts, imports] = await Promise.all([
    q(sb.from('transactions').select('account_id, amount, txn_date, category_id').gte('txn_date', lastMonthStart).range(0, 4999)),
    q(sb.from('debts').select('debt_type, current_balance, hardship_status, status').eq('status', 'active')),
    q(sb.from('recurring_items').select('id', { count: 'exact', head: false }).limit(1)),
    q(sb.from('tax_years').select('rooms').eq('fy', fyOf(today())).maybeSingle()),
    q(sb.from('debt_contacts').select('id, method').limit(50)),
    q(sb.from('import_batches').select('created_at').order('created_at', { ascending: false }).limit(1)),
  ]);
  const alerts = alertsRaw.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const uncatCount = uncat.count || 0;
  const name = cache.settings?.display_name;
  const isLoan = a => ['loan', 'mortgage', 'credit_card'].includes(a.account_type);
  const cashAccts = bal.filter(a => !isLoan(a));
  // own accounts count as the signed-in person's; joint accounts split by their share %
  const myCash = sum(cashAccts, a => Number(a.calculated_balance) * (personView === 'all' ? 1 : a.is_joint ? shareFor(a.my_share_pct) : personView === 'me' ? 1 : 0));
  const pName = personView === 'all' ? 'household' : personName();
  const upShare = u => personView === 'all' ? Number(u.amount) : personView === 'me' ? Number(u.my_amount) : Number(u.amount) - Number(u.my_amount);
  upcoming = upcoming.filter(u => upShare(u) > 0.004).map(u => ({ ...u, my_amount: upShare(u) }));
  const spendShare = shareFor(cache.settings?.default_my_share_pct ?? 50);
  const thisMonth = cash.find(c => c.month === monthStart) || {};
  // comparisons
  const transferIds = new Set(cache.categories.filter(c => c.kind === 'transfer').map(c => c.id));
  const d30 = new Date(Date.now() - 30 * 864e5).toLocaleDateString('en-CA');
  const cashIds = new Map(cashAccts.map(a => [a.id, a]));
  const change30 = sum(recent.filter(t => t.txn_date > d30 && cashIds.has(t.account_id)), t => Number(t.amount) * (personView === 'all' ? 1 : cashIds.get(t.account_id).is_joint ? shareFor(cashIds.get(t.account_id).my_share_pct) : personView === 'me' ? 1 : 0));
  const dayOfMonth = +today().slice(8, 10);
  const lastSame = recent.filter(t => t.txn_date >= lastMonthStart && t.txn_date < monthStart && +t.txn_date.slice(8, 10) <= dayOfMonth && !transferIds.has(t.category_id));
  const lastNet = sum(lastSame, t => t.amount);
  const deltaHtml = (v, goodUp = true, suffix = '') => !v || Math.abs(v) < 1 ? '' : `<span class="delta ${(v > 0) === goodUp ? 'up' : 'down'}">${v > 0 ? '▲' : '▼'} ${moneyRound(Math.abs(v))}${suffix}</span>`;
  // freshness of bank data per account
  const fresh = bal.filter(a => a.last_transaction_date).map(a => ({ name: a.name, days: daysFromToday(a.last_transaction_date) * -1, date: a.last_transaction_date }));
  const staleAccts = fresh.filter(f => f.days > 7);
  // setup checklist
  const lastWeekly = store.get('lastWeekly', null);
  const uncat90 = recent.filter(t => !t.category_id).length;
  const bnplMissing = debtsAll.filter(d => ['bnpl', 'personal_loan'].includes(d.debt_type) && !Number(d.current_balance));
  const checklist = [
    { done: bal.some(a => a.transaction_count > 0), what: 'Import your bank statements', go: 'import' },
    { done: fresh.length && !staleAccts.length, what: 'Keep bank data less than a week old', go: 'import', hint: staleAccts.length ? staleAccts.map(f => `${f.name} (${f.days} days)`).join(', ') : '' },
    { done: uncat90 < 10, what: 'Sort recent transactions', go: 'sort', hint: uncat90 ? `${uncat90} from the last two months still to sort` : '' },
    { done: !bnplMissing.length, what: 'Enter what you still owe on Afterpay, Deferit and Latitude', go: 'debts', hint: bnplMissing.length ? `${bnplMissing.length} balance${bnplMissing.length > 1 ? 's' : ''} missing` : '' },
    { done: (items || []).length > 0 && store.get('visitedBills', false), what: 'Check the bills and income list (amounts and splits)', go: 'bills' },
    { done: debtsAll.some(d => ['requested', 'approved'].includes(d.hardship_status)) || contacts.some(c => c.method === 'counsellor'), what: 'Call the National Debt Helpline (1800 007 007) about hardship', go: 'debts', hint: 'Log the call under Debts → Calls' },
    { done: !!(taxRow?.rooms || []).length, what: 'Set up the boarders\' rooms for tax', go: 'tax' },
    { done: !!lastWeekly, what: 'Do your first weekly check', go: 'weekly' },
  ];
  const doneCount = checklist.filter(c => c.done).length;
  const showChecklist = doneCount < checklist.length && !store.get('hideChecklist', false);
  const dueOut = upcoming.filter(u => u.direction === 'out');
  const dueTotal = sum(dueOut, u => u.my_amount);
  const overdue = dueOut.filter(u => u.overdue);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const s = Number(shared?.balance || 0), partner = cache.settings?.partner_label || 'Ex-partner';

  view.innerHTML = `
    <div class="page-head"><div><h1 class="page-title">${greet}${name ? ', ' + esc(name) : ''}</h1>${personView !== 'all' ? `<div class="who-now inline">Showing ${esc(personName())}</div>` : ''}
      <p class="hint">${lastTxn[0] ? `Bank data up to ${esc(fmtDate(lastTxn[0].txn_date))} · <button class="link" data-go="import">import newer statements</button>` : 'No statements imported yet — <button class="link" data-go="import">import your first</button>'}</p></div>
      <div class="row"><button class="primary" id="weekly-btn">✓ Weekly check</button><span class="hint">${lastWeekly ? `last done ${-daysFromToday(lastWeekly) === 0 ? 'today' : -daysFromToday(lastWeekly) + ' days ago'}` : 'about 5 minutes'}</span></div></div>

    ${showChecklist ? `<section class="card"><div class="sec-head"><div><h2>Getting set up</h2><p class="hint">${doneCount} of ${checklist.length} done</p></div><button class="small ghost" id="hide-check" title="Hide checklist">Hide</button></div>
      <div class="progress" role="progressbar" aria-valuenow="${doneCount}" aria-valuemin="0" aria-valuemax="${checklist.length}"><span style="width:${doneCount / checklist.length * 100}%"></span></div>
      <ul class="checklist">${checklist.map(c => `<li class="${c.done ? 'done' : ''}"><span class="tick" aria-hidden="true">${c.done ? '✓' : ''}</span>
        <div><span class="what">${esc(c.what)}</span>${c.hint && !c.done ? `<div class="hint">${esc(c.hint)}</div>` : ''}</div>
        ${c.done ? '<span class="hint">done</span>' : `<button class="small" data-go="${c.go}">${c.go === 'weekly' ? 'Start' : 'Go'}</button>`}</li>`).join('')}</ul></section>` : ''}

    ${fresh.length ? `<div class="chips" aria-label="How up to date your bank data is">${fresh.map(f => `<button class="chip" data-go="import" title="Latest transaction ${esc(fmtDate(f.date))}"><span class="fresh"><span class="fresh-dot ${f.days > 14 ? 'stale' : f.days > 7 ? 'old' : ''}"></span>${esc(f.name.replace(/Rocket Repay /, ''))}: ${f.days <= 0 ? 'up to date' : f.days + ' day' + (f.days === 1 ? '' : 's') + ' old'}</span></button>`).join('')}</div>` : ''}

    ${alerts.length ? `<div class="alerts">${alerts.slice(0, 4).map((a, i) => `<div class="alert ${a.severity}">
        <span class="alert-icon" aria-hidden="true">${a.severity === 'urgent' ? '!' : a.severity === 'warning' ? '•' : 'i'}</span>
        <div><b>${esc(a.title)}</b><div class="hint">${esc(a.body)}</div></div>
        <button class="small ghost dismiss" data-i="${i}" title="Dismiss" aria-label="Dismiss">✕</button></div>`).join('')}
      ${alerts.length > 4 ? `<p class="hint">+ ${alerts.length - 4} more alert(s)</p>` : ''}</div>` : ''}

    <div class="tiles">
      <div class="tile"><div class="tile-label">Money in accounts ${info('The balance of your everyday and savings accounts (not loans), worked out from your imported statements. Joint accounts count only your share when Michael or Taslyn is selected. The arrow compares with 30 days ago.')}</div><div class="tile-value">${moneyRound(myCash)}</div>
        <div class="tile-sub">${deltaHtml(change30, true, ' in 30 days')} ${esc(pName)}${personView === 'all' ? '' : ' share'}, ${cashAccts.length} account${cashAccts.length === 1 ? '' : 's'}</div></div>
      <div class="tile ${Number(thisMonth.net) < 0 ? 'bad' : 'good'}"><div class="tile-label">This month so far <span class="hint">(household)</span> ${info('Money in minus money out since the 1st of this month, for the whole household. Transfers between your own accounts, money between you and Taslyn, and loan interest are left out. The arrow compares with the same days last month.')}</div><div class="tile-value">${Number(thisMonth.net) >= 0 ? '+' : ''}${moneyRound(thisMonth.net || 0)}</div>
        <div class="tile-sub">${deltaHtml(Number(thisMonth.net || 0) - lastNet, true, ' vs last month')} in ${moneyRound(thisMonth.money_in || 0)} · out ${moneyRound(thisMonth.money_out || 0)}</div></div>
      <div class="tile ${overdue.length ? 'bad' : dueOut.length ? 'warn' : ''}"><div class="tile-label">Bills due in 14 days ${info('Regular bills and loan repayments due in the next two weeks, plus any that are overdue. Shared bills count only the selected person\'s share. Press Paid on a bill once it\'s paid.')}</div><div class="tile-value">${moneyRound(dueTotal)}</div>
        <div class="tile-sub">${dueOut.length} bill${dueOut.length === 1 ? '' : 's'}, ${esc(pName)}${overdue.length ? ` · <b>${overdue.length} overdue</b>` : ''}</div></div>
      <div class="tile"><div class="tile-label">Debt ${info('Everything owed: home loans (updated from your statements), power, Afterpay and other debts you entered. Shared debts count only the selected person\'s share.')}</div><div class="tile-value">${moneyCompact(sum(debtRows, x => x.current_balance * shareFor(x.my_share_pct)))}</div>
        <div class="tile-sub">${esc(pName)}${sum(debtRows, x => x.arrears_amount * shareFor(x.my_share_pct)) ? ` · overdue ${moneyRound(sum(debtRows, x => x.arrears_amount * shareFor(x.my_share_pct)))}` : ''}</div></div>
    </div>

    ${uncatCount || debt?.hardship_to_request || followups.length || s ? `<div class="chips">
      ${uncatCount ? `<button class="chip" data-go="sort"><b>${uncatCount}</b> transactions to sort →</button>` : ''}
      ${debt?.hardship_to_request ? `<button class="chip warn" data-go="debts"><b>${debt.hardship_to_request}</b> hardship request${debt.hardship_to_request > 1 ? 's' : ''} to make →</button>` : ''}
      ${followups.length ? `<button class="chip warn" data-go="debts"><b>${followups.length}</b> creditor follow-up${followups.length > 1 ? 's' : ''} due →</button>` : ''}
      ${s ? `<button class="chip" data-go="shared">${s > 0 ? `${esc(partner)} owes you <b>${moneyRound(s)}</b>` : `You owe ${esc(partner)} <b>${moneyRound(-s)}</b>`} →</button>` : ''}
    </div>` : ''}

    <div class="grid2">
      <section class="card"><div class="sec-head"><div><h2>Coming up</h2><p class="hint">Next 14 days · ${esc(pName)} amounts</p></div><button class="small" data-go="bills">All bills</button></div>
        ${upcoming.length ? `<ul class="due-list">${upcoming.map(u => {
          const d = daysFromToday(u.due_date);
          const when = u.overdue ? (u.direction === 'in' ? 'late' : 'overdue') : d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
          return `<li class="${u.overdue ? 'is-late' : ''}"><div class="due-date"><b>${new Date(u.due_date + 'T00:00:00').getDate()}</b><span>${new Date(u.due_date + 'T00:00:00').toLocaleDateString('en-AU', { month: 'short' })}</span></div>
            <div class="due-main"><b>${esc(u.name)}</b><div class="hint">${when}${u.debt_id ? ' · loan repayment' : ''}${u.is_shared ? ' · shared' : ''}</div></div>
            <div class="due-amt ${u.direction === 'in' ? 'in' : ''}">${u.direction === 'in' ? '+' : '−'}${money(u.my_amount)}</div>
            ${u.direction === 'out' && d <= 7 ? `<button class="small mark-paid" data-id="${u.item_id}" data-due="${u.due_date}">Paid</button>` : '<span></span>'}</li>`; }).join('')}</ul>`
          : '<p class="empty">Nothing due in the next 14 days.</p>'}
      </section>
      <section class="card"><div class="sec-head"><div><h2>Where the money went</h2><p class="hint">${personView === 'all' ? 'Household spending' : esc(personName()) + "'s share of spending"} by category</p></div>
          <div class="seg" role="tablist">${[['this', 'This month'], ['last', 'Last month'], ['avg3', '3-month avg']].map(([k, l]) => `<button class="${spendPeriod === k ? 'on' : ''}" data-period="${k}">${l}</button>`).join('')}</div></div>
        <div id="spend-chart"></div></section>
    </div>

    <section class="card"><div class="sec-head"><div><h2>Money in vs money out</h2><p class="hint">Household, by month · transfers and loan interest not counted</p></div></div>
      <div id="flow-chart"></div></section>`;

  // charts
  const months = cash.slice().reverse();
  if (months.length) columnChart($('#flow-chart'), {
    title: 'Money in vs money out by month',
    labels: months.map(c => new Date(c.month + 'T00:00:00').toLocaleDateString('en-AU', { month: 'short' })),
    tipLabels: months.map(c => new Date(c.month + 'T00:00:00').toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })),
    series: [{ name: 'Money in', color: SERIES.blue, values: months.map(c => Number(c.money_in || 0)) },
             { name: 'Money out', color: SERIES.orange, values: months.map(c => Number(c.money_out || 0)) }],
    tipExtra: i => `<div class="hint">Net ${money(Number(months[i].net || 0))}</div>`,
  }); else $('#flow-chart').innerHTML = '<p class="empty">Import a statement to see this.</p>';
  const drawSpend = () => {
    const ms = [...new Set(catSpend.map(c => c.month))].sort().reverse();
    const lastM = new Date(new Date(monthStart + 'T00:00:00').setMonth(new Date(monthStart + 'T00:00:00').getMonth() - 1)).toLocaleDateString('en-CA').slice(0, 8) + '01';
    const pick = spendPeriod === 'this' ? [monthStart] : spendPeriod === 'last' ? [lastM] : ms.filter(m => m < monthStart).slice(0, 3);
    const div = spendPeriod === 'avg3' ? Math.max(1, pick.length) : 1;
    const totals = new Map();
    for (const c of catSpend.filter(c => pick.includes(c.month))) totals.set(c.category, (totals.get(c.category) || 0) + Number(c.spent) * spendShare / div);
    let items = [...totals.entries()].map(([label, value]) => ({ label, value })).filter(i => i.value > 0.5).sort((a, b) => b.value - a.value);
    if (items.length > 8) { const rest = items.slice(7); items = items.slice(0, 7).concat([{ label: `Other (${rest.length})`, value: sum(rest, r => r.value) }]); }
    const budgets = new Map(cache.categories.filter(c => c.monthly_budget).map(c => [c.name, Number(c.monthly_budget)]));
    items.forEach(i => { const b = budgets.get(i.label); if (b) { i.note = `budget ${money(b)}`; if (i.value > b) { i.badge = 'over'; i.badgeClass = 'bad'; } } });
    hbarChart($('#spend-chart'), { items, color: SERIES.orange, empty: 'No spending recorded for this period yet.' });
    const tot = sum(items, i => i.value);
    if (items.length) $('#spend-chart').insertAdjacentHTML('beforeend', `<p class="hint total-line">Total ${money(tot)}${spendPeriod === 'avg3' ? ' per month' : ''}</p>`);
  };
  drawSpend();

  // interactions
  view.querySelectorAll('[data-period]').forEach(b => b.onclick = () => { spendPeriod = b.dataset.period; view.querySelectorAll('[data-period]').forEach(x => x.classList.toggle('on', x === b)); drawSpend(); });
  view.querySelectorAll('[data-go]').forEach(b => b.onclick = () => b.dataset.go === 'weekly' ? weeklyCheck() : show(b.dataset.go));
  $('#weekly-btn').onclick = () => weeklyCheck();
  $('#hide-check')?.addEventListener('click', () => { store.set('hideChecklist', true); $('#hide-check').closest('.card').remove(); toast('Checklist hidden', { action: 'Undo', onAction: () => { store.set('hideChecklist', false); dashboard(); } }); });
  view.querySelectorAll('.mark-paid').forEach(b => b.onclick = () => markPaid(b.dataset.id, b.dataset.due, dashboard));
  view.querySelectorAll('.dismiss').forEach(b => b.onclick = async () => {
    await q(sb.from('alerts').update({ dismissed: true }).eq('id', alerts[b.dataset.i].id));
    b.closest('.alert').remove();
  });
}

// ---------- BUDGET (Overall / me / partner) ----------

async function budget() {
  view.innerHTML = '<p class="loading">Loading…</p>';
  const months = 6;
  const r = await q(sb.rpc('budget_summary', { p_months: months }));
  const me = cache.settings?.display_name || 'Me';
  const names = { overall: 'Household', me, partner: r.partner };
  const draw = () => {
    const budgetWho = { all: 'overall', me: 'me', partner: 'partner' }[personView];
    const p = r.people[budgetWho];
    const costs = p.regular_out + p.debt_monthly;
    const gap = p.regular_in - costs;
    const actualGap = p.actual_in - p.actual_out;
    const freq = f => FREQ_WORD[f] || f;
    const list = (rows, cols) => rows.length ? `<div class="tablewrap"><table class="list"><tbody>${rows.map(r => `<tr>${cols.map((c, i) => `<td class="${i ? 'num' : ''}">${c(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="empty">None.</p>';
    view.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Budget</h1><p class="hint">Regular income and costs per month, split by who pays</p></div>
        <div class="who-now">${esc(names[budgetWho])}</div></div>

      <div class="tiles">
        <div class="tile"><div class="tile-label">Regular income ${info('All regular income from the Income page, converted to a monthly amount (weekly × 52 ÷ 12, fortnightly × 26 ÷ 12). Shared items count only the selected person\'s share.')}</div><div class="tile-value">${moneyRound(p.regular_in)}</div><div class="tile-sub">per month</div></div>
        <div class="tile"><div class="tile-label">Regular costs ${info('Regular bills from the Bills page plus debt repayments from the Debts page, per month. Loan repayments are counted once, under debts.')}</div><div class="tile-value">${moneyRound(costs)}</div><div class="tile-sub">bills ${moneyRound(p.regular_out)} · debts ${moneyRound(p.debt_monthly)}</div></div>
        <div class="tile ${gap < 0 ? 'bad' : 'good'}"><div class="tile-label">Left over each month ${info('Regular income minus regular costs. This is what\'s left for food, fuel and everything else — before any everyday spending.')}</div><div class="tile-value">${gap >= 0 ? '+' : ''}${moneyRound(gap)}</div><div class="tile-sub">${gap < 0 ? 'short before everyday spending' : 'before everyday spending'}</div></div>
        <div class="tile ${actualGap < 0 ? 'bad' : 'good'}"><div class="tile-label">What actually happened ${info('From your real bank transactions: average money in minus money out per month over the last 6 months. Transfers and loan interest aren\'t counted.')}</div><div class="tile-value">${actualGap >= 0 ? '+' : ''}${moneyRound(actualGap)}</div><div class="tile-sub">average per month, last ${months} months</div></div>
      </div>

      <div class="grid2">
        <section class="card"><div class="sec-head"><div><h2>Each month</h2><p class="hint">Regular income against regular costs</p></div></div>
          <div id="b-compare"></div>
          <p class="callout ${gap < 0 ? 'bad' : 'good'}">${gap < 0 ? `Regular costs are <b>${moneyRound(-gap)}</b> more than regular income each month.` : `<b>${moneyRound(gap)}</b> left each month for food, fuel and everything else.`}</p></section>
        <section class="card"><div class="sec-head"><div><h2>Everyday spending</h2><p class="hint">Average per month, last ${months} months</p></div></div>
          <div id="b-spend"></div></section>
      </div>

      <details class="card fold"><summary><h2>Income</h2><span class="hint">${p.income_items.length} items · ${moneyRound(p.regular_in)} / month</span></summary>
        ${list(p.income_items, [i => `<b>${esc(i.name)}</b><div class="hint">${money(i.amount)} / ${freq(i.frequency)}${i.share < 100 ? ` · ${i.share}% counted` : ''}</div>`, i => money(i.monthly)])}</details>
      <details class="card fold"><summary><h2>Bills</h2><span class="hint">${p.bill_items.length} items · ${moneyRound(p.regular_out)} / month</span></summary>
        ${list(p.bill_items, [i => `<b>${esc(i.name)}</b><div class="hint">${money(i.amount)} / ${freq(i.frequency)}${i.share < 100 ? ` · ${i.share}% counted` : ''}${i.is_debt_repayment ? ' · counted under Debts' : ''}</div>`, i => i.is_debt_repayment ? '<span class="hint">in Debts</span>' : money(i.monthly)])}</details>
      <details class="card fold"><summary><h2>Debts</h2><span class="hint">${moneyRound(p.debt_balance)} owed · ${moneyRound(p.debt_monthly)} / month</span></summary>
        ${list(p.debt_items, [d => `<b>${esc(d.creditor)}</b><div class="hint">${d.balance ? money(d.balance) + ' owed' : 'balance not entered'}${d.share < 100 ? ` · ${d.share}% counted` : ''}${d.hardship === 'approved' ? ' · on hardship' : ''}</div>`, d => money(d.monthly)])}</details>
      ${budgetWho !== 'overall' ? `<p class="hint">Splits use each item's "My share %" — ${esc(me)} gets that share, ${esc(r.partner)} the rest. Everyday spending uses the shared-costs % from Setup. Money moved between you two isn't counted.</p>` : ''}`;
    hbarChart($('#b-compare'), { items: [
      { label: 'Income', value: p.regular_in, color: SERIES.blue },
      { label: 'Bills', value: p.regular_out, color: SERIES.orange },
      { label: 'Debt repayments', value: p.debt_monthly, color: SERIES.orange },
    ], max: Math.max(p.regular_in, p.regular_out + p.debt_monthly, p.regular_out, p.debt_monthly, 1) });
    let spend = p.categories.filter(c => c.amount < 0).map(c => ({ label: c.name, value: -c.amount })).sort((a, b) => b.value - a.value);
    if (spend.length > 8) { const rest = spend.slice(7); spend = spend.slice(0, 7).concat([{ label: `Other (${rest.length})`, value: sum(rest, x => x.value) }]); }
    hbarChart($('#b-spend'), { items: spend, color: SERIES.orange, empty: 'No spending imported.' });
    if (spend.length) $('#b-spend').insertAdjacentHTML('beforeend', `<p class="hint total-line">Total ${money(p.actual_out)} per month · income ${money(p.actual_in)}</p>`);

  };
  draw();
}

// ---------- TRANSACTIONS ----------
async function transactions(opts = {}) {
  const thisMonth = today().slice(0, 7);
  const state = { months: new Set(opts.uncategorised || opts.search || opts.category ? [] : [thisMonth]), account: '', category: opts.category || '', uncategorised: !!opts.uncategorised, search: opts.search || '' };
  // every month from the oldest transaction to now, newest first
  const oldest = (await q(sb.from('transactions').select('txn_date').order('txn_date').limit(1)))[0]?.txn_date || today();
  const monthList = [];
  for (let d = new Date(thisMonth + '-01T00:00:00'), stop = new Date(oldest.slice(0, 7) + '-01T00:00:00'); d >= stop; d.setMonth(d.getMonth() - 1))
    monthList.push(d.toLocaleDateString('en-CA').slice(0, 7));
  const mLabel = m => new Date(m + '-01T00:00:00').toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
  const monthSummary = () => !state.months.size ? 'All months' : state.months.size === 1 ? mLabel([...state.months][0])
    : `${state.months.size} months selected`;
  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Transactions</h1><p class="hint">Every transaction from every account. Filter, set categories, and see totals for exactly what you filtered.</p></div></div><div class="card"><div class="formgrid">
      <div><span style="font-weight:700;font-size:.95rem">Months</span>
        <details class="monthpick" id="f-month"><summary id="f-month-sum">${esc(monthSummary())}</summary>
          <div class="monthlist">
            <div class="row" style="margin-bottom:.4rem"><button type="button" class="small" id="m-none">All months</button><button type="button" class="small" id="m-3">Last 3</button><button type="button" class="small" id="m-6">Last 6</button><button type="button" class="small" id="m-12">Last 12</button></div>
            ${(() => { let yr = ''; return monthList.map(m => { const y = m.slice(0, 4); const head = y !== yr ? `<div class="hint" style="margin-top:.3rem"><b>${y}</b></div>` : ''; yr = y;
              return head + `<label class="mcheck"><input type="checkbox" value="${m}" ${state.months.has(m) ? 'checked' : ''}> ${esc(mLabel(m))}</label>`; }).join(''); })()}
          </div></details></div>
      <label>Account <select id="f-acct"><option value="">All accounts</option>${cache.accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>
      <label>Category <select id="f-cat"><option value="">All categories</option>${cache.categories.map(c => `<option value="${c.id}" ${c.id === state.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label>Search <input type="search" id="f-search" placeholder="e.g. woolworths" value="${esc(state.search)}"></label>
      <label style="align-self:end"><input type="checkbox" id="f-uncat" ${state.uncategorised ? 'checked' : ''}> Only uncategorised</label>
      <label style="align-self:end"><input type="checkbox" id="f-oneoff"> Only one-offs</label>
      <div class="row" style="align-self:end;margin-bottom:.6rem"><button type="button" id="f-all">All months</button><button type="button" id="f-clear">Clear filters</button></div>
    </div></div><div class="card" id="txlist"></div>`;
  const catOpts = (sel) => catOptions(sel);
  async function load() {
    // fetch every matching row (in pages) so the totals cover the whole filter; show the first 500
    const build = () => {
      let query = sb.from('transactions').select('*').order('txn_date', { ascending: false }).order('created_at', { ascending: false });
      if (state.months.size) {
        const ranges = [...state.months].map(mm => { const [y, m] = mm.split('-').map(Number); const end = new Date(y, m, 1).toLocaleDateString('en-CA');
          return `and(txn_date.gte.${mm}-01,txn_date.lt.${end})`; });
        query = query.or(ranges.join(','));
      }
      if (state.account) query = query.eq('account_id', state.account);
      if (state.oneoff) query = query.eq('is_one_off', true);
      if (state.uncategorised) query = query.is('category_id', null);
      else if (state.category) query = query.eq('category_id', state.category);
      if (state.search) query = query.ilike('description', `%${state.search.replace(/[%_,()]/g, '')}%`);
      return query;
    };
    let all = [];
    for (let from = 0; ; from += 1000) {
      const page = await q(build().range(from, from + 999));
      all = all.concat(page); if (page.length < 1000) break;
    }
    const rows = all.slice(0, 500);
    const tIn = sum(all.filter(r => r.amount > 0), r => r.amount), tOut = -sum(all.filter(r => r.amount < 0), r => r.amount);
    const transferIds = new Set(cache.categories.filter(c => c.kind === 'transfer').map(c => c.id));
    const nonTr = all.filter(r => !transferIds.has(r.category_id));
    const xIn = sum(nonTr.filter(r => r.amount > 0), r => r.amount), xOut = -sum(nonTr.filter(r => r.amount < 0), r => r.amount);
    const totalsRow = `<tfoot><tr class="total"><td><b>Total</b><br><span class="hint">${all.length} transaction(s)</span></td>
      <td>Money in ${money(tIn)} · Money out ${money(tOut)}${transferIds.size && nonTr.length !== all.length ? `<br><span class="hint">Excluding transfers: in ${money(xIn)} · out ${money(xOut)} · net ${money(xIn - xOut)}</span>` : ''}</td>
      <td class="num"><b>${money(tIn - tOut)}</b></td><td colspan="4"></td></tr></tfoot>`;
    const box = $('#txlist');
    box.innerHTML = rows.length ? `<p>${all.length} transaction(s) · in ${money(tIn)} · out ${money(tOut)} · net <b>${money(tIn - tOut)}</b>${all.length > 500 ? ' — totals cover all of them; the list shows the newest 500' : ''}</p>
      <div class="tablewrap"><table class="list txlist"><thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th><th>Category</th><th>Shared</th><th title="A one-off: categorised by hand, no rule">One-off</th><th></th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td data-label="Date">${esc(fmtDate(r.txn_date))}<br><span class="hint hide-sm">${esc(refName('accounts', r.account_id))}</span></td><td data-label="Description">${esc(r.description)}</td>
        <td class="num ${r.amount > 0 ? 'in' : ''}" data-label="Amount">${money(r.amount)}</td>
        <td data-label="Category"><select data-i="${i}" class="cat" aria-label="Category">${catOpts(r.category_id)}</select>${r.category_source === 'rule' ? '<br><span class="hint">by rule</span>' : ''}</td>
        <td data-label="Shared"><input type="checkbox" class="shr" data-i="${i}" ${r.is_shared ? 'checked' : ''} aria-label="Shared"></td>
        <td data-label="One-off"><input type="checkbox" class="one" data-i="${i}" ${r.is_one_off ? 'checked' : ''} aria-label="One-off"></td>
        <td class="actions"><button class="small mkrule" data-i="${i}" title="Always categorise transactions like this">Make rule</button></td></tr>`).join('')}
      </tbody>${totalsRow}</table></div>` : '<p class="empty">No transactions match.</p>';
    box.querySelectorAll('.cat').forEach(sel => wireCatSelect(sel, async (id) => {
      const r = rows[sel.dataset.i], before = { category_id: r.category_id, category_source: r.category_source };
      await q(sb.from('transactions').update({ category_id: id, category_source: id ? 'manual' : 'none' }).eq('id', r.id));
      r.category_id = id;
      toast('Category saved ✓', { ms: 5000, action: 'Undo', onAction: async () => {
        await q(sb.from('transactions').update(before).eq('id', r.id)); r.category_id = before.category_id; sel.value = before.category_id || ''; toast('Category put back');
      } });
    }, rows[sel.dataset.i].amount > 0 ? 'income' : 'expense'));
    box.querySelectorAll('.one').forEach(c => c.onchange = async () => {
      const r = rows[c.dataset.i];
      await q(sb.from('transactions').update({ is_one_off: c.checked }).eq('id', r.id));
      toast(c.checked ? 'Marked as a one-off' : 'No longer a one-off');
    });
    box.querySelectorAll('.shr').forEach(c => c.onchange = async () => {
      const r = rows[c.dataset.i];
      await q(sb.from('transactions').update({ is_shared: c.checked }).eq('id', r.id));
      if (c.checked && r.amount < 0) {
        await q(sb.from('shared_ledger').insert({ entry_date: r.txn_date, description: r.description, total_amount: Math.abs(r.amount), paid_by: 'me', my_share_pct: cache.settings?.default_my_share_pct ?? 50, transaction_id: r.id }));
        toast('Added to shared costs');
      } else if (!c.checked) {
        await q(sb.from('shared_ledger').delete().eq('transaction_id', r.id)); toast('Removed from shared costs');
      }
    });
    box.querySelectorAll('.mkrule').forEach(b => b.onclick = () => makeRule(rows[b.dataset.i], load));
  }
  const syncMonths = () => {
    $('#f-month').querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = state.months.has(c.value); });
    $('#f-month-sum').textContent = monthSummary(); load();
  };
  $('#f-month').querySelectorAll('input[type=checkbox]').forEach(c => c.onchange = () => { c.checked ? state.months.add(c.value) : state.months.delete(c.value); syncMonths(); });
  $('#m-none').onclick = () => { state.months.clear(); syncMonths(); };
  for (const n of [3, 6, 12]) $('#m-' + n).onclick = () => { state.months = new Set(monthList.slice(0, n)); syncMonths(); };
  document.addEventListener('click', e => { const d = $('#f-month'); if (d && d.open && !d.contains(e.target)) d.open = false; });
  $('#f-acct').onchange = e => { state.account = e.target.value; load(); };
  $('#f-cat').onchange = e => { state.category = e.target.value; load(); };
  $('#f-all').onclick = () => { state.months.clear(); syncMonths(); };
  $('#f-clear').onclick = () => {
    Object.assign(state, { months: new Set([thisMonth]), account: '', category: '', uncategorised: false, oneoff: false, search: '' });
    $('#f-acct').value = ''; $('#f-cat').value = ''; $('#f-uncat').checked = false; $('#f-oneoff').checked = false; $('#f-search').value = ''; syncMonths();
  };
  $('#f-uncat').onchange = e => { state.uncategorised = e.target.checked; load(); };
  $('#f-oneoff').onchange = e => { state.oneoff = e.target.checked; load(); };
  let t; $('#f-search').oninput = e => { clearTimeout(t); t = setTimeout(() => { state.search = e.target.value.trim(); load(); }, 350); };
  await load();
}

function makeRule(txn, after, presetCat) {
  const guess = txn.guess || txn.description.replace(/[0-9#*]+/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ').toUpperCase();
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form method="dialog"><h2>Make a rule</h2><p class="hint">From: ${esc(txn.description)}</p>
    <label>When the description contains <input name="m" value="${esc(guess)}" required></label>
    <label>Set category <select name="c" required>${catOptions(presetCat || txn.category_id)}</select></label>
    <label><input type="checkbox" name="s"> Also add to shared costs</label>
    <p class="hint">The rule applies to money ${txn.amount > 0 ? 'coming in' : 'going out'}, and is re-run on everything not set by hand.</p>
    <div class="row"><button class="primary" value="save">Save rule</button><button value="cancel" formnovalidate>Cancel</button></div></form>`;
  document.body.appendChild(dlg);
  const f = $('form', dlg);
  wireCatSelect(f.c, () => {}, txn.amount > 0 ? 'income' : 'expense');
  f.addEventListener('submit', async e => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    if (!f.c.value || f.c.value === '__new') { toast('Pick a category first'); return; }
    await q(sb.from('category_rules').insert({ match_text: f.m.value.trim(), direction: txn.amount > 0 ? 'in' : 'out', category_id: f.c.value, mark_shared: f.s.checked, priority: 20 }));
    const n = await q(sb.rpc('recategorise_uncategorised'));
    toast(`Rule saved — ${n} transaction(s) updated`); dlg.close(); after();
  });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

// ---------- TO SORT (uncategorised, grouped by payee) ----------
// Payee key: description with reference numbers / codes removed, so repeat payments group together
const payeeKey = d => d.toUpperCase().replace(/\\[^\s]*/g, ' ').replace(/\b[A-Z0-9]*\d[A-Z0-9/.\-]*\b/g, ' ').replace(/[^A-Z&' ]+/g, ' ').replace(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/g, ' ').replace(/\s+/g, ' ').trim() || d.toUpperCase();
let sortDir = 'all';
async function sortView() {
  view.innerHTML = '<p>Loading…</p>';
  let all = [];
  for (let from = 0; ; from += 1000) {
    const page = await q(sb.from('transactions').select('*').is('category_id', null).order('txn_date', { ascending: false }).range(from, from + 999));
    all = all.concat(page); if (page.length < 1000) break;
  }
  const groupsMap = new Map();
  for (const t of all) {
    const k = (t.amount > 0 ? 'in|' : 'out|') + payeeKey(t.description);
    if (!groupsMap.has(k)) groupsMap.set(k, { key: k, name: payeeKey(t.description), dir: t.amount > 0 ? 'in' : 'out', txns: [] });
    groupsMap.get(k).txns.push(t);
  }
  let groups = [...groupsMap.values()].map(g => ({ ...g, total: sum(g.txns, t => t.amount), last: g.txns[0].txn_date, first: g.txns.at(-1).txn_date }));
  groups.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  const draw = () => {
    const shown = groups.filter(g => sortDir === 'all' || g.dir === sortDir);
    view.innerHTML = `<div class="page-head"><div><h1 class="page-title">To sort</h1><p class="hint">Transactions without a category, grouped by who they’re from or to, biggest first.</p></div></div><div class="card">
      <p><b>${all.length}</b> transaction(s) to sort. For each group pick a category, then <b>One-off</b> (just these, no rule) or <b>Make rule</b> (these and all future ones).</p>
      <div class="row"><span>Show:</span>${['all', 'out', 'in'].map(d => `<button class="small ${sortDir === d ? 'primary' : ''}" data-dir="${d}">${{ all: 'Everything', out: 'Money out', in: 'Money in' }[d]}</button>`).join('')}</div></div>
      ${shown.length ? shown.slice(0, 150).map(g => `<div class="card sortgroup" data-k="${esc(g.key)}">
        <div class="row" style="justify-content:space-between;align-items:flex-start">
          <div><b>${esc(g.txns[0].description)}</b><br>
            <span class="hint">${g.txns.length} transaction(s) · ${esc(fmtDate(g.first))}${g.first !== g.last ? ' – ' + esc(fmtDate(g.last)) : ''} · ${esc([...new Set(g.txns.map(t => refName('accounts', t.account_id)))].join(', '))}</span></div>
          <div class="num ${g.total > 0 ? 'in' : ''}" style="font-size:1.2rem"><b>${money(g.total)}</b></div>
        </div>
        <div class="row" style="margin-top:.5rem">
          <select class="g-cat" aria-label="Category" style="max-width:280px;margin:0">${catOptions('')}</select>
          <label style="font-weight:400;margin:0"><input type="checkbox" class="g-shr"> Shared</label>
          <button class="primary small g-one" title="Categorise just these transactions, no rule">One-off</button>
          <button class="small g-rule" title="Categorise these and all future ones like them">Make rule</button>
          <button class="small link g-show">${g.txns.length > 1 ? `Show ${g.txns.length}` : 'Show'}</button>
        </div>
        <div class="g-list hidden"></div></div>`).join('') + (shown.length > 150 ? `<p class="hint">Showing the biggest 150 groups.</p>` : '')
      : '<div class="card"><p class="empty">Nothing to sort — every transaction has a category. 🎉</p></div>'}`;
    view.querySelectorAll('[data-dir]').forEach(b => b.onclick = () => { sortDir = b.dataset.dir; draw(); });
    view.querySelectorAll('.sortgroup').forEach(card => {
      const g = groups.find(x => x.key === card.dataset.k);
      const sel = $('.g-cat', card);
      wireCatSelect(sel, () => {}, g.dir === 'in' ? 'income' : 'expense');
      const done = (msg) => { groups = groups.filter(x => x !== g); all = all.filter(t => !g.txns.includes(t)); toast(msg); draw(); };
      $('.g-one', card).onclick = async () => {
        if (!sel.value || sel.value === '__new') { toast('Pick a category first'); sel.focus(); return; }
        const ids = g.txns.map(t => t.id), shared = $('.g-shr', card).checked;
        for (let i = 0; i < ids.length; i += 200)
          await q(sb.from('transactions').update({ category_id: sel.value, category_source: 'manual', is_one_off: true, is_shared: shared }).in('id', ids.slice(i, i + 200)));
        if (shared) await addShared(g.txns.filter(t => t.amount < 0));
        done(`${ids.length} transaction(s) saved as a one-off`);
      };
      $('.g-rule', card).onclick = () => {
        const t = { ...g.txns[0], guess: g.name.split(' ').slice(0, 3).join(' ') };
        makeRule(t, async () => { await sortView(); }, sel.value && sel.value !== '__new' ? sel.value : null);
      };
      $('.g-show', card).onclick = () => {
        const box = $('.g-list', card); box.classList.toggle('hidden');
        if (box.classList.contains('hidden')) return;
        box.innerHTML = `<div class="tablewrap"><table><tbody>${g.txns.map((t, i) => `<tr><td>${esc(fmtDate(t.txn_date))}</td><td>${esc(t.description)}</td>
          <td class="num ${t.amount > 0 ? 'in' : ''}">${money(t.amount)}</td>
          <td><select class="t-cat" data-i="${i}" aria-label="Category">${catOptions('')}</select></td></tr>`).join('')}</tbody></table></div>
          <p class="hint">Setting a category on a single row saves it as a one-off for that transaction only.</p>`;
        box.querySelectorAll('.t-cat').forEach(s2 => wireCatSelect(s2, async (id) => {
          if (!id) return;
          const t = g.txns[s2.dataset.i];
          await q(sb.from('transactions').update({ category_id: id, category_source: 'manual', is_one_off: true }).eq('id', t.id));
          g.txns = g.txns.filter(x => x !== t); all = all.filter(x => x !== t);
          if (!g.txns.length) groups = groups.filter(x => x !== g); else g.total = sum(g.txns, x => x.amount);
          toast('Saved as a one-off'); draw();
        }, g.dir === 'in' ? 'income' : 'expense'));
      };
    });
  };
  draw();
}
async function addShared(txns) {
  if (!txns.length) return;
  const share = cache.settings?.default_my_share_pct ?? 50;
  const rows = txns.map(t => ({ entry_date: t.txn_date, description: t.description, total_amount: Math.abs(t.amount), paid_by: 'me', my_share_pct: share, transaction_id: t.id }));
  for (let i = 0; i < rows.length; i += 200) await q(sb.from('shared_ledger').insert(rows.slice(i, i + 200)));
}

// ---------- IMPORT ----------
let pdfjsLib = null;
async function readPdfItems(file) {
  if (!pdfjsLib) {
    pdfjsLib = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs';
  }
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    pages.push(tc.items.filter(it => it.str && it.str.trim()).map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5] })));
  }
  return pages;
}

function guessInstitution(parsed, filename) {
  if (parsed.format.startsWith('westpac')) return 'Westpac';
  if (parsed.format === 'commbank' || /commbank|cba/i.test(filename)) return 'CommBank';
  return 'Other';
}
function guessType(name) {
  if (/home loan|mortgage|repay/i.test(name)) return 'mortgage';
  if (/loan/i.test(name)) return 'loan';
  if (/credit card|mastercard|visa/i.test(name)) return 'credit_card';
  if (/saver|savings|goal/i.test(name)) return 'savings';
  return 'transaction';
}
// Balance on the day before the earliest transaction in the file
function openingFor(parsed) {
  const rows = parsed.rows; if (!rows.length) return { date: today(), balance: 0 };
  const newestFirst = rows[0].date >= rows.at(-1).date;
  const earliest = newestFirst ? rows.at(-1) : rows[0];
  if (parsed.account?.balance != null) {
    const sum = rows.reduce((s, r) => s + r.amount, 0);
    return { date: earliest.date, balance: Math.round((parsed.account.balance - sum) * 100) / 100 };
  }
  if (earliest.balance != null) return { date: earliest.date, balance: Math.round((earliest.balance - earliest.amount) * 100) / 100 };
  return { date: earliest.date, balance: 0 };
}

async function importView() {
  const fresh = await q(sb.from('v_account_balances').select('name, last_transaction_date').eq('is_active', true));
  const freshHtml = fresh.length ? `<div class="chips">${fresh.map(a => { const d = a.last_transaction_date ? -daysFromToday(a.last_transaction_date) : null;
    return `<span class="chip"><span class="fresh"><span class="fresh-dot ${d == null || d > 14 ? 'stale' : d > 7 ? 'old' : ''}"></span>${esc(a.name)}: ${d == null ? 'no data yet' : 'up to ' + fmtDate(a.last_transaction_date)}</span></span>`; }).join('')}</div>` : '';
  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Import</h1><p class="hint">Add bank statements: CommBank or Westpac CSV, or the Westpac Account activity PDF.</p></div></div>${freshHtml}<div class="card"><h2>Choose files</h2>
    <p class="hint">Choose one or more files at once: <b>CSV</b> exports from CommBank or Westpac, or the <b>Account activity PDF</b> from the Westpac app.
    Each file is matched to an account (or a new account is set up for you). Importing the same dates twice is safe — duplicates are skipped.</p>
    <label>Statement files <input type="file" id="i-file" accept=".csv,text/csv,.pdf,application/pdf" multiple></label>
    <div id="i-preview"></div></div>
    <div class="card" id="i-history"></div>`;

  $('#i-file').onchange = async e => {
    const files = [...e.target.files]; if (!files.length) return;
    const pv = $('#i-preview'); pv.innerHTML = '<p>Reading files…</p>';
    const jobs = [];
    const parsedFiles = [];
    for (const file of files) {
      let parsed;
      try {
        parsed = /\.pdf$/i.test(file.name) || file.type === 'application/pdf'
          ? parseWestpacActivity(await readPdfItems(file))
          : parseBankCsv(await file.text());
      } catch (err) { parsed = { format: 'unknown', rows: [], skipped: [], error: 'Could not read this file: ' + err.message }; }
      for (const part of (parsed.error ? [parsed] : splitAccounts(parsed))) parsedFiles.push({ file, parsed: part });
    }
    for (const { file, parsed } of parsedFiles) {
      const acc = parsed.account || {};
      const inst = guessInstitution(parsed, file.name);
      const sameBankNoNumber = cache.accounts.filter(a => a.institution === inst && !a.nickname_last4 && !['loan', 'mortgage'].includes(a.account_type));
      const match = cache.accounts.find(a => acc.last4 && a.nickname_last4 === acc.last4)
        || cache.accounts.find(a => acc.name && a.name.toLowerCase() === acc.name.toLowerCase() && !a.nickname_last4)
        || (!acc.last4 && !acc.name && sameBankNoNumber.length === 1 ? sameBankNoNumber[0] : null);
      jobs.push({ file, parsed, accountId: match ? match.id : 'new',
        newName: acc.name ? `${acc.name}${acc.last4 ? ' …' + acc.last4 : ''}` : `${guessInstitution(parsed, file.name)} account${acc.last4 ? ' …' + acc.last4 : ''}` });
    }
    draw();

    function draw() {
      const ok = jobs.filter(j => !j.parsed.error && j.parsed.rows.length);
      pv.innerHTML = `<h3>Check before importing</h3>
        <div class="tablewrap"><table><thead><tr><th>File</th><th>What was found</th><th>Import into</th></tr></thead><tbody>
        ${jobs.map((j, i) => {
          const p = j.parsed;
          if (p.error || !p.rows.length) return `<tr><td>${esc(j.file.name)}</td><td colspan="2" class="msg error">${esc(p.error || 'No transactions found')}</td></tr>`;
          const dates = p.rows.map(r => r.date).sort();
          const ins = p.rows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0);
          const outs = -p.rows.filter(r => r.amount < 0).reduce((s, r) => s + r.amount, 0);
          return `<tr><td>${esc(j.file.name)}<br><span class="hint">${esc(label(p.format))}${p.account?.name ? ' · ' + esc(p.account.name) : ''}${p.account?.last4 ? ' · account …' + esc(p.account.last4) : ''}</span></td>
            <td><b>${p.rows.length}</b> transactions<br><span class="hint">${esc(fmtDate(dates[0]))} – ${esc(fmtDate(dates.at(-1)))}<br>in ${money(ins)} · out ${money(outs)}${p.account?.balance != null ? '<br>balance now ' + money(p.account.balance) : ''}</span>
              ${p.skipped.length ? `<br><span class="msg error">${p.skipped.length} line(s) skipped</span>` : ''}</td>
            <td><select data-i="${i}" class="j-acct"><option value="new" ${j.accountId === 'new' ? 'selected' : ''}>+ New account</option>
              ${cache.accounts.map(a => `<option value="${a.id}" ${a.id === j.accountId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
              ${j.accountId === 'new' ? `<input class="j-name" data-i="${i}" value="${esc(j.newName)}" aria-label="New account name">
                <label style="font-weight:400"><input type="checkbox" class="j-joint" data-i="${i}" ${j.joint ? 'checked' : ''}> Joint / shared account</label>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>
        ${ok.length ? `<details><summary>Preview first rows</summary>${ok.map(j => `<h3>${esc(j.file.name)}</h3><div class="tablewrap"><table><tbody>${j.parsed.rows.slice(0, 5).map(r => `<tr><td>${esc(fmtDate(r.date))}</td><td>${esc(r.description)}</td><td class="num ${r.amount > 0 ? 'in' : ''}">${money(r.amount)}</td></tr>`).join('')}</tbody></table></div>`).join('')}</details>
        <div class="row" style="margin-top:1rem"><button class="primary" id="i-go">Import ${ok.reduce((s, j) => s + j.parsed.rows.length, 0)} transactions into ${ok.length} account(s)</button></div>` : ''}`;
      pv.querySelectorAll('.j-acct').forEach(s => s.onchange = () => { jobs[s.dataset.i].accountId = s.value; draw(); });
      pv.querySelectorAll('.j-name').forEach(inp => inp.oninput = () => { jobs[inp.dataset.i].newName = inp.value; });
      pv.querySelectorAll('.j-joint').forEach(c => c.onchange = () => { jobs[c.dataset.i].joint = c.checked; });
      $('#i-go')?.addEventListener('click', run);
    }

    async function run() {
      $('#i-go').disabled = true;
      const results = [];
      for (const j of jobs) {
        const p = j.parsed; if (p.error || !p.rows.length) continue;
        let accountId = j.accountId;
        if (accountId === 'new') {
          const name = (j.newName || '').trim() || 'New account';
          const open = openingFor(p);
          const created = await q(sb.from('accounts').insert({ name, institution: guessInstitution(p, j.file.name), account_type: guessType(name),
            nickname_last4: p.account?.last4 || null, opening_balance: open.balance, opening_date: open.date,
            is_joint: !!j.joint, my_share_pct: j.joint ? Number(cache.settings?.default_my_share_pct ?? 50) : 100 }).select().single());
          accountId = created.id; await loadLookups();
          jobs.filter(o => o !== j && o.accountId === 'new' && o.newName === j.newName).forEach(o => o.accountId = accountId);
        } else {
          // file reaches further back than this account's start date: move the start back
          const acct = cache.accounts.find(a => a.id === accountId);
          const open = openingFor(p);
          const hasBal = p.rows.some(r => r.balance != null);
          if (acct && hasBal && open.date < acct.opening_date) {
            await q(sb.from('accounts').update({ opening_balance: open.balance, opening_date: open.date }).eq('id', accountId));
          }
        }
        // Number identical same-day transactions across the whole file, so two genuine
        // $25 payments on the same day are never mistaken for a duplicate when sent in chunks.
        const seen = new Map();
        const rows = p.rows.map(r => {
          const key = `${r.date}|${r.amount.toFixed(2)}|${r.description.replace(/\s+/g, ' ').trim().toUpperCase()}`;
          const occ = (seen.get(key) || 0) + 1; seen.set(key, occ);
          return { ...r, occ };
        });
        let tot = { inserted: 0, duplicates: 0, linked_to_bills: 0, shared_added: 0 };
        for (let k = 0; k < rows.length; k += 1000) {
          const res = await q(sb.rpc('import_transactions', { p_account_id: accountId, p_rows: rows.slice(k, k + 1000), p_filename: j.file.name, p_format: p.format }));
          for (const key in tot) tot[key] += res[key] || 0;
        }
        results.push(`<li><b>${esc(j.file.name)}</b> → ${esc(refName('accounts', accountId))}: ${tot.inserted} new, ${tot.duplicates} already there, ${tot.linked_to_bills} matched to bills, ${tot.shared_added} added to shared costs</li>`);
      }
      pv.innerHTML = `<p class="msg"><b>Done.</b></p><ul>${results.join('')}</ul>
        <p>Next: <button class="link" id="go-uncat2">sort the uncategorised transactions</button>.</p>`;
      $('#go-uncat2').onclick = () => show('sort');
      $('#i-file').value = ''; await loadHistory();
    }
  };

  async function loadHistory() {
    const rows = await q(sb.from('import_batches').select('*').order('created_at', { ascending: false }).limit(30));
    $('#i-history').innerHTML = `<h2>Recent imports</h2>${rows.length ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Account</th><th>File</th><th class="num">New</th><th class="num">Skipped</th><th></th></tr></thead><tbody>
      ${rows.map((b, i) => `<tr><td>${new Date(b.created_at).toLocaleString('en-AU')}</td><td>${esc(refName('accounts', b.account_id))}</td><td>${esc(b.filename)}</td><td class="num">${b.rows_inserted}</td><td class="num">${b.rows_duplicate}</td>
        <td><button class="small danger undo" data-i="${i}">Undo</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No imports yet.</p>'}`;
    $('#i-history').querySelectorAll('.undo').forEach(b => b.onclick = async () => {
      const batch = rows[b.dataset.i];
      if (!confirm(`Remove the ${batch.rows_inserted} transactions added by this import? Shared-cost entries created from them are removed too.`)) return;
      const ids = (await q(sb.from('transactions').select('id').eq('import_batch_id', batch.id))).map(r => r.id);
      for (let i = 0; i < ids.length; i += 200) await q(sb.from('shared_ledger').delete().in('transaction_id', ids.slice(i, i + 200)));
      await q(sb.from('transactions').delete().eq('import_batch_id', batch.id));
      await q(sb.from('import_batches').delete().eq('id', batch.id));
      toast('Import undone'); loadHistory();
    });
  }
  await loadHistory();
}

// ---------- BILLS & INCOME ----------
async function recurringPage(kind) {
  const isBills = kind === 'bills';
  const dir = isBills ? 'out' : 'in';
  const me = cache.settings?.display_name || 'Me', partner = cache.settings?.partner_label || 'Partner';
  const names = { all: 'Household', me, partner };
  const whoName = names[personView];
  const possessive = personView === 'all' ? (isBills ? 'household' : 'household') : `${whoName}'s`;
  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">${isBills ? 'Bills' : 'Income'}</h1>
      <p class="hint">${isBills ? 'Regular payments, including loan repayments.' : 'Regular money coming in.'} Matched automatically when you import statements.</p></div>
      <div class="who-now">${esc(names[personView])}</div></div>
    <div class="tiles" id="r-tiles"></div>
    <div class="grid2">
      <section class="card"><div class="sec-head"><div><h2>${isBills ? 'Due' : 'Expected'} in the next 5 weeks</h2><p class="hint">${esc(possessive)} amounts</p></div></div><div id="r-up"></div></section>
      <section class="card"><div class="sec-head"><div><h2>Per month</h2><p class="hint">${esc(possessive)} ${isBills ? 'bills' : 'income'} by source</p></div></div><div id="r-chart"></div></section>
    </div>
    <section class="card" id="r-list"></section>`;


  const drawTop = async () => {
    const [itemsAll, up] = await Promise.all([
      q(sb.from('recurring_items').select('*').eq('direction', dir).eq('is_active', true)),
      q(sb.rpc('upcoming_items', { p_days: 35 })),
    ]);
    const items = itemsAll.filter(i => shareFor(i.my_share_pct) > 0);
    const monthly = i => i.amount * PER_MONTH[i.frequency] * shareFor(i.my_share_pct);
    const pm = sum(items, monthly);
    const upShare = u => personView === 'all' ? Number(u.amount) : personView === 'me' ? Number(u.my_amount) : Number(u.amount) - Number(u.my_amount);
    const mine = up.filter(u => u.direction === dir && upShare(u) > 0.004);
    const late = mine.filter(u => u.overdue);
    const pmFor = who => sum(itemsAll, i => i.amount * PER_MONTH[i.frequency] * shareFor(i.my_share_pct, who));
    $('#r-tiles').innerHTML = personView === 'all' ? `
      <div class="tile"><div class="tile-label">${isBills ? 'Bills' : 'Income'} per month ${info('Every regular item converted to a monthly amount: weekly × 52 ÷ 12, fortnightly × 26 ÷ 12, quarterly ÷ 3, yearly ÷ 12.')}</div><div class="tile-value">${moneyRound(pm)}</div><div class="tile-sub">household${isBills ? ', including loan repayments' : ''}</div></div>
      <div class="tile"><div class="tile-label">${esc(me)}</div><div class="tile-value">${moneyRound(pmFor('me'))}</div><div class="tile-sub">per month</div></div>
      <div class="tile"><div class="tile-label">${esc(partner)}</div><div class="tile-value">${moneyRound(pmFor('partner'))}</div><div class="tile-sub">per month</div></div>
      <div class="tile ${late.length ? 'bad' : ''}"><div class="tile-label">${isBills ? 'Overdue' : 'Late'}</div><div class="tile-value">${late.length}</div><div class="tile-sub">${late.length ? moneyRound(sum(late, upShare)) : 'all up to date'}</div></div>`
    : `
      <div class="tile"><div class="tile-label">${esc(whoName)} — per month</div><div class="tile-value">${moneyRound(pm)}</div><div class="tile-sub">${items.length} item${items.length === 1 ? '' : 's'}</div></div>
      <div class="tile"><div class="tile-label">Per fortnight</div><div class="tile-value">${moneyRound(pm * 12 / 26)}</div><div class="tile-sub">same amount, fortnightly</div></div>
      <div class="tile"><div class="tile-label">Share of household</div><div class="tile-value">${pmFor('all') ? Math.round(pm / pmFor('all') * 100) : 0}%</div><div class="tile-sub">of ${moneyRound(pmFor('all'))} a month</div></div>
      <div class="tile ${late.length ? 'bad' : ''}"><div class="tile-label">${isBills ? 'Overdue' : 'Late'}</div><div class="tile-value">${late.length}</div><div class="tile-sub">${late.length ? moneyRound(sum(late, upShare)) : 'all up to date'}</div></div>`;
    $('#r-up').innerHTML = mine.length ? `<ul class="due-list">${mine.map(u => {
      const d = daysFromToday(u.due_date);
      const when = u.overdue ? (isBills ? 'overdue' : 'late') : d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
      const part = upShare(u) < Number(u.amount) - 0.004 ? ` · share of ${money(u.amount)}` : '';
      return `<li class="${u.overdue ? 'is-late' : ''}"><div class="due-date"><b>${new Date(u.due_date + 'T00:00:00').getDate()}</b><span>${new Date(u.due_date + 'T00:00:00').toLocaleDateString('en-AU', { month: 'short' })}</span></div>
        <div class="due-main"><b>${esc(u.name)}</b><div class="hint">${when}${u.debt_id ? ' · loan repayment' : ''}${part}</div></div>
        <div class="due-amt ${isBills ? '' : 'in'}">${money(upShare(u))}</div>
        ${isBills && d <= 7 ? `<button class="small mark-paid" data-id="${u.item_id}" data-due="${u.due_date}">Paid</button>` : '<span></span>'}</li>`; }).join('')}</ul>
      <p class="hint total-line">Total ${money(sum(mine, upShare))}</p>` : '<p class="empty">Nothing in the next 5 weeks.</p>';
    $('#r-up').querySelectorAll('.mark-paid').forEach(b => b.onclick = () => markPaid(b.dataset.id, b.dataset.due, () => recurringPage(kind)));
    hbarChart($('#r-chart'), { items: items.map(i => ({ label: i.name, value: monthly(i),
        note: shareFor(i.my_share_pct) < 1 ? `${Math.round(shareFor(i.my_share_pct) * 100)}% of ${money(i.amount * PER_MONTH[i.frequency])}` : null }))
      .sort((x, y) => y.value - x.value), color: isBills ? SERIES.orange : SERIES.blue, empty: `No ${isBills ? 'bills' : 'income'} for ${whoName}.` });
    if (items.length) $('#r-chart').insertAdjacentHTML('beforeend', `<p class="hint total-line">Total ${money(pm)} per month</p>`);
  };
  let rows = [];
  const drawList = async () => {
    rows = await renderCrud($('#r-list'), kind, {
      filter: { direction: dir }, title: personView === 'all' ? (isBills ? 'All bills' : 'All income') : `${whoName}'s ${isBills ? 'bills' : 'income'}`,
      subtitle: personView === 'all' ? '' : `Shared items show ${esc(whoName)}'s part. Change the split with Edit → My share %.`,
      rowFilter: r => shareFor(r.my_share_pct) > 0,
      headers: { who_month: personView === 'all' ? 'Per month' : `${whoName} / month` },
      onChange: async () => { await drawTop(); await drawList(); },
      extra: (r, i) => isBills && r.is_active ? `<button class="small b-paid" data-i="${i}">Paid</button>` : '',
    });
    $('#r-list').querySelectorAll('.b-paid').forEach(b => b.onclick = () => { const r = rows[b.dataset.i]; markPaid(r.id, r.next_due, () => recurringPage(kind)); });
  };
  await Promise.all([drawTop(), drawList()]);
}
const bills = () => { store.set('visitedBills', true); return recurringPage('bills'); };
const income = () => recurringPage('income');

// ---------- DEBTS ----------
async function debts() {
  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Debts</h1><div class="who-now inline">${esc(personName())}</div><p class="hint">Everything owed, with a log of every call to creditors. Home loan balances update when you import.</p></div></div>
    <div class="tiles" id="d-sum"></div>
    <section class="card"><div class="sec-head"><div><h2>Who you owe</h2><p class="hint">${personView === 'all' ? 'Household balances' : esc(personName()) + "'s share of each balance"} · the long bars are the home loans</p></div></div><div id="d-chart"></div></section>
    <section class="card" id="d-list"></section><section class="card hidden" id="d-log"></section>`;
  const top = async () => {
    const [d, allRows] = await Promise.all([q(sb.from('v_debt_summary').select('*').maybeSingle()), q(sb.from('debts').select('*').eq('status', 'active').order('current_balance', { ascending: false }))]);
    const sd = d || {};
    const f = x => shareFor(x.my_share_pct);
    const all = allRows.filter(x => f(x) > 0);
    const who = personView === 'all' ? 'household' : personName() + "'s share";
    $('#d-sum').innerHTML = `
      <div class="tile"><div class="tile-label">Total owed ${info('The balance of every active debt. Home loans update automatically when you import statements; others are what you typed in.')}</div><div class="tile-value">${moneyRound(sum(all, x => x.current_balance * f(x)))}</div><div class="tile-sub">${esc(who)}</div></div>
      <div class="tile"><div class="tile-label">Repayments per month ${info('The required repayment for each debt converted to a monthly amount. For Afterpay and Deferit it\'s the average you\'ve actually paid over the last 6 months.')}</div><div class="tile-value">${moneyRound(sum(all, x => (x.min_payment || 0) * PER_MONTH[x.payment_frequency || 'monthly'] * f(x)))}</div><div class="tile-sub">${esc(who)}</div></div>
      <div class="tile ${Number(sd.my_total_arrears) > 0 ? 'bad' : ''}"><div class="tile-label">Overdue</div><div class="tile-value">${moneyRound(sum(all, x => x.arrears_amount * f(x)))}</div><div class="tile-sub">${esc(who)}, entered as arrears</div></div>
      <div class="tile ${sd.on_hardship ? 'good' : ''}"><div class="tile-label">On hardship</div><div class="tile-value">${sd.on_hardship || 0} <small>of ${sd.active_debts || 0}</small></div><div class="tile-sub">${sd.hardship_to_request ? sd.hardship_to_request + ' to request' : 'National Debt Helpline 1800 007 007'}</div></div>`;
    hbarChart($('#d-chart'), { items: all.map(x => ({ label: x.creditor, value: Number(x.current_balance) * f(x),
      note: x.current_balance > 0 ? null : 'balance not entered — click Edit below', badge: x.arrears_amount > 0 ? 'overdue' : null, badgeClass: 'bad' })), color: SERIES.orange });
  };
  const showLog = async (debt) => {
    const box = $('#d-log'); box.classList.remove('hidden');
    await renderCrud(box, 'debt_contacts', { filter: { debt_id: debt.id }, title: `Contact log — ${debt.creditor}`, subtitle: 'Every call, email or letter: who you spoke to, what was agreed, when to follow up.' });
    box.scrollIntoView({ behavior: 'smooth' });
  };
  let current = [];
  const list = async () => {
    current = await renderCrud($('#d-list'), 'debts', { title: personView === 'all' ? 'All debts' : `${personName()}'s debts`,
      rowFilter: r => shareFor(r.my_share_pct) > 0,
      subtitle: personView === 'all' ? '' : 'Balances in this list are the full amounts; the tiles and chart above show ' + esc(personName()) + "'s share.",
      onChange: async () => { await top(); await list(); },
      extra: (r, i) => `<button class="small log" data-i="${i}">Calls</button>`,
    });
    $('#d-list').querySelectorAll('.log').forEach(b => b.onclick = () => showLog(current[b.dataset.i]));
  };
  await Promise.all([top(), list()]);
}

// ---------- TAX (board income & claimable costs, per person) ----------
const fyOf = d => { const y = +d.slice(0, 4), m = +d.slice(5, 7); const s = m >= 7 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };
const fyRange = fy => { const s = +fy.slice(0, 4); return [`${s}-07-01`, `${s + 1}-06-30`]; };
const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5) + 1;
let taxFy = null;
let taxWho = null;
async function taxView() {
  view.innerHTML = '<p class="loading">Loading…</p>';
  // Tax is personal: follow the top-bar switch when it names a person; 'Household' keeps the last person shown here
  taxWho = personView === 'all' ? (taxWho || 'me') : personView;
  const meName = cache.settings?.display_name || 'Me', partnerName = cache.settings?.partner_label || 'Partner';
  const oldest = (await q(sb.from('transactions').select('txn_date').order('txn_date').limit(1)))[0]?.txn_date || today();
  const fys = []; for (let f = fyOf(today()); f >= fyOf(oldest); f = `${+f.slice(0, 4) - 1}-${String(+f.slice(0, 4) % 100).padStart(2, '0')}`) fys.push(f);
  if (!taxFy || !fys.includes(taxFy)) taxFy = fys[0];
  const [fyStart, fyEnd] = fyRange(taxFy);
  const periodEnd = today() < fyEnd ? today() : fyEnd;

  // data for the year
  let txns = [];
  for (let from = 0; ; from += 1000) {
    const page = await q(sb.from('transactions').select('id, txn_date, amount, description, category_id, account_id').gte('txn_date', fyStart).lte('txn_date', fyEnd).order('txn_date').range(from, from + 999));
    txns = txns.concat(page); if (page.length < 1000) break;
  }
  const [saved, extras, boardItems, roomYears] = await Promise.all([
    q(sb.from('tax_years').select('*').eq('fy', taxFy).maybeSingle()),
    q(sb.from('tax_extras').select('*').eq('fy', taxFy).order('entry_date')),
    q(sb.from('recurring_items').select('*').eq('direction', 'in')),
    q(sb.from('tax_years').select('fy, rooms').order('fy', { ascending: false })),
  ]);
  const catBy = new Map(cache.categories.map(c => [c.id, c]));
  const boardCat = cache.categories.find(c => /board|rent received/i.test(c.name) && c.kind === 'income');
  const interestCat = cache.categories.find(c => /^loan interest/i.test(c.name));
  const loans = cache.accounts.filter(a => ['mortgage', 'loan'].includes(a.account_type));
  const boardTx = txns.filter(t => boardCat && t.category_id === boardCat.id && t.amount > 0);
  const boardItem = boardItems.filter(i => boardCat && i.category_id === boardCat.id && i.is_active);

  const defaults = {
    my_share_pct: boardItem.length ? Number(boardItem[0].my_share_pct) : 50,
    floor_pct: null, area_private: null, area_shared: null, area_total: null,
    rented_from: boardTx[0]?.txn_date || null, rented_to: null,
    included_categories: cache.categories.filter(c => ['Rates', 'Water', 'Power', 'Phone & internet'].includes(c.name)).map(c => c.id),
    included_loan_accounts: loans.filter(a => a.account_type === 'mortgage').map(a => a.id),
    notes: '',
    rooms: (roomYears.find(y => (y.rooms || []).length) || {}).rooms || [],
  };
  const st = { ...defaults, ...(saved || {}) };
  if (!(st.rooms || []).length) st.rooms = defaults.rooms;
  const USES = { boarders: 'Boarders only', shared: 'Shared', owners: 'Owners only', excluded: 'Not counted' };
  const roomTotals = () => {
    const rs = st.rooms || [], t = u => sum(rs.filter(r => r.use === u), r => r.m2);
    const A = t('boarders'), B = t('shared'), C = sum(rs.filter(r => r.use !== 'excluded'), r => r.m2);
    return { A, B, C, pct: C ? Math.round(((A + B / 2) / C) * 10000) / 100 : null };
  };
  if ((st.rooms || []).length) { const rt = roomTotals(); st.floor_pct = rt.pct; st.area_private = rt.A; st.area_shared = rt.B; st.area_total = rt.C; }

  const draw = () => {
    const share = taxWho === 'me' ? st.my_share_pct / 100 : 1 - st.my_share_pct / 100;
    const who = taxWho === 'me' ? meName : partnerName;
    const rFrom = st.rented_from && st.rented_from > fyStart ? st.rented_from : fyStart;
    const rTo = st.rented_to && st.rented_to < periodEnd ? st.rented_to : periodEnd;
    const periodDays = dayDiff(fyStart, periodEnd);
    const rentedDays = st.rented_from ? Math.max(0, dayDiff(rFrom, rTo)) : 0;
    const timePct = periodDays ? rentedDays / periodDays : 0;
    const floor = st.floor_pct == null ? null : Number(st.floor_pct) / 100;
    const factor = floor == null ? 0 : floor * timePct;

    // expenses by category (money out), interest from the chosen loans
    const byCat = new Map();
    for (const t of txns) {
      if (t.amount >= 0) continue;
      const c = catBy.get(t.category_id);
      if (!c) continue;
      if (interestCat && c.id === interestCat.id && !st.included_loan_accounts.includes(t.account_id)) continue;
      if (c.kind === 'transfer' && !(interestCat && c.id === interestCat.id)) continue;
      byCat.set(c.id, (byCat.get(c.id) || 0) - t.amount);
    }
    const candidates = [...byCat.entries()].map(([id, total]) => ({ id, total, c: catBy.get(id) }))
      .filter(x => x.c.kind !== 'income').sort((a, b) => b.total - a.total);
    const incl = id => st.included_categories.includes(id) || (interestCat && id === interestCat.id && st.included_loan_accounts.length);
    const boardTotal = sum(boardTx, t => t.amount) + sum(extras.filter(e => e.kind === 'income'), e => e.amount);
    const catClaim = sum(candidates.filter(x => incl(x.id)), x => x.total * factor);
    const extraClaim = sum(extras.filter(e => e.kind === 'expense'), e => e.amount * (e.apportion ? factor : 1));
    const claimHouse = catClaim + extraClaim;
    const incomeMine = boardTotal * share, claimMine = claimHouse * share;
    const net = incomeMine - claimMine;

    // Centrelink estimate (per year, then fortnight): 70% of board (lodging only) minus mortgage interest
    const boardYear = sum(boardItem, i => i.amount * PER_MONTH[i.frequency] * 12);
    const months = new Map();
    for (const t of boardTx) { const m = t.txn_date.slice(0, 7); months.set(m, (months.get(m) || 0) + t.amount); }

    view.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Tax time</h1>
        <p class="hint">Board income and the claimable share of house costs for a financial year. A guide for your tax return — check it with the ATO's free Tax Help program or a tax agent.</p></div>
        <div class="row">
          <div class="seg big" role="tablist">${[['me', meName], ['partner', partnerName]].map(([k, v]) => `<button class="${taxWho === k ? 'on' : ''}" data-taxwho="${k}" role="tab" aria-selected="${taxWho === k}">${esc(v)}</button>`).join('')}</div>
          <select id="tax-fy" aria-label="Financial year" style="width:auto;margin:0">${fys.map(f => `<option ${f === taxFy ? 'selected' : ''} value="${f}">FY ${f.slice(0, 4)}–${f.slice(5)}${f === fyOf(today()) ? ' (so far)' : ''}</option>`).join('')}</select>
        </div></div>

      ${floor == null ? `<div class="alert warning"><span class="alert-icon">•</span><div><b>Set the share of the home the boarders use</b><div class="hint">Fill in "Home used by boarders" below — claimable costs can't be worked out without it.</div></div><span></span></div><br>` : ''}

      <div class="tiles">
        <div class="tile"><div class="tile-label">Board received — ${esc(who)}</div><div class="tile-value">${moneyRound(incomeMine)}</div><div class="tile-sub">${Math.round(share * 100)}% of ${moneyRound(boardTotal)} · ${boardTx.length} payment${boardTx.length === 1 ? '' : 's'}</div></div>
        <div class="tile"><div class="tile-label">Claimable costs — ${esc(who)} ${info('Each ticked house cost × the share of the home the boarders use × the share of the year they lived there × this person\'s ownership share. This follows the ATO floor-area method — check it with Tax Help or a tax agent.')}</div><div class="tile-value">${moneyRound(claimMine)}</div><div class="tile-sub">${floor == null ? 'needs the floor-area %' : `${Math.round(factor * 1000) / 10}% of included costs`}</div></div>
        <div class="tile ${net < 0 ? 'good' : ''}"><div class="tile-label">Net rental ${net < 0 ? 'loss' : 'income'} ${info('Board received minus claimable costs. This is the estimate that goes in the rental section of the tax return.')}</div><div class="tile-value">${moneyRound(net)}</div><div class="tile-sub">what goes on the return (estimate)</div></div>
      </div>

      <div class="grid2">
        <section class="card"><div class="sec-head"><div><h2>Home used by boarders</h2><p class="hint">ATO floor-area method: (boarders' own rooms + half the shared areas) ÷ whole home</p></div></div>
          ${(st.rooms || []).length ? (() => { const rt = roomTotals(); return `<div class="tablewrap"><table class="list rooms"><thead><tr><th>Room</th><th class="num">m²</th><th>Used by</th><th></th></tr></thead><tbody>
            ${st.rooms.map((r, i) => `<tr class="use-${r.use}"><td><input class="r-name" data-i="${i}" value="${esc(r.name)}" aria-label="Room name">${r.note ? `<div class="hint">${esc(r.note)}</div>` : ''}</td>
              <td class="num"><input class="r-m2" data-i="${i}" type="number" step="0.01" min="0" value="${r.m2}" aria-label="Area m²" style="width:6.5rem;text-align:right"></td>
              <td><select class="r-use" data-i="${i}" aria-label="Used by">${Object.entries(USES).map(([k, v]) => `<option value="${k}" ${r.use === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
              <td><button class="small ghost r-del" data-i="${i}" aria-label="Remove room">✕</button></td></tr>`).join('')}</tbody>
            <tfoot><tr class="total"><td colspan="4">Boarders only <b>${rt.A.toFixed(2)} m²</b> · Shared <b>${rt.B.toFixed(2)} m²</b> · Whole home <b>${rt.C.toFixed(2)} m²</b><br>
              (${rt.A.toFixed(2)} + ${rt.B.toFixed(2)} ÷ 2) ÷ ${rt.C.toFixed(2)} = <b>${rt.pct}%</b> of the home</td></tr></tfoot></table></div>
            <div class="row"><button class="small" id="r-add">+ Add room</button><span class="hint">Change any size or who uses it — the % updates when you press Save.</span></div>`; })() : ''}
          <div class="formgrid ${(st.rooms || []).length ? 'hidden' : ''}">
            <label>Boarders' own rooms (m²) <input type="number" step="0.1" id="t-ap" value="${esc(st.area_private ?? '')}"></label>
            <label>Shared areas (m²) <span class="hint">kitchen, lounge, bathroom…</span><input type="number" step="0.1" id="t-as" value="${esc(st.area_shared ?? '')}"></label>
            <label>Whole home (m²) <input type="number" step="0.1" id="t-at" value="${esc(st.area_total ?? '')}"></label>
            <label>Share of home used <span class="hint">% — worked out, or type your own</span><input type="number" step="0.01" min="0" max="100" id="t-floor" value="${esc(st.floor_pct ?? '')}"></label>
          </div>
          ${(st.rooms || []).length ? '' : '<p class="hint"><button class="link" id="r-start">Or list the rooms one by one</button> (more accurate).</p>'}
          <div class="formgrid">
            <label>Boarders there from <input type="date" id="t-from" value="${esc(st.rented_from ?? '')}"></label>
            <label>Until <span class="hint">blank = still there</span><input type="date" id="t-to" value="${esc(st.rented_to ?? '')}"></label>
            <label>${esc(meName)}'s share of the house & board % <input type="number" step="1" min="0" max="100" id="t-share" value="${esc(st.my_share_pct)}"></label>
          </div>
          <p class="hint">Time: ${rentedDays} of ${periodDays} days${taxFy === fyOf(today()) ? ' so far this year' : ''} (${Math.round(timePct * 100)}%). Claimable share = ${floor == null ? '?' : Math.round(floor * 1000) / 10 + '%'} of the home × ${Math.round(timePct * 100)}% of the time${floor == null ? '' : ` = <b>${Math.round(factor * 1000) / 10}%</b> of each included cost`}.</p>
          <div class="row"><button class="primary" id="t-save">Save</button><span class="hint" id="t-saved"></span></div>
        </section>

        <section class="card"><div class="sec-head"><div><h2>Board received by month</h2><p class="hint">Household · ${esc(who)}'s share is ${Math.round(share * 100)}%</p></div></div>
          <div id="t-months"></div></section>
      </div>

      <section class="card"><div class="sec-head"><div><h2>House costs this year</h2>
          <p class="hint">Tick the costs that are for the home. Only home-related costs count — not car insurance, food for yourselves, or personal items. Interest counts only on loans used to buy the home.</p></div></div>
        <div class="tablewrap"><table class="list"><thead><tr><th>Count?</th><th>Cost</th><th class="num">Paid this year</th><th class="num">Claimable (household)</th><th class="num">${esc(who)}</th></tr></thead><tbody>
          ${candidates.map(x => `<tr><td><input type="checkbox" class="t-cat" data-id="${x.id}" ${incl(x.id) ? 'checked' : ''} aria-label="Count ${esc(x.c.name)}"></td>
            <td>${esc(x.c.name.replace(' (not counted)', ''))}${interestCat && x.id === interestCat.id ? `<div class="hint">${loans.map(a => `<label class="mcheck" style="display:inline-block;margin-right:.8rem"><input type="checkbox" class="t-loan" data-id="${a.id}" ${st.included_loan_accounts.includes(a.id) ? 'checked' : ''}> ${esc(a.name)}</label>`).join('')}</div>` : ''}
              ${/insurance/i.test(x.c.name) ? '<div class="hint">only home &amp; contents / building insurance counts</div>' : ''}</td>
            <td class="num">${money(x.total)}</td><td class="num">${incl(x.id) ? money(x.total * factor) : '<span class="hint">—</span>'}</td><td class="num">${incl(x.id) ? money(x.total * factor * share) : '<span class="hint">—</span>'}</td></tr>`).join('')}
        </tbody><tfoot><tr class="total"><td></td><td><b>Total from bank data</b></td><td></td><td class="num"><b>${money(catClaim)}</b></td><td class="num"><b>${money(catClaim * share)}</b></td></tr></tfoot></table></div>
      </section>

      <section class="card" id="t-extras"></section>

      <section class="card"><div class="sec-head"><div><h2>Centrelink check</h2><p class="hint">How much of the board Centrelink counts (lodging only, no meals)</p></div></div>
        <div id="t-cl"></div></section>

      <div class="row"><button id="t-csv">Download for tax agent (CSV)</button><button id="t-print">Print</button></div>
      <p class="hint">This is a guide, not tax advice. Keep receipts and bank statements. Renting part of your main residence can reduce the capital gains tax exemption when you sell.</p>`;

    // board by month chart
    const ms = [...months.keys()].sort();
    if (ms.length) columnChart($('#t-months'), { title: 'Board received by month', labels: ms.map(m => new Date(m + '-01T00:00:00').toLocaleDateString('en-AU', { month: 'short' })),
      tipLabels: ms.map(m => new Date(m + '-01T00:00:00').toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })),
      series: [{ name: 'Board received', color: SERIES.blue, values: ms.map(m => months.get(m)) }], height: 190 });
    else $('#t-months').innerHTML = '<p class="empty">No board recorded in this year.</p>';

    // Centrelink: annual board (current rate) × share × 70% − share of annual mortgage interest
    (async () => {
      const cut = new Date(Date.now() - 365 * 864e5).toLocaleDateString('en-CA');
      const ints = interestCat && st.included_loan_accounts.length ? await q(sb.from('transactions').select('amount').eq('category_id', interestCat.id).in('account_id', st.included_loan_accounts).gte('txn_date', cut)) : [];
      const interestYear = -sum(ints, t => t.amount);
      const counted = boardYear * share * 0.7, deduction = interestYear * share, assessed = Math.max(0, counted - deduction);
      $('#t-cl').innerHTML = `<div class="tablewrap"><table class="list"><tbody>
        <tr><td>Board at the current rate, ${esc(who)}'s ${Math.round(share * 100)}%</td><td class="num">${money(boardYear * share)} / year</td></tr>
        <tr><td>70% counted (lodging only — utilities and supplies don't change this)</td><td class="num">${money(counted)}</td></tr>
        <tr><td>Less ${esc(who)}'s share of mortgage interest (last 12 months)</td><td class="num">−${money(deduction)}</td></tr>
        </tbody><tfoot><tr class="total"><td><b>Income Centrelink would count</b></td><td class="num"><b>${money(assessed)} / year</b><br><span class="hint">${money(assessed / 26)} a fortnight</span></td></tr></tfoot></table></div>
        <p class="callout ${assessed > 0 ? 'bad' : 'good'}">${assessed > 0 ? `About <b>${money(assessed / 26)}</b> a fortnight would be counted in the income test.` : `Likely <b>nothing</b> counted — the mortgage interest is more than the counted board. It still needs to be reported.`}
          Report it in myGov → Centrelink → Manage Income and Assets → Other Income.</p>`;
    })();

    // extras list
    renderCrudExtras();

    // events
    view.querySelectorAll('[data-taxwho]').forEach(b => b.onclick = () => { taxWho = personView = b.dataset.taxwho; try { localStorage.setItem('personView', personView); } catch {} renderWhoSwitch(); draw(); });
    $('#tax-fy').onchange = e => { taxFy = e.target.value; taxView(); };
    const areaCalc = () => {
      const A = Number($('#t-ap').value), B = Number($('#t-as').value), C = Number($('#t-at').value);
      if (A >= 0 && C > 0 && $('#t-ap').value !== '' && $('#t-at').value !== '') $('#t-floor').value = (Math.round(((A + (B || 0) / 2) / C) * 10000) / 100).toFixed(2);
    };
    ['#t-ap', '#t-as', '#t-at'].forEach(s => $(s).oninput = areaCalc);
    view.querySelectorAll('.t-cat').forEach(c => c.onchange = () => {
      const id = c.dataset.id;
      if (interestCat && id === interestCat.id) st.included_loan_accounts = c.checked ? loans.filter(a => a.account_type === 'mortgage').map(a => a.id) : [];
      else st.included_categories = c.checked ? [...new Set([...st.included_categories, id])] : st.included_categories.filter(x => x !== id);
      save(true);
    });
    view.querySelectorAll('.t-loan').forEach(c => c.onchange = () => {
      st.included_loan_accounts = c.checked ? [...new Set([...st.included_loan_accounts, c.dataset.id])] : st.included_loan_accounts.filter(x => x !== c.dataset.id);
      save(true);
    });
    view.querySelectorAll('.r-name').forEach(el => el.oninput = () => { st.rooms[el.dataset.i].name = el.value; });
    view.querySelectorAll('.r-m2').forEach(el => el.oninput = () => { st.rooms[el.dataset.i].m2 = Number(el.value || 0); });
    view.querySelectorAll('.r-use').forEach(el => el.onchange = () => { st.rooms[el.dataset.i].use = el.value; const rt = roomTotals(); Object.assign(st, { floor_pct: rt.pct, area_private: rt.A, area_shared: rt.B, area_total: rt.C }); draw(); });
    view.querySelectorAll('.r-del').forEach(el => el.onclick = () => { st.rooms.splice(+el.dataset.i, 1); const rt = roomTotals(); Object.assign(st, { floor_pct: rt.pct, area_private: rt.A, area_shared: rt.B, area_total: rt.C }); draw(); });
    $('#r-add')?.addEventListener('click', () => { st.rooms.push({ name: 'New room', m2: 0, use: 'owners', note: '' }); draw(); });
    $('#r-start')?.addEventListener('click', () => { st.rooms = [{ name: 'Boarder bedroom', m2: 0, use: 'boarders', note: '' }, { name: 'Kitchen', m2: 0, use: 'shared', note: '' }, { name: 'Rest of home', m2: 0, use: 'owners', note: '' }]; draw(); });
    $('#t-save').onclick = () => {
      if ((st.rooms || []).length) { const rt = roomTotals(); Object.assign(st, { floor_pct: rt.pct, area_private: rt.A, area_shared: rt.B, area_total: rt.C });
        $('#t-floor').value = rt.pct; $('#t-ap').value = rt.A; $('#t-as').value = rt.B; $('#t-at').value = rt.C; }
      const num = s => $(s).value === '' ? null : Number($(s).value);
      Object.assign(st, { area_private: num('#t-ap'), area_shared: num('#t-as'), area_total: num('#t-at'), floor_pct: num('#t-floor'),
        rented_from: $('#t-from').value || null, rented_to: $('#t-to').value || null, my_share_pct: num('#t-share') ?? 50 });
      save(false);
    };
    $('#t-print').onclick = () => window.print();
    $('#t-csv').onclick = () => {
      const rows = [['Household Finances — tax summary'], ['Financial year', `${taxFy.slice(0, 4)}-${taxFy.slice(5)}`], ['Person', who], ['Share of house & board %', Math.round(share * 100)],
        ['Share of home used by boarders %', st.floor_pct ?? ''], ['Days boarders there', `${rentedDays} of ${periodDays}`], ['Claimable factor %', Math.round(factor * 10000) / 100], [],
        ...((st.rooms || []).length ? [['Room', 'm²', 'Used by'], ...st.rooms.map(r => [r.name, Number(r.m2).toFixed(2), USES[r.use]]), []] : []),
        ['Board received (household)', boardTotal.toFixed(2)], [`Board received (${who})`, incomeMine.toFixed(2)], [],
        ['Cost', 'Paid this year (household)', 'Counted?', 'Claimable (household)', `Claimable (${who})`],
        ...candidates.map(x => [x.c.name.replace(' (not counted)', ''), x.total.toFixed(2), incl(x.id) ? 'yes' : 'no', incl(x.id) ? (x.total * factor).toFixed(2) : '0.00', incl(x.id) ? (x.total * factor * share).toFixed(2) : '0.00']),
        ...extras.map(e => [`${e.kind === 'income' ? 'Extra income' : 'Extra cost'}: ${e.description}`, Number(e.amount).toFixed(2), 'yes', e.kind === 'income' ? '' : (e.amount * (e.apportion ? factor : 1)).toFixed(2), e.kind === 'income' ? '' : (e.amount * (e.apportion ? factor : 1) * share).toFixed(2)]),
        [], [`Total claimable (${who})`, '', '', '', claimMine.toFixed(2)], [`Net rental income/loss (${who})`, '', '', '', net.toFixed(2)], [],
        ['Board payments'], ['Date', 'Description', 'Amount (household)'], ...boardTx.map(t => [t.txn_date, t.description, Number(t.amount).toFixed(2)])];
      const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `tax-summary-${taxFy}-${who.toLowerCase().replace(/\W+/g, '-')}.csv`; a.click(); URL.revokeObjectURL(a.href);
    };
  };

  async function save(quiet) {
    await q(sb.from('tax_years').upsert({ fy: taxFy, floor_pct: st.floor_pct, area_private: st.area_private, area_shared: st.area_shared, area_total: st.area_total,
      rented_from: st.rented_from, rented_to: st.rented_to, my_share_pct: st.my_share_pct, included_categories: st.included_categories,
      included_loan_accounts: st.included_loan_accounts, notes: st.notes || null, rooms: st.rooms || [] }, { onConflict: 'owner_id,fy' }));
    toast(quiet ? 'Updated' : 'Saved'); draw();
  }
  async function renderCrudExtras() {
    await renderCrud($('#t-extras'), 'tax_extras', { filter: { fy: taxFy }, title: 'Other costs or income',
      subtitle: 'Things not in your bank data — e.g. household supplies paid in cash, a repair, or a cleaner. Tick "shared household cost" for things everyone uses; untick for costs only for the boarders (claimed in full).',
      onChange: async () => { const e = await q(sb.from('tax_extras').select('*').eq('fy', taxFy).order('entry_date')); extras.length = 0; extras.push(...e); draw(); } });
  }
  draw();
}

// ---------- PAYSLIPS ----------
const SG_RATE = 0.12; // super guarantee 2026-27 (ATO): 12% of qualifying earnings, paid each payday from 1 Jul 2026
let payFy = null;
function payslipForm(row = null, scan = null) {
  const me = cache.settings?.display_name || 'Me', partner = cache.settings?.partner_label || 'Partner';
  const v = k => row?.[k] ?? scan?.fields?.[k] ?? '';
  const num = (k, lbl, hint = '') => `<label>${lbl}${hint ? ` <span class="hint">${hint}</span>` : ''}<input type="number" step="0.01" min="0" name="${k}" value="${esc(v(k))}"></label>`;
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog"><h2>${row ? 'Edit' : scan ? 'Check scanned' : 'Add'} payslip</h2>
      ${scan ? `<p class="callout ${scan.found.size ? 'good' : 'bad'}">${scan.found.size ? `Read <b>${scan.found.size}</b> value${scan.found.size === 1 ? '' : 's'} from <b>${esc(scan.file)}</b> — they're outlined in green. <b>Check every number against the payslip</b>, fill any blanks, then Save.` : ''}${scan.notes.map(n => `<br>• ${esc(n)}`).join('')}</p>` : ''}
      <div class="formgrid">
        <label>Whose payslip <select name="person"><option value="me">${esc(me)}</option><option value="partner">${esc(partner)}</option></select></label>
        <label>Employer <input name="employer" required value="${esc(v('employer'))}"></label>
        <label>Pay date <input type="date" name="pay_date" required value="${esc(v('pay_date') || today())}"></label>
        <label>Hours worked <input type="number" step="0.01" min="0" name="hours" value="${esc(v('hours'))}"></label>
        <label>Period from <input type="date" name="period_start" value="${esc(v('period_start'))}"></label>
        <label>Period to <input type="date" name="period_end" value="${esc(v('period_end'))}"></label>
      </div>
      <h3>Earnings (before tax)</h3>
      <div class="formgrid">
        ${num('ordinary_pay', 'Ordinary pay', 'base hours')}${num('overtime_pay', 'Overtime')}${num('allowances', 'Allowances')}
        ${num('bonus', 'Bonus / commission')}${num('leave_pay', 'Leave paid', 'annual, sick')}
        <label>Gross pay <span class="hint">adds up the boxes above — or type the payslip's total</span><input type="number" step="0.01" min="0" name="gross_pay" required value="${esc(v('gross_pay'))}"></label>
      </div>
      <h3>Tax &amp; deductions</h3>
      <div class="formgrid">
        ${num('tax_withheld', 'Tax withheld (PAYG)')}${num('salary_sacrifice', 'Salary sacrifice', 'before tax')}${num('other_deductions', 'Other deductions', 'after tax')}
        <label>Net pay (take-home) <span class="hint">as printed</span><input type="number" step="0.01" min="0" name="net_pay" required value="${esc(v('net_pay'))}"></label>
      </div>
      <p class="callout" id="ps-check"></p>
      <h3>Super, leave &amp; year to date <span class="hint">(optional)</span></h3>
      <div class="formgrid">
        ${num('super_employer', 'Employer super')}${num('annual_leave_hours', 'Annual leave balance', 'hours')}${num('sick_leave_hours', 'Sick leave balance', 'hours')}
        ${num('ytd_gross', 'YTD gross')}${num('ytd_tax', 'YTD tax')}${num('ytd_super', 'YTD super')}
      </div>
      <label>Notes <textarea name="notes" rows="2">${esc(v('notes'))}</textarea></label>
      <div class="row"><button class="primary" value="save">Save</button><button value="cancel" formnovalidate>Cancel</button></div></form>`;
    document.body.appendChild(dlg);
    const f = $('form', dlg);
    f.person.value = row?.person || (personView === 'partner' ? 'partner' : 'me');
    if (scan) for (const k of scan.found) if (f[k]) f[k].classList.add('scanned');
    const n = k => Number(f[k].value || 0);
    let grossTouched = !!row || (scan?.found?.has('gross_pay'));
    const parts = ['ordinary_pay', 'overtime_pay', 'allowances', 'bonus', 'leave_pay'];
    const check = () => {
      const partSum = parts.reduce((t, k) => t + n(k), 0);
      if (!grossTouched && partSum) f.gross_pay.value = partSum.toFixed(2);
      const gross = n('gross_pay'), calcNet = gross - n('salary_sacrifice') - n('tax_withheld') - n('other_deductions');
      const sg = (n('ordinary_pay') + n('leave_pay') + n('salary_sacrifice')) * SG_RATE;
      const msgs = [];
      if (gross && f.net_pay.value !== '') {
        const diff = n('net_pay') - calcNet;
        msgs.push(Math.abs(diff) < 0.05 ? `✓ Adds up: ${money(gross)} gross − deductions = ${money(calcNet)} take-home.` : `Check: gross minus tax and deductions is ${money(calcNet)}, but net pay is ${money(n('net_pay'))} (difference ${money(diff)}). A box may be missing.`);
      }
      if (gross) msgs.push(`Tax rate this pay: ${(n('tax_withheld') / gross * 100).toFixed(1)}%.`);
      if (n('ordinary_pay') && f.super_employer.value !== '') msgs.push(n('super_employer') + 0.05 >= sg ? `✓ Super looks right (12% minimum ≈ ${money(sg)}).` : `Super may be short: 12% minimum is about ${money(sg)}, payslip shows ${money(n('super_employer'))}.`);
      const box = $('#ps-check', dlg); box.innerHTML = msgs.join('<br>'); box.className = 'callout ' + (msgs.some(m => m.startsWith('Check') || m.startsWith('Super may')) ? 'bad' : msgs.length ? 'good' : '');
    };
    f.gross_pay.addEventListener('input', () => { grossTouched = f.gross_pay.value !== ''; });
    f.addEventListener('input', check); check();
    let done = false;
    f.addEventListener('submit', async e => {
      if (e.submitter?.value !== 'save') return;
      e.preventDefault();
      const out = {};
      for (const el of f.elements) {
        if (!el.name) continue;
        out[el.name] = el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : (el.value === '' ? null : el.value);
      }
      for (const k of [...parts, 'tax_withheld', 'salary_sacrifice', 'other_deductions', 'super_employer']) if (out[k] == null) out[k] = 0;
      try {
        if (row) await q(sb.from('payslips').update(out).eq('id', row.id)); else await q(sb.from('payslips').insert(out));
        toast('Payslip saved'); done = true; dlg.close(); resolve(true);
      } catch { /* toast shown */ }
    });
    dlg.addEventListener('close', () => { dlg.remove(); if (!done) resolve(false); });
    dlg.showModal();
  });
}

// Read a payslip file: PDF text directly; photos and scanned PDFs through text recognition (runs in the browser)
let tesseractReady = null;
function loadTesseract() {
  if (!tesseractReady) tesseractReady = new Promise((res, rej) => {
    const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    sc.onload = () => res(window.Tesseract); sc.onerror = () => rej(new Error('Could not load the text reader — check your internet connection.'));
    document.head.appendChild(sc);
  });
  return tesseractReady;
}
async function ocr(image, progress) {
  const T = await loadTesseract();
  const worker = await T.createWorker('eng', 1, { logger: m => m.status === 'recognizing text' && progress(Math.round(m.progress * 100)) });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6' });  // read row by row so labels stay with their amounts
    const { data } = await worker.recognize(image);
    return toLines(data.text);
  } finally { await worker.terminate(); }
}
async function scanPayslipFile(file, progress) {
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    const pages = await readPdfItems(file);
    let lines = linesFromItems(pages).map(l => l.text);
    if (lines.join('').replace(/\s/g, '').length > 40) return lines;
    // no text layer (a scanned PDF): render page 1 and read it
    progress(0, 'Scanned PDF — reading the image…');
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const page = await pdf.getPage(1); const vp = page.getViewport({ scale: 2.5 });
    const canvas = document.createElement('canvas'); canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    return ocr(canvas, progress);
  }
  if (/^image\//.test(file.type) || /\.(jpe?g|png|heic|webp)$/i.test(file.name)) return ocr(file, progress);
  throw new Error('Choose a PDF or a photo of the payslip.');
}
async function scanPayslip(after) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/pdf,.pdf,image/*';
  inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    toast('Reading payslip…', 60000);
    try {
      const lines = await scanPayslipFile(file, (p, msg) => toast(msg || `Reading payslip… ${p}%`, 60000));
      const r = readPayslip(lines);
      toast('Done — check the numbers', 2500);
      if (await payslipForm(null, { ...r, file: file.name })) after();
    } catch (e) { toast(e.message || 'Could not read that file', 6000); }
  };
  inp.click();
}

async function payView() {
  view.innerHTML = '<p class="loading">Loading…</p>';
  const all = await q(sb.from('payslips').select('*').order('pay_date', { ascending: false }));
  const me = cache.settings?.display_name || 'Me', partner = cache.settings?.partner_label || 'Partner';
  const who = { me, partner };
  const mine = all.filter(p => personView === 'all' || p.person === personView);
  const fys = [...new Set([fyOf(today()), ...mine.map(p => fyOf(p.pay_date))])].sort().reverse();
  if (!payFy || !fys.includes(payFy)) payFy = fys[0];
  const rows = mine.filter(p => fyOf(p.pay_date) === payFy);
  const label = personView === 'all' ? 'Household' : personName();

  if (!all.length) {
    view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Payslips</h1><p class="hint">Wages, tax, super and leave from each payslip.</p></div></div>
      <section class="card"><h2>No payslips yet</h2>
        <p>When either of you starts work, add each payslip here (it takes about a minute). You'll then see:</p>
        <ul><li><b>Gross pay, tax and take-home</b> for the financial year, by month</li>
          <li><b>Your tax rate</b> on each pay, and whether tax is adding up</li>
          <li><b>A super check</b> — employers must pay at least 12% of ordinary earnings, every payday</li>
          <li><b>Leave balances</b> and year-to-date totals from your latest payslip</li>
          <li>A <b>download</b> for tax time</li></ul>
        <p class="hint">Tip: once pay is regular, use <b>Set up as regular income</b> so it shows in Income and the Budget.</p>
        <div class="row"><button class="primary" id="ps-scan">Scan payslip (PDF or photo)</button><button id="ps-add">Type it in</button></div></section>`;
    $('#ps-add').onclick = async () => { if (await payslipForm()) payView(); };
    $('#ps-scan').onclick = () => scanPayslip(payView);
    return;
  }

  const t = k => sum(rows, p => p[k]);
  const gross = t('gross_pay'), tax = t('tax_withheld'), net = t('net_pay'), sup = t('super_employer');
  const sgDue = sum(rows, p => (Number(p.ordinary_pay) + Number(p.leave_pay) + Number(p.salary_sacrifice)) * SG_RATE);
  const shortSlips = rows.filter(p => p.ordinary_pay > 0 && Number(p.super_employer) + 0.05 < (Number(p.ordinary_pay) + Number(p.leave_pay) + Number(p.salary_sacrifice)) * SG_RATE);
  const latest = {}; for (const p of mine) if (!latest[p.person]) latest[p.person] = p;

  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Payslips</h1><div class="who-now inline">${esc(label)}</div></div>
      <div class="row"><select id="ps-fy" style="width:auto;margin:0" aria-label="Financial year">${fys.map(f => `<option value="${f}" ${f === payFy ? 'selected' : ''}>FY ${f.slice(0, 4)}–${f.slice(5)}</option>`).join('')}</select>
        <button class="primary" id="ps-scan">Scan payslip</button><button id="ps-add">+ Type one in</button></div></div>
    <div class="tiles">
      <div class="tile"><div class="tile-label">Gross pay</div><div class="tile-value">${moneyRound(gross)}</div><div class="tile-sub">${rows.length} payslip${rows.length === 1 ? '' : 's'} this year</div></div>
      <div class="tile"><div class="tile-label">Tax withheld</div><div class="tile-value">${moneyRound(tax)}</div><div class="tile-sub">${gross ? (tax / gross * 100).toFixed(1) : 0}% of gross</div></div>
      <div class="tile good"><div class="tile-label">Take-home</div><div class="tile-value">${moneyRound(net)}</div><div class="tile-sub">${rows.length ? 'average ' + moneyRound(net / rows.length) + ' a pay' : ''}</div></div>
      <div class="tile ${shortSlips.length ? 'bad' : ''}"><div class="tile-label">Employer super ${info('Employers must pay at least 12% of ordinary pay (plus leave and salary sacrifice) as super, within 7 days of each payday. Payslips below that are flagged.')}</div><div class="tile-value">${moneyRound(sup)}</div><div class="tile-sub">${shortSlips.length ? `${shortSlips.length} payslip(s) look short` : sgDue ? `12% minimum ≈ ${moneyRound(sgDue)} ✓` : 'enter ordinary pay to check'}</div></div>
    </div>
    <div class="grid2">
      <section class="card"><div class="sec-head"><div><h2>Pay by month</h2><p class="hint">Take-home and tax withheld</p></div></div><div id="ps-chart"></div></section>
      <section class="card"><div class="sec-head"><div><h2>Latest payslip</h2><p class="hint">Leave balances and year to date</p></div></div>
        ${Object.entries(latest).map(([person, p]) => `<div class="latest"><b>${esc(who[person])}</b> · ${esc(p.employer)} · ${esc(fmtDate(p.pay_date))}
          <div class="tablewrap"><table class="list"><tbody>
            ${p.annual_leave_hours != null ? `<tr><td>Annual leave</td><td class="num">${p.annual_leave_hours} h <span class="hint">≈ ${(p.annual_leave_hours / 7.6).toFixed(1)} days</span></td></tr>` : ''}
            ${p.sick_leave_hours != null ? `<tr><td>Sick leave</td><td class="num">${p.sick_leave_hours} h</td></tr>` : ''}
            ${p.ytd_gross != null ? `<tr><td>YTD gross</td><td class="num">${money(p.ytd_gross)}</td></tr>` : ''}
            ${p.ytd_tax != null ? `<tr><td>YTD tax</td><td class="num">${money(p.ytd_tax)}</td></tr>` : ''}
            ${p.ytd_super != null ? `<tr><td>YTD super</td><td class="num">${money(p.ytd_super)}</td></tr>` : ''}
            <tr><td colspan="2"><button class="small ps-regular" data-id="${p.id}">Set up as regular income</button></td></tr>
          </tbody></table></div></div>`).join('') || '<p class="empty">—</p>'}</section>
    </div>
    <section class="card"><div class="sec-head"><div><h2>Payslips</h2></div><button class="small" id="ps-csv">Download (CSV)</button></div>
      ${rows.length ? `<div class="tablewrap"><table class="list"><thead><tr><th>Pay date</th>${personView === 'all' ? '<th>Who</th>' : ''}<th>Employer</th><th class="num">Hours</th><th class="num">Gross</th><th class="num">Tax</th><th class="num">Take-home</th><th class="num">Super</th><th></th></tr></thead><tbody>
        ${rows.map((p, i) => `<tr><td>${esc(fmtDate(p.pay_date))}</td>${personView === 'all' ? `<td>${esc(who[p.person])}</td>` : ''}<td>${esc(p.employer)}</td><td class="num">${p.hours ?? '—'}</td>
          <td class="num">${money(p.gross_pay)}</td><td class="num">${money(p.tax_withheld)}</td><td class="num"><b>${money(p.net_pay)}</b></td>
          <td class="num">${money(p.super_employer)}${shortSlips.includes(p) ? ' <span class="pill bad">short?</span>' : ''}</td>
          <td class="actions"><button class="small ps-edit" data-i="${i}">Edit</button><button class="small ghost ps-del" data-i="${i}" aria-label="Delete">✕</button></td></tr>`).join('')}</tbody>
        <tfoot><tr class="total"><td><b>Total</b></td>${personView === 'all' ? '<td></td>' : ''}<td></td><td class="num">${sum(rows, p => p.hours) || '—'}</td><td class="num"><b>${money(gross)}</b></td><td class="num">${money(tax)}</td><td class="num"><b>${money(net)}</b></td><td class="num">${money(sup)}</td><td></td></tr></tfoot></table></div>`
        : '<p class="empty">No payslips in this financial year.</p>'}</section>
    <p class="hint">Super check uses the 12% super guarantee on ordinary pay, leave and salary sacrifice. Overtime usually doesn't attract super. From 1 July 2026 employers must pay super within 7 days of each payday — check it arrived in your super fund's app.</p>`;

  const byM = new Map();
  for (const p of rows) { const m = p.pay_date.slice(0, 7); const o = byM.get(m) || { net: 0, tax: 0 }; o.net += Number(p.net_pay); o.tax += Number(p.tax_withheld); byM.set(m, o); }
  const ms = [...byM.keys()].sort();
  if (ms.length) columnChart($('#ps-chart'), { title: 'Pay by month', labels: ms.map(m => new Date(m + '-01T00:00:00').toLocaleDateString('en-AU', { month: 'short' })),
    tipLabels: ms.map(m => new Date(m + '-01T00:00:00').toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })),
    series: [{ name: 'Take-home', color: SERIES.blue, values: ms.map(m => byM.get(m).net) }, { name: 'Tax withheld', color: SERIES.orange, values: ms.map(m => byM.get(m).tax) }], height: 200 });
  else $('#ps-chart').innerHTML = '<p class="empty">No payslips this year.</p>';

  $('#ps-fy').onchange = e => { payFy = e.target.value; payView(); };
  $('#ps-add').onclick = async () => { if (await payslipForm()) payView(); };
  $('#ps-scan').onclick = () => scanPayslip(payView);
  view.querySelectorAll('.ps-edit').forEach(b => b.onclick = async () => { if (await payslipForm(rows[b.dataset.i])) payView(); });
  view.querySelectorAll('.ps-del').forEach(b => b.onclick = () => {
    const tr = b.closest('tr'), p = rows[b.dataset.i];
    softDelete({ label: `Deleted payslip ${fmtDate(p.pay_date)}`, hide: () => tr.classList.add('hidden'), restore: () => tr.classList.remove('hidden'),
      commit: async () => { await q(sb.from('payslips').delete().eq('id', p.id)); payView(); } });
  });
  view.querySelectorAll('.ps-regular').forEach(b => b.onclick = async () => {
    const p = all.find(x => x.id === b.dataset.id);
    const days = p.period_start && p.period_end ? dayDiff(p.period_start, p.period_end) : 14;
    const freq = days <= 8 ? 'weekly' : days <= 16 ? 'fortnightly' : 'monthly';
    const next = new Date(p.pay_date + 'T00:00:00'); next.setDate(next.getDate() + (freq === 'weekly' ? 7 : freq === 'fortnightly' ? 14 : 0)); if (freq === 'monthly') next.setMonth(next.getMonth() + 1);
    const work = cache.categories.find(c => c.name === 'Work income');
    if (!confirm(`Add "${p.employer} wages" as regular income: ${money(p.net_pay)} ${freq}, all ${who[p.person]}'s?`)) return;
    await q(sb.from('recurring_items').insert({ name: `${p.employer} wages (${who[p.person]})`, direction: 'in', amount: p.net_pay, frequency: freq,
      next_due: next.toLocaleDateString('en-CA'), category_id: work?.id || null, match_text: p.employer.toUpperCase().slice(0, 20), my_share_pct: p.person === 'me' ? 100 : 0,
      notes: 'Set up from a payslip — take-home pay. Update the amount if it changes.' }));
    toast('Added to Income'); 
  });
  $('#ps-csv').onclick = () => {
    const head = ['Pay date', 'Who', 'Employer', 'Period from', 'Period to', 'Hours', 'Ordinary', 'Overtime', 'Allowances', 'Bonus', 'Leave pay', 'Gross', 'Tax withheld', 'Salary sacrifice', 'Other deductions', 'Net pay', 'Employer super', 'YTD gross', 'YTD tax', 'YTD super'];
    const lines = [head, ...rows.map(p => [p.pay_date, who[p.person], p.employer, p.period_start, p.period_end, p.hours, p.ordinary_pay, p.overtime_pay, p.allowances, p.bonus, p.leave_pay, p.gross_pay, p.tax_withheld, p.salary_sacrifice, p.other_deductions, p.net_pay, p.super_employer, p.ytd_gross, p.ytd_tax, p.ytd_super])];
    const csv = lines.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `payslips-${payFy}-${label.toLowerCase().replace(/\W+/g, '-')}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
}

// ---------- SHARED ----------
async function shared() {
  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Shared costs</h1><p class="hint">Who paid what, and who owes whom.</p></div></div><div class="grid" id="s-bal"></div><div class="card" id="s-list"></div>`;
  const partner = cache.settings?.partner_label || 'Ex-partner';
  const bal = async () => {
    const s = await q(sb.from('v_shared_balance').select('*').maybeSingle());
    const b = Number(s?.balance || 0);
    $('#s-bal').innerHTML = `<div class="stat ${b === 0 ? 'good' : 'warn'}"><div class="label">Balance</div><div class="value">${money(Math.abs(b))}</div>
      <div class="sub">${b > 0 ? `${esc(partner)} owes you` : b < 0 ? `You owe ${esc(partner)}` : 'All square'}</div></div>
      <div class="stat"><div class="label">How it works</div><div class="sub">Add shared bills either of you paid. When money changes hands to square up, add it as a <b>settlement</b>. Tick "Shared" on a transaction to add it here automatically.</div></div>`;
  };
  await Promise.all([bal(), renderCrud($('#s-list'), 'shared_ledger', { onChange: async () => { await bal(); await shared(); } })]);
}

// ---------- SETUP ----------
async function setup() {
  const s = cache.settings || {};
  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Setup</h1><p class="hint">Settings, bank accounts, categories and sorting rules.</p></div></div><div class="card"><h2>Settings</h2><form id="set"><div class="formgrid">
      <label>Your name <input name="display_name" value="${esc(s.display_name)}"></label>
      <label>What to call your ex-partner <input name="partner_label" value="${esc(s.partner_label || 'Ex-partner')}"></label>
      <label>Your usual share of shared costs % <input type="number" step="1" min="0" max="100" name="default_my_share_pct" value="${esc(s.default_my_share_pct ?? 50)}"></label>
      <label>How often you're paid <select name="pay_frequency">${FREQ.filter(f => f !== 'once').map(f => `<option ${f === (s.pay_frequency || 'fortnightly') ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
      <label>Next pay date <input type="date" name="next_pay_date" value="${esc(s.next_pay_date)}"></label>
      <label>Safety buffer goal <input type="number" step="1" name="buffer_target" value="${esc(s.buffer_target ?? 1000)}"></label>
    </div><button class="primary">Save settings</button></form></div>
    <div class="card" id="u-acc"></div><div class="card" id="u-cat"></div><div class="card" id="u-rule"></div>`;
  $('#set').onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    await q(sb.from('settings').update({ display_name: f.display_name.value || null, partner_label: f.partner_label.value || 'Ex-partner',
      default_my_share_pct: Number(f.default_my_share_pct.value), pay_frequency: f.pay_frequency.value, next_pay_date: f.next_pay_date.value || null,
      buffer_target: Number(f.buffer_target.value) }).eq('owner_id', session.user.id));
    await loadLookups(); toast('Settings saved');
  };
  await Promise.all([renderCrud($('#u-acc'), 'accounts'), renderCrud($('#u-cat'), 'categories'),
    renderCrud($('#u-rule'), 'category_rules', { onChange: async () => { const n = await q(sb.rpc('recategorise_uncategorised')); toast(`Rules re-run — ${n} transaction(s) updated`); await renderCrud($('#u-rule'), 'category_rules'); } })]);
}

// ---------- navigation & auth ----------
const VIEWS = { dashboard, budget, bills, income, debts, transactions, sort: sortView, import: importView, shared, pay: payView, tax: taxView, setup };
async function updateSortBadge() {
  const { count } = await sb.from('transactions').select('id', { count: 'exact', head: true }).is('category_id', null);
  for (const id of ['#sort-badge', '#sort-badge-m']) { const b = $(id); if (b) { b.textContent = count || ''; b.classList.toggle('hidden', !count); } }
}
let currentView = 'dashboard';
async function show(name, opts) {
  currentView = name; renderWhoSwitch();
  document.querySelectorAll('#tabs button, #bottomnav button[data-view], #more-sheet button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $('#more-btn')?.classList.toggle('active', !['dashboard', 'budget', 'bills', 'sort'].includes(name));
  closeSheets();
  history.replaceState(null, '', '#' + name);
  window.scrollTo(0, 0);
  view.innerHTML = skeleton(name === 'transactions' || name === 'sort' ? 0 : 4);
  try { await VIEWS[name](opts); updateSortBadge(); }
  catch (e) { view.innerHTML = `<div class="card"><h2>That page didn’t load</h2><p class="msg error">${esc(friendlyError(e))}</p><button class="primary" onclick="location.reload()">Try again</button></div>`; }
}
document.querySelectorAll('#tabs button, #bottomnav button[data-view], #more-sheet button').forEach(b => b.onclick = () => show(b.dataset.view));
function closeSheets() { $('#more-sheet')?.classList.add('hidden'); $('#more-btn')?.setAttribute('aria-expanded', 'false'); $('#settings-pop')?.classList.add('hidden'); $('#settings-btn')?.setAttribute('aria-expanded', 'false'); }

// ---------- interface wiring ----------
applyPrefs(); wireInfoTips(); watchOnline(); wireInstall();
const rerender = () => { if (session) show(currentView); };
$('#settings-btn').onclick = e => { e.stopPropagation(); const pop = $('#settings-pop'); const open = pop.classList.contains('hidden');
  closeSheets(); if (open) { settingsMenu(rerender); pop.classList.remove('hidden'); $('#settings-btn').setAttribute('aria-expanded', 'true'); } };
$('#privacy-btn').onclick = () => setPref('privacy', !prefs.privacy);
$('#more-btn').onclick = e => { e.stopPropagation(); const sh = $('#more-sheet'); const open = sh.classList.contains('hidden'); closeSheets(); if (open) { sh.classList.remove('hidden'); $('#more-btn').setAttribute('aria-expanded', 'true'); } };
document.addEventListener('click', e => { if (!e.target.closest('#settings-pop, #settings-btn, #more-sheet, #more-btn')) closeSheets(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (prefs.theme === 'auto') { applyPrefs(); rerender(); } });

// search: transactions, bills/income, debts, payslips, categories
let searchT;
function openSearch() { $('#search').classList.remove('hidden'); $('#search-input').value = ''; $('#search-results').innerHTML = '<p class="hint">Type at least 2 letters.</p>'; $('#search-input').focus(); }
function closeSearch() { $('#search').classList.add('hidden'); }
$('#search-btn').onclick = openSearch;
$('#search').addEventListener('click', e => { if (e.target.id === 'search') closeSearch(); });
document.addEventListener('keydown', e => {
  if (!session) return;
  if (e.key === 'Escape') { closeSearch(); closeSheets(); }
  if ((e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); openSearch(); }
});
$('#search-input').oninput = e => { clearTimeout(searchT); searchT = setTimeout(() => runSearch(e.target.value.trim()), 250); };
async function runSearch(term) {
  const box = $('#search-results');
  if (term.length < 2) { box.innerHTML = '<p class="hint">Type at least 2 letters.</p>'; return; }
  const like = `%${term.replace(/[%_,()]/g, '')}%`;
  const [tx, ri, de, ps] = await Promise.all([
    q(sb.from('transactions').select('id, txn_date, description, amount').ilike('description', like).order('txn_date', { ascending: false }).limit(8)),
    q(sb.from('recurring_items').select('id, name, direction, amount, frequency').ilike('name', like).limit(5)),
    q(sb.from('debts').select('id, creditor, current_balance').ilike('creditor', like).limit(5)),
    q(sb.from('payslips').select('id, employer, pay_date, net_pay').ilike('employer', like).limit(5)),
  ]);
  const cats = cache.categories.filter(c => c.name.toLowerCase().includes(term.toLowerCase())).slice(0, 5);
  const grp = (title, items) => items.length ? `<h3>${title}</h3>${items.join('')}` : '';
  const item = (go, main, sub, amt) => `<button class="sr" data-go="${go}"><span><b>${main}</b><span class="hint">${sub}</span></span>${amt ? `<span class="num">${amt}</span>` : ''}</button>`;
  box.innerHTML = (grp('Transactions', tx.map(t => item('tx:' + term, esc(t.description), esc(fmtDate(t.txn_date)), money(t.amount)))) +
    grp('Bills & income', ri.map(r => item(r.direction === 'in' ? 'income' : 'bills', esc(r.name), r.direction === 'in' ? 'income' : 'bill', `${money(r.amount)} / ${FREQ_WORD[r.frequency]}`))) +
    grp('Debts', de.map(d => item('debts', esc(d.creditor), 'debt', money(d.current_balance)))) +
    grp('Payslips', ps.map(p => item('pay', esc(p.employer), esc(fmtDate(p.pay_date)), money(p.net_pay)))) +
    grp('Categories', cats.map(c => item('cat:' + c.id, esc(c.name), 'show transactions in this category', '')))) || '<p class="empty">No matches.</p>';
  if (tx.length === 8) box.insertAdjacentHTML('afterbegin', `<button class="sr" data-go="tx:${esc(term)}"><span><b>See all transactions matching "${esc(term)}"</b></span></button>`);
  box.querySelectorAll('[data-go]').forEach(b => b.onclick = () => {
    const g = b.dataset.go; closeSearch();
    if (g.startsWith('tx:')) show('transactions', { search: g.slice(3) });
    else if (g.startsWith('cat:')) show('transactions', { category: g.slice(4) });
    else show(g);
  });
}

let session = null;
async function enter(s) {
  session = s;
  $('#auth').classList.add('hidden'); $('#tabs').classList.remove('hidden'); $('#signout').classList.remove('hidden');
  await q(sb.rpc('seed_defaults'));   // safe every time: only adds what's missing
  await loadLookups();
  $('#whoswitch').classList.remove('hidden'); renderWhoSwitch();
  $('#tools').classList.remove('hidden'); $('#bottomnav').classList.remove('hidden');
  const start = location.hash.slice(1);
  show(VIEWS[start] ? start : 'dashboard');
}
function leave() {
  session = null; view.innerHTML = '';
  $('#auth').classList.remove('hidden'); $('#tabs').classList.add('hidden'); $('#signout').classList.add('hidden'); $('#whoswitch')?.classList.add('hidden');
  $('#tools').classList.add('hidden'); $('#bottomnav').classList.add('hidden');
}
$('#authform').onsubmit = async e => {
  e.preventDefault(); const msg = $('#authmsg'); msg.className = 'msg'; msg.textContent = 'Signing in…';
  const { data, error } = await sb.auth.signInWithPassword({ email: $('#email').value, password: $('#password').value });
  if (error) { msg.className = 'msg error'; msg.textContent = error.message; return; }
  msg.textContent = ''; enter(data.session);
};
$('#signup').onclick = async () => {
  const msg = $('#authmsg'); const email = $('#email').value, password = $('#password').value;
  if (!email || password.length < 8) { msg.className = 'msg error'; msg.textContent = 'Enter your email and a password of at least 8 characters, then press Create account.'; return; }
  const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
  if (error) { msg.className = 'msg error'; msg.textContent = error.message; return; }
  if (data.session) enter(data.session);
  else { msg.className = 'msg'; msg.textContent = 'Account created. Check your email and click the confirmation link, then sign in here.'; }
};
$('#signout').onclick = async () => { await sb.auth.signOut(); leave(); };
$('#signout-m').onclick = async () => { closeSheets(); await sb.auth.signOut(); leave(); };

const { data: { session: existing } } = await sb.auth.getSession();
if (existing) enter(existing);
sb.auth.onAuthStateChange((evt, s) => { if (evt === 'SIGNED_OUT') leave(); else if (evt === 'SIGNED_IN' && !session && s) enter(s); });
