import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js?v=202611222359';
import { parseBankCsv, parseWestpacActivity, splitAccounts } from './csv.js?v=202611222359';
import { columnChart, hbarChart, SERIES, moneyRound, moneyCompact } from './charts.js?v=202611222359';

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
function toast(msg, ms = 3000) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
async function q(promise) {
  const { data, error } = await promise;
  if (error) { console.error(error); toast('Problem: ' + error.message, 6000); throw error; }
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

// Two views of the same bills/income table, with friendlier columns
const FREQ_WORD = { once: 'once', weekly: 'week', fortnightly: 'fortnight', monthly: 'month', quarterly: 'quarter', yearly: 'year' };
TABLES.bills = { ...TABLES.recurring_items, table: 'recurring_items', title: 'Your bills', order: ['next_due'], addTitle: 'bill',
  columns: ['name', 'amount_freq', 'per_month', 'next', 'share'],
  footer: rows => {
    const act = rows.filter(r => r.is_active && !r.debt_id);
    return { per_month: `<b>${money(sum(act, r => r.amount * PER_MONTH[r.frequency]))}</b><br><span class="hint">your share ${money(sum(act, r => r.amount * PER_MONTH[r.frequency] * r.my_share_pct / 100))}</span>`,
             name: `<b>Total per month</b><br><span class="hint">loan repayments are counted under Debts</span>` };
  } };
TABLES.income = { ...TABLES.recurring_items, table: 'recurring_items', title: 'Your income', order: ['next_due'], addTitle: 'income',
  fields: TABLES.recurring_items.fields.filter(f => f.k !== 'debt_id').map(f => f.k === 'match_text' ? { ...f, hint: 'When an imported deposit contains this, it is marked received and the date moves on' } : f),
  columns: ['name', 'amount_freq', 'per_month', 'next', 'share'],
  footer: rows => {
    const act = rows.filter(r => r.is_active);
    return { per_month: `<b>${money(sum(act, r => r.amount * PER_MONTH[r.frequency]))}</b><br><span class="hint">yours ${money(sum(act, r => r.amount * PER_MONTH[r.frequency] * r.my_share_pct / 100))}</span>`,
             name: `<b>Total per month</b>` };
  } };
TABLES.debts.columns = ['creditor', 'current_balance', 'arrears_amount', 'monthly', 'hardship_status', 'share'];
TABLES.debts.headers = { creditor: 'Owed to', current_balance: 'Balance', arrears_amount: 'Overdue', hardship_status: 'Hardship' };
TABLES.debts.footer = rows => {
  const act = rows.filter(r => r.status === 'active');
  return { creditor: '<b>Total</b> <span class="hint">(active)</span>', current_balance: `<b>${money(sum(act, r => r.current_balance))}</b>`,
    arrears_amount: money(sum(act, r => r.arrears_amount)), monthly: `<b>${money(sum(act, r => r.min_payment * PER_MONTH[r.payment_frequency || 'monthly']))}</b>` };
};
const VIRTUAL = {
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
        if (row) await q(sb.from(table).update(out).eq('id', row.id));
        else await q(sb.from(table).insert(out));
        toast('Saved'); dlg.close(); dlg.remove(); resolve(true);
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

async function renderCrud(container, key, { filter = {}, title, onChange, extra, subtitle } = {}) {
  const def = TABLES[key];
  let query = sb.from(def.table || key).select('*');
  for (const [k, v] of Object.entries(filter)) query = query.eq(k, v);
  for (const o of def.order) query = query.order(o, { ascending: !def.desc });
  const rows = await q(query);
  const isNum = k => VIRTUAL[k]?.num || /amount|balance|payment|budget/.test(k);
  container.innerHTML = `<div class="sec-head"><div><h2>${esc(title || def.title)}</h2>${subtitle ? `<p class="hint">${subtitle}</p>` : ''}</div>
      <button class="primary add">+ Add</button></div>
    ${rows.length ? `<div class="tablewrap"><table class="list"><thead><tr>${def.columns.map(k => `<th class="${isNum(k) ? 'num' : ''}">${esc(def.headers?.[k] || VIRTUAL[k]?.label || def.fields.find(f => f.k === k)?.label || label(k))}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr class="${r.is_active === false ? 'muted' : ''}">${def.columns.map(k => `<td class="${isNum(k) ? 'num' : ''}">${cell(def, r, k)}</td>`).join('')}
        <td class="actions">${extra ? extra(r, i) : ''}<button class="small edit" data-i="${i}">Edit</button><button class="small ghost del" data-i="${i}" title="Delete" aria-label="Delete">✕</button></td></tr>`).join('')}</tbody>
      ${footerHtml(def, rows)}</table></div>`
      : `<p class="empty">Nothing here yet.</p>`}`;
  const changed = async () => { await loadLookups(); onChange ? await onChange() : await renderCrud(container, key, { filter, title, onChange, extra }); };
  $('.add', container).onclick = async () => { if (await openForm(key, null, filter)) await changed(); };
  container.querySelectorAll('.edit').forEach(b => b.onclick = async () => { if (await openForm(key, rows[b.dataset.i], filter)) await changed(); });
  container.querySelectorAll('.del').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this entry? This cannot be undone.')) return;
    await q(sb.from(def.table || key).delete().eq('id', rows[b.dataset.i].id)); toast('Deleted'); await changed();
  });
  return rows;
}

async function markPaid(itemId, due, after) {
  if (!confirm(`Mark this as paid? The due date (${fmtDate(due)}) moves on to the next one.`)) return;
  const next = await q(sb.rpc('mark_item_paid', { p_item_id: itemId }));
  // clear any alert about this due date
  await sb.from('alerts').update({ dismissed: true }).like('source_key', `%${itemId}:${due}`);
  toast(next ? `Marked paid — next due ${fmtDate(next)}` : 'Marked paid'); await after();
}

// ---------- DASHBOARD ----------
let spendPeriod = 'this';
async function dashboard() {
  view.innerHTML = '<p class="loading">Loading…</p>';
  const rank = { urgent: 0, warning: 1, info: 2 };
  const monthStart = today().slice(0, 8) + '01';
  const [alertsRaw, bal, cash, debt, shared, upcoming, followups, catSpend, uncat, lastTxn, debtRows] = await Promise.all([
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
    q(sb.from('debts').select('current_balance').eq('status', 'active')),
  ]);
  const alerts = alertsRaw.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const uncatCount = uncat.count || 0;
  const name = cache.settings?.display_name;
  const isLoan = a => ['loan', 'mortgage', 'credit_card'].includes(a.account_type);
  const cashAccts = bal.filter(a => !isLoan(a));
  const myCash = sum(cashAccts, a => Number(a.calculated_balance) * (a.is_joint ? Number(a.my_share_pct ?? 100) / 100 : 1));
  const thisMonth = cash.find(c => c.month === monthStart) || {};
  const dueOut = upcoming.filter(u => u.direction === 'out');
  const dueTotal = sum(dueOut, u => u.my_amount);
  const overdue = dueOut.filter(u => u.overdue);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const s = Number(shared?.balance || 0), partner = cache.settings?.partner_label || 'Ex-partner';

  view.innerHTML = `
    <div class="page-head"><div><h1 class="page-title">${greet}${name ? ', ' + esc(name) : ''}</h1>
      <p class="hint">${lastTxn[0] ? `Bank data up to ${esc(fmtDate(lastTxn[0].txn_date))} · <button class="link" data-go="import">import newer statements</button>` : 'No statements imported yet — <button class="link" data-go="import">import your first</button>'}</p></div></div>

    ${alerts.length ? `<div class="alerts">${alerts.slice(0, 4).map((a, i) => `<div class="alert ${a.severity}">
        <span class="alert-icon" aria-hidden="true">${a.severity === 'urgent' ? '!' : a.severity === 'warning' ? '•' : 'i'}</span>
        <div><b>${esc(a.title)}</b><div class="hint">${esc(a.body)}</div></div>
        <button class="small ghost dismiss" data-i="${i}" title="Dismiss" aria-label="Dismiss">✕</button></div>`).join('')}
      ${alerts.length > 4 ? `<p class="hint">+ ${alerts.length - 4} more alert(s)</p>` : ''}</div>` : ''}

    <div class="tiles">
      <div class="tile"><div class="tile-label">Money in your accounts</div><div class="tile-value">${moneyRound(myCash)}</div>
        <div class="tile-sub">your share, ${cashAccts.length} account${cashAccts.length === 1 ? '' : 's'}</div></div>
      <div class="tile ${Number(thisMonth.net) < 0 ? 'bad' : 'good'}"><div class="tile-label">This month so far</div><div class="tile-value">${Number(thisMonth.net) >= 0 ? '+' : ''}${moneyRound(thisMonth.net || 0)}</div>
        <div class="tile-sub">in ${moneyRound(thisMonth.money_in || 0)} · out ${moneyRound(thisMonth.money_out || 0)}</div></div>
      <div class="tile ${overdue.length ? 'bad' : dueOut.length ? 'warn' : ''}"><div class="tile-label">Bills due in 14 days</div><div class="tile-value">${moneyRound(dueTotal)}</div>
        <div class="tile-sub">${dueOut.length} bill${dueOut.length === 1 ? '' : 's'}, your share${overdue.length ? ` · <b>${overdue.length} overdue</b>` : ''}</div></div>
      <div class="tile"><div class="tile-label">Total debt</div><div class="tile-value">${moneyCompact(sum(debtRows, x => x.current_balance))}</div>
        <div class="tile-sub">your share ${moneyRound(debt?.my_total_owed || 0)}${Number(debt?.my_total_arrears) ? ` · overdue ${moneyRound(debt.my_total_arrears)}` : ''}</div></div>
    </div>

    ${uncatCount || debt?.hardship_to_request || followups.length || s ? `<div class="chips">
      ${uncatCount ? `<button class="chip" data-go="sort"><b>${uncatCount}</b> transactions to sort →</button>` : ''}
      ${debt?.hardship_to_request ? `<button class="chip warn" data-go="debts"><b>${debt.hardship_to_request}</b> hardship request${debt.hardship_to_request > 1 ? 's' : ''} to make →</button>` : ''}
      ${followups.length ? `<button class="chip warn" data-go="debts"><b>${followups.length}</b> creditor follow-up${followups.length > 1 ? 's' : ''} due →</button>` : ''}
      ${s ? `<button class="chip" data-go="shared">${s > 0 ? `${esc(partner)} owes you <b>${moneyRound(s)}</b>` : `You owe ${esc(partner)} <b>${moneyRound(-s)}</b>`} →</button>` : ''}
    </div>` : ''}

    <div class="grid2">
      <section class="card"><div class="sec-head"><div><h2>Coming up</h2><p class="hint">Next 14 days · your share</p></div><button class="small" data-go="bills">All bills</button></div>
        ${upcoming.length ? `<ul class="due-list">${upcoming.map(u => {
          const d = daysFromToday(u.due_date);
          const when = u.overdue ? (u.direction === 'in' ? 'late' : 'overdue') : d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
          return `<li class="${u.overdue ? 'is-late' : ''}"><div class="due-date"><b>${new Date(u.due_date + 'T00:00:00').getDate()}</b><span>${new Date(u.due_date + 'T00:00:00').toLocaleDateString('en-AU', { month: 'short' })}</span></div>
            <div class="due-main"><b>${esc(u.name)}</b><div class="hint">${when}${u.debt_id ? ' · loan repayment' : ''}${u.is_shared ? ' · shared' : ''}</div></div>
            <div class="due-amt ${u.direction === 'in' ? 'in' : ''}">${u.direction === 'in' ? '+' : '−'}${money(u.my_amount)}</div>
            ${u.direction === 'out' && d <= 7 ? `<button class="small mark-paid" data-id="${u.item_id}" data-due="${u.due_date}">Paid</button>` : '<span></span>'}</li>`; }).join('')}</ul>`
          : '<p class="empty">Nothing due in the next 14 days.</p>'}
      </section>
      <section class="card"><div class="sec-head"><div><h2>Where the money went</h2><p class="hint">Household spending by category</p></div>
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
    for (const c of catSpend.filter(c => pick.includes(c.month))) totals.set(c.category, (totals.get(c.category) || 0) + Number(c.spent) / div);
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
  view.querySelectorAll('[data-go]').forEach(b => b.onclick = () => show(b.dataset.go));
  view.querySelectorAll('.mark-paid').forEach(b => b.onclick = () => markPaid(b.dataset.id, b.dataset.due, dashboard));
  view.querySelectorAll('.dismiss').forEach(b => b.onclick = async () => {
    await q(sb.from('alerts').update({ dismissed: true }).eq('id', alerts[b.dataset.i].id));
    b.closest('.alert').remove();
  });
}

// ---------- BUDGET (Overall / me / partner) ----------
let budgetWho = 'overall';
async function budget() {
  view.innerHTML = '<p class="loading">Loading…</p>';
  const months = 6;
  const r = await q(sb.rpc('budget_summary', { p_months: months }));
  const me = cache.settings?.display_name || 'Me';
  const names = { overall: 'Household', me, partner: r.partner };
  const draw = () => {
    const p = r.people[budgetWho];
    const costs = p.regular_out + p.debt_monthly;
    const gap = p.regular_in - costs;
    const actualGap = p.actual_in - p.actual_out;
    const freq = f => FREQ_WORD[f] || f;
    const list = (rows, cols) => rows.length ? `<div class="tablewrap"><table class="list"><tbody>${rows.map(r => `<tr>${cols.map((c, i) => `<td class="${i ? 'num' : ''}">${c(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="empty">None.</p>';
    view.innerHTML = `
      <div class="page-head"><div><h1 class="page-title">Budget</h1><p class="hint">Regular income and costs per month, split by who pays</p></div>
        <div class="seg big" role="tablist">${Object.entries(names).map(([k, v]) => `<button class="${k === budgetWho ? 'on' : ''}" data-who="${k}" role="tab" aria-selected="${k === budgetWho}">${esc(v)}</button>`).join('')}</div></div>

      <div class="tiles">
        <div class="tile"><div class="tile-label">Regular income</div><div class="tile-value">${moneyRound(p.regular_in)}</div><div class="tile-sub">per month</div></div>
        <div class="tile"><div class="tile-label">Regular costs</div><div class="tile-value">${moneyRound(costs)}</div><div class="tile-sub">bills ${moneyRound(p.regular_out)} · debts ${moneyRound(p.debt_monthly)}</div></div>
        <div class="tile ${gap < 0 ? 'bad' : 'good'}"><div class="tile-label">Left over each month</div><div class="tile-value">${gap >= 0 ? '+' : ''}${moneyRound(gap)}</div><div class="tile-sub">${gap < 0 ? 'short before everyday spending' : 'before everyday spending'}</div></div>
        <div class="tile ${actualGap < 0 ? 'bad' : 'good'}"><div class="tile-label">What actually happened</div><div class="tile-value">${actualGap >= 0 ? '+' : ''}${moneyRound(actualGap)}</div><div class="tile-sub">average per month, last ${months} months</div></div>
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
    view.querySelectorAll('[data-who]').forEach(b => b.onclick = () => { budgetWho = b.dataset.who; draw(); });
  };
  draw();
}

// ---------- TRANSACTIONS ----------
async function transactions(opts = {}) {
  const thisMonth = today().slice(0, 7);
  const state = { months: new Set(opts.uncategorised ? [] : [thisMonth]), account: '', category: '', uncategorised: !!opts.uncategorised, search: '' };
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
      <label>Category <select id="f-cat"><option value="">All categories</option>${cache.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <label>Search <input type="search" id="f-search" placeholder="e.g. woolworths"></label>
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
      <div class="tablewrap"><table><thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th><th>Category</th><th class="hide-sm">Shared</th><th class="hide-sm" title="A one-off: categorised by hand, no rule">One-off</th><th></th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td>${esc(fmtDate(r.txn_date))}<br><span class="hint hide-sm">${esc(refName('accounts', r.account_id))}</span></td><td>${esc(r.description)}</td>
        <td class="num ${r.amount > 0 ? 'in' : ''}">${money(r.amount)}</td>
        <td><select data-i="${i}" class="cat" aria-label="Category">${catOpts(r.category_id)}</select>${r.category_source === 'rule' ? '<br><span class="hint">by rule</span>' : ''}</td>
        <td class="hide-sm"><input type="checkbox" class="shr" data-i="${i}" ${r.is_shared ? 'checked' : ''} aria-label="Shared"></td>
        <td class="hide-sm"><input type="checkbox" class="one" data-i="${i}" ${r.is_one_off ? 'checked' : ''} aria-label="One-off"></td>
        <td><button class="small mkrule" data-i="${i}" title="Always categorise transactions like this">Make rule</button></td></tr>`).join('')}
      </tbody>${totalsRow}</table></div>` : '<p class="empty">No transactions match.</p>';
    box.querySelectorAll('.cat').forEach(sel => wireCatSelect(sel, async (id) => {
      const r = rows[sel.dataset.i];
      await q(sb.from('transactions').update({ category_id: id, category_source: id ? 'manual' : 'none' }).eq('id', r.id));
      r.category_id = id; toast('Category saved (this transaction only)');
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
  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Import</h1><p class="hint">Add bank statements: CommBank or Westpac CSV, or the Westpac Account activity PDF.</p></div></div><div class="card"><h2>Choose files</h2>
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
  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">${isBills ? 'Bills' : 'Income'}</h1>
      <p class="hint">${isBills ? 'Regular payments, including loan repayments. Matched automatically when you import statements.' : 'Regular money coming in. Matched automatically when you import statements.'}</p></div></div>
    <div class="tiles" id="r-tiles"></div>
    <section class="card"><div class="sec-head"><div><h2>${isBills ? 'Due' : 'Expected'} in the next 5 weeks</h2><p class="hint">your share</p></div></div><div id="r-up"></div></section>
    <section class="card" id="r-list"></section>`;
  const drawTop = async () => {
    const [items, up] = await Promise.all([
      q(sb.from('recurring_items').select('*').eq('direction', dir).eq('is_active', true)),
      q(sb.rpc('upcoming_items', { p_days: 35 })),
    ]);
    const counted = items.filter(i => !(isBills && i.debt_id));
    const pm = sum(counted, i => i.amount * PER_MONTH[i.frequency]);
    const pmMe = sum(counted, i => i.amount * PER_MONTH[i.frequency] * i.my_share_pct / 100);
    const repay = sum(items.filter(i => i.debt_id), i => i.amount * PER_MONTH[i.frequency] * i.my_share_pct / 100);
    const mine = up.filter(u => u.direction === dir);
    const late = mine.filter(u => u.overdue);
    $('#r-tiles').innerHTML = `
      <div class="tile"><div class="tile-label">${isBills ? 'Bills' : 'Income'} per month</div><div class="tile-value">${moneyRound(pm)}</div><div class="tile-sub">household${isBills ? ', not counting loan repayments' : ''}</div></div>
      <div class="tile"><div class="tile-label">Your share</div><div class="tile-value">${moneyRound(pmMe)}</div><div class="tile-sub">per month${isBills && repay ? ` · plus ${moneyRound(repay)} loan repayments` : ''}</div></div>
      <div class="tile ${late.length ? 'bad' : ''}"><div class="tile-label">${isBills ? 'Overdue' : 'Late'}</div><div class="tile-value">${late.length}</div><div class="tile-sub">${late.length ? moneyRound(sum(late, u => u.my_amount)) + ' your share' : 'all up to date'}</div></div>`;
    $('#r-up').innerHTML = mine.length ? `<ul class="due-list">${mine.map(u => {
      const d = daysFromToday(u.due_date);
      const when = u.overdue ? (isBills ? 'overdue' : 'late') : d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
      return `<li class="${u.overdue ? 'is-late' : ''}"><div class="due-date"><b>${new Date(u.due_date + 'T00:00:00').getDate()}</b><span>${new Date(u.due_date + 'T00:00:00').toLocaleDateString('en-AU', { month: 'short' })}</span></div>
        <div class="due-main"><b>${esc(u.name)}</b><div class="hint">${when}${u.debt_id ? ' · loan repayment' : ''}</div></div>
        <div class="due-amt ${isBills ? '' : 'in'}">${money(u.my_amount)}</div>
        ${isBills && d <= 7 ? `<button class="small mark-paid" data-id="${u.item_id}" data-due="${u.due_date}">Paid</button>` : '<span></span>'}</li>`; }).join('')}</ul>
      <p class="hint total-line">Total ${money(sum(mine, u => u.my_amount))}</p>` : '<p class="empty">Nothing in the next 5 weeks.</p>';
    $('#r-up').querySelectorAll('.mark-paid').forEach(b => b.onclick = () => markPaid(b.dataset.id, b.dataset.due, () => recurringPage(kind)));
  };
  let rows = [];
  const drawList = async () => {
    rows = await renderCrud($('#r-list'), kind, {
      filter: { direction: dir }, title: isBills ? 'All bills' : 'All income',
      onChange: async () => { await drawTop(); await drawList(); },
      extra: (r, i) => isBills && r.is_active ? `<button class="small b-paid" data-i="${i}">Paid</button>` : '',
    });
    $('#r-list').querySelectorAll('.b-paid').forEach(b => b.onclick = () => { const r = rows[b.dataset.i]; markPaid(r.id, r.next_due, () => recurringPage(kind)); });
  };
  await Promise.all([drawTop(), drawList()]);
}
const bills = () => recurringPage('bills');
const income = () => recurringPage('income');

// ---------- DEBTS ----------
async function debts() {
  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Debts</h1><p class="hint">Everything owed, with a log of every call to creditors. Home loan balances update when you import.</p></div></div>
    <div class="tiles" id="d-sum"></div>
    <section class="card"><div class="sec-head"><div><h2>Who you owe</h2><p class="hint">Household balances · the long bars are the home loans</p></div></div><div id="d-chart"></div></section>
    <section class="card" id="d-list"></section><section class="card hidden" id="d-log"></section>`;
  const top = async () => {
    const [d, all] = await Promise.all([q(sb.from('v_debt_summary').select('*').maybeSingle()), q(sb.from('debts').select('*').eq('status', 'active').order('current_balance', { ascending: false }))]);
    const sd = d || {};
    $('#d-sum').innerHTML = `
      <div class="tile"><div class="tile-label">Total owed</div><div class="tile-value">${moneyRound(sum(all, x => x.current_balance))}</div><div class="tile-sub">household · your share ${moneyRound(sd.my_total_owed || 0)}</div></div>
      <div class="tile"><div class="tile-label">Repayments per month</div><div class="tile-value">${moneyRound(sum(all, x => (x.min_payment || 0) * PER_MONTH[x.payment_frequency || 'monthly']))}</div><div class="tile-sub">your share ${moneyRound(sd.my_monthly_minimums || 0)}</div></div>
      <div class="tile ${Number(sd.my_total_arrears) > 0 ? 'bad' : ''}"><div class="tile-label">Overdue</div><div class="tile-value">${moneyRound(sum(all, x => x.arrears_amount))}</div><div class="tile-sub">entered as arrears</div></div>
      <div class="tile ${sd.on_hardship ? 'good' : ''}"><div class="tile-label">On hardship</div><div class="tile-value">${sd.on_hardship || 0} <small>of ${sd.active_debts || 0}</small></div><div class="tile-sub">${sd.hardship_to_request ? sd.hardship_to_request + ' to request' : 'National Debt Helpline 1800 007 007'}</div></div>`;
    hbarChart($('#d-chart'), { items: all.map(x => ({ label: x.creditor, value: Number(x.current_balance),
      note: x.current_balance > 0 ? null : 'balance not entered — click Edit below', badge: x.arrears_amount > 0 ? 'overdue' : null, badgeClass: 'bad' })), color: SERIES.orange });
  };
  const showLog = async (debt) => {
    const box = $('#d-log'); box.classList.remove('hidden');
    await renderCrud(box, 'debt_contacts', { filter: { debt_id: debt.id }, title: `Contact log — ${debt.creditor}`, subtitle: 'Every call, email or letter: who you spoke to, what was agreed, when to follow up.' });
    box.scrollIntoView({ behavior: 'smooth' });
  };
  let current = [];
  const list = async () => {
    current = await renderCrud($('#d-list'), 'debts', { title: 'All debts',
      onChange: async () => { await top(); await list(); },
      extra: (r, i) => `<button class="small log" data-i="${i}">Calls</button>`,
    });
    $('#d-list').querySelectorAll('.log').forEach(b => b.onclick = () => showLog(current[b.dataset.i]));
  };
  await Promise.all([top(), list()]);
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
const VIEWS = { dashboard, budget, bills, income, debts, transactions, sort: sortView, import: importView, shared, setup };
async function updateSortBadge() {
  const { count } = await sb.from('transactions').select('id', { count: 'exact', head: true }).is('category_id', null);
  const b = $('#sort-badge'); if (b) { b.textContent = count || ''; b.classList.toggle('hidden', !count); }
}
async function show(name, opts) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  history.replaceState(null, '', '#' + name);
  window.scrollTo(0, 0);
  try { await VIEWS[name](opts); updateSortBadge(); } catch (e) { view.innerHTML = `<div class="card"><p class="msg error">Something went wrong loading this page: ${esc(e.message)}</p></div>`; }
}
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => show(b.dataset.view));

let session = null;
async function enter(s) {
  session = s;
  $('#auth').classList.add('hidden'); $('#tabs').classList.remove('hidden'); $('#signout').classList.remove('hidden');
  await q(sb.rpc('seed_defaults'));   // safe every time: only adds what's missing
  await loadLookups();
  const start = location.hash.slice(1);
  show(VIEWS[start] ? start : 'dashboard');
}
function leave() {
  session = null; view.innerHTML = '';
  $('#auth').classList.remove('hidden'); $('#tabs').classList.add('hidden'); $('#signout').classList.add('hidden');
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

const { data: { session: existing } } = await sb.auth.getSession();
if (existing) enter(existing);
sb.auth.onAuthStateChange((evt, s) => { if (evt === 'SIGNED_OUT') leave(); else if (evt === 'SIGNED_IN' && !session && s) enter(s); });
