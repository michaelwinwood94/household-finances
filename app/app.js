import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';
import { parseBankCsv, parseWestpacActivity } from './csv.js';

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
      { k: 'debt_id', label: 'Linked debt', type: 'ref', ref: 'debts' },
      { k: 'match_text', label: 'Text on bank statement', type: 'text', hint: 'When an imported transaction contains this, the bill is marked paid and the due date moves on' },
      { k: 'is_shared', label: 'Shared with ex-partner', type: 'checkbox' },
      { k: 'my_share_pct', label: 'My share %', type: 'number', default: 100 },
      { k: 'is_active', label: 'Active', type: 'checkbox', default: true },
      { k: 'notes', label: 'Notes', type: 'textarea' },
    ],
    columns: ['name', 'direction', 'amount', 'frequency', 'next_due', 'is_shared', 'my_share_pct'],
  },
  debts: {
    title: 'Debts', order: ['priority', 'creditor'],
    fields: [
      { k: 'creditor', label: 'Who is owed', type: 'text', required: true },
      { k: 'debt_type', label: 'Type', type: 'select', options: ['mortgage', 'car_loan', 'personal_loan', 'credit_card', 'bnpl', 'utility', 'tax', 'fine', 'court', 'centrelink', 'family', 'other'] },
      { k: 'current_balance', label: 'Current balance', type: 'number', required: true },
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
  },
};

function cell(def, row, k) {
  const f = def.fields.find(x => x.k === k); const v = row[k];
  if (!f) return esc(v);
  if (f.type === 'ref') return esc(refName(f.ref, v));
  if (f.type === 'checkbox') return v ? '✔' : '';
  if (f.type === 'date') return esc(fmtDate(v));
  if (f.type === 'number' && /amount|balance|payment|budget/.test(k)) return money(v);
  if (k === 'hardship_status') return `<span class="pill ${v === 'approved' ? 'good' : v === 'to_request' ? 'warn' : ''}">${esc(label(v))}</span>`;
  if (k === 'priority' && def === TABLES.debts) return `<span class="pill ${v <= 1 ? 'bad' : v <= 2 ? 'warn' : ''}">${esc(v)}</span>`;
  if (k === 'paid_by') return v === 'partner' ? esc(cache.settings?.partner_label || 'Ex-partner') : 'Me';
  return esc(label(v));
}

// ---------- generic add / edit dialog ----------
function openForm(key, row = null, fixed = {}) {
  const def = TABLES[key];
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    const fieldsHtml = def.fields.map(f => {
      let val = row ? row[f.k] : (typeof f.default === 'function' ? f.default() : f.default);
      const req = f.required ? 'required' : '';
      const hint = f.hint ? `<span class="hint">${esc(f.hint)}</span>` : '';
      if (f.type === 'checkbox') return `<label><input type="checkbox" name="${f.k}" ${val ? 'checked' : ''}> ${esc(f.label)} ${hint}</label>`;
      if (f.type === 'select' || f.type === 'ref') {
        const opts = f.type === 'ref' ? refOptions[f.ref]() : f.options.map(o => [o, label(o)]);
        const blank = f.type === 'ref' ? `<option value="">— none —</option>` : '';
        return `<label>${esc(f.label)} ${hint}<select name="${f.k}" ${req}>${blank}${opts.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(val ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
      }
      if (f.type === 'textarea') return `<label>${esc(f.label)} ${hint}<textarea name="${f.k}" rows="2" ${req}>${esc(val)}</textarea></label>`;
      const step = f.type === 'number' ? 'step="0.01"' : '';
      return `<label>${esc(f.label)} ${hint}<input type="${f.type}" name="${f.k}" value="${esc(val)}" ${step} ${req}></label>`;
    }).join('');
    dlg.innerHTML = `<form method="dialog"><h2>${row ? 'Edit' : 'Add'} — ${esc(def.title)}</h2>
      <div class="formgrid">${fieldsHtml}</div>
      <div class="row"><button class="primary" value="save">Save</button><button value="cancel" formnovalidate>Cancel</button></div></form>`;
    document.body.appendChild(dlg);
    const form = $('form', dlg);
    form.addEventListener('submit', async (e) => {
      if (e.submitter?.value !== 'save') return;
      e.preventDefault();
      const out = { ...fixed };
      for (const f of def.fields) {
        const el = form.elements[f.k];
        if (f.type === 'checkbox') out[f.k] = el.checked;
        else if (f.type === 'number') out[f.k] = el.value === '' ? null : Number(el.value);
        else out[f.k] = el.value === '' ? null : el.value;
        if (f.k === 'priority' && out[f.k] != null) out[f.k] = Number(out[f.k]);
      }
      try {
        if (row) await q(sb.from(key).update(out).eq('id', row.id));
        else await q(sb.from(key).insert(out));
        toast('Saved'); dlg.close(); dlg.remove(); resolve(true);
      } catch { /* toast already shown; keep dialog open */ }
    });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(false); });
    dlg.showModal();
  });
}

async function renderCrud(container, key, { filter = {}, title, onChange, extra } = {}) {
  const def = TABLES[key];
  let query = sb.from(key).select('*');
  for (const [k, v] of Object.entries(filter)) query = query.eq(k, v);
  for (const o of def.order) query = query.order(o, { ascending: !def.desc });
  const rows = await q(query);
  container.innerHTML = `<div class="row" style="justify-content:space-between"><h2>${esc(title || def.title)}</h2>
      <button class="primary add">+ Add</button></div>
    ${rows.length ? `<div class="tablewrap"><table><thead><tr>${def.columns.map(k => `<th class="${/amount|balance|payment|budget/.test(k) ? 'num' : ''}">${esc(def.fields.find(f => f.k === k)?.label || label(k))}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr>${def.columns.map(k => `<td class="${/amount|balance|payment|budget/.test(k) ? 'num' : ''}">${cell(def, r, k)}</td>`).join('')}
        <td class="row" style="flex-wrap:nowrap">${extra ? extra(r, i) : ''}<button class="small edit" data-i="${i}">Edit</button><button class="small danger del" data-i="${i}">Delete</button></td></tr>`).join('')}</tbody></table></div>`
      : `<p class="empty">Nothing here yet.</p>`}`;
  const changed = async () => { await loadLookups(); onChange ? await onChange() : await renderCrud(container, key, { filter, title, onChange, extra }); };
  $('.add', container).onclick = async () => { if (await openForm(key, null, filter)) await changed(); };
  container.querySelectorAll('.edit').forEach(b => b.onclick = async () => { if (await openForm(key, rows[b.dataset.i], filter)) await changed(); });
  container.querySelectorAll('.del').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this entry? This cannot be undone.')) return;
    await q(sb.from(key).delete().eq('id', rows[b.dataset.i].id)); toast('Deleted'); await changed();
  });
  return rows;
}

// ---------- DASHBOARD ----------
async function dashboard() {
  view.innerHTML = '<p>Loading…</p>';
  const monthStart = today().slice(0, 8) + '01';
  const [bal, cash, debt, shared, commit, upcoming, followups, catSpend] = await Promise.all([
    q(sb.from('v_account_balances').select('*').eq('is_active', true)),
    q(sb.from('v_monthly_cashflow').select('*').order('month', { ascending: false }).limit(6)),
    q(sb.from('v_debt_summary').select('*').maybeSingle()),
    q(sb.from('v_shared_balance').select('*').maybeSingle()),
    q(sb.from('v_monthly_commitments').select('*').maybeSingle()),
    q(sb.rpc('upcoming_items', { p_days: 21 })),
    q(sb.from('debt_contacts').select('follow_up_date, summary, debt_id').eq('follow_up_done', false).not('follow_up_date', 'is', null).lte('follow_up_date', new Date(Date.now() + 7 * 864e5).toLocaleDateString('en-CA')).order('follow_up_date')),
    q(sb.from('v_category_spend_month').select('*').eq('month', monthStart).order('spent', { ascending: false })),
  ]);
  const { count: uncatCount } = await sb.from('transactions').select('id', { count: 'exact', head: true }).is('category_id', null);
  const isLoan = a => ['loan', 'mortgage', 'credit_card'].includes(a.account_type);
  const accBal = a => Number(a.last_statement_balance ?? a.calculated_balance ?? 0);
  const cashAccts = bal.filter(a => !isLoan(a));
  const totalCash = cashAccts.reduce((s, a) => s + accBal(a) * (a.is_joint ? Number(a.my_share_pct ?? 100) / 100 : 1), 0);
  const jointAccts = cashAccts.filter(a => a.is_joint);
  const jointTotal = jointAccts.reduce((s, a) => s + accBal(a), 0);
  const loans = bal.filter(isLoan);
  const totalLoans = loans.reduce((s, a) => s + accBal(a), 0);
  const thisMonth = cash.find(c => c.month === monthStart) || {};
  const s = Number(shared?.balance || 0);
  const partner = cache.settings?.partner_label || 'Ex-partner';
  const gap = Number(commit?.monthly_in || 0) - Number(commit?.monthly_out || 0) - Number(debt?.my_monthly_minimums || 0);

  view.innerHTML = `
    ${!cache.accounts.length ? `<div class="card"><h2>Welcome</h2><p>Start in <b>Setup</b>: add your bank accounts. Or go straight to <b>Import</b> and choose your CommBank CSV and Westpac PDF/CSV files — accounts are set up for you.</p></div>` : ''}
    <div class="grid">
      <div class="stat"><div class="label">Money in accounts</div><div class="value">${money(totalCash)}</div><div class="sub">${cashAccts.length} everyday/savings account(s)${jointAccts.length ? `<br>Includes your share of joint accounts (joint total ${money(jointTotal)})` : ''}</div></div>
      ${loans.length ? `<div class="stat warn"><div class="label">Loan balances</div><div class="value">${money(Math.abs(totalLoans))}</div><div class="sub">${loans.map(a => esc(a.name)).join(' · ')}</div></div>` : ''}
      <div class="stat ${Number(thisMonth.net) < 0 ? 'bad' : 'good'}"><div class="label">This month so far</div><div class="value">${money(thisMonth.net || 0)}</div><div class="sub">In ${money(thisMonth.money_in || 0)} · Out ${money(thisMonth.money_out || 0)}</div></div>
      <div class="stat ${gap < 0 ? 'bad' : 'good'}"><div class="label">Regular monthly gap</div><div class="value">${money(gap)}</div><div class="sub">Regular income − bills − debt minimums</div></div>
      <div class="stat warn"><div class="label">My total debt</div><div class="value">${money(debt?.my_total_owed || 0)}</div><div class="sub">Arrears ${money(debt?.my_total_arrears || 0)} · ${debt?.active_debts || 0} debts · ${debt?.on_hardship || 0} on hardship</div></div>
      <div class="stat"><div class="label">Shared costs</div><div class="value">${money(Math.abs(s))}</div><div class="sub">${s > 0 ? `${esc(partner)} owes you` : s < 0 ? `You owe ${esc(partner)}` : 'All square'}</div></div>
    </div>
    ${uncatCount ? `<div class="card"><b>${uncatCount}</b> transaction(s) have no category. <button class="link" id="go-uncat">Sort them now</button></div>` : ''}
    ${debt?.hardship_to_request ? `<div class="card"><span class="pill warn">To do</span> ${debt.hardship_to_request} debt(s) marked "to request" hardship. A free financial counsellor (National Debt Helpline 1800 007 007) can make these calls with you.</div>` : ''}
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
      <div class="card"><h2>Next 3 weeks</h2>
        ${upcoming.length ? `<table><tbody>${upcoming.map(u => `<tr class="${u.overdue ? 'overdue' : ''}"><td>${esc(fmtDate(u.due_date))}<br><span class="hint">${u.overdue ? (u.direction === 'in' ? 'not received yet' : 'OVERDUE') : daysFromToday(u.due_date) === 0 ? 'today' : 'in ' + daysFromToday(u.due_date) + ' days'}</span></td>
          <td>${esc(u.name)}${u.is_shared ? ' <span class="pill">shared</span>' : ''}</td><td class="num ${u.direction === 'in' ? 'in' : ''}">${u.direction === 'in' ? '+' : '−'}${money(u.my_amount)}</td></tr>`).join('')}</tbody></table>`
          : '<p class="empty">No bills or income set up yet — add them under Bills &amp; income.</p>'}
      </div>
      <div class="card"><h2>Spending this month</h2>
        ${catSpend.length ? `<table><tbody>${catSpend.map(c => {
          const over = c.monthly_budget && Number(c.spent) > Number(c.monthly_budget);
          return `<tr><td>${esc(c.category)}${c.is_essential ? ' <span class="pill">essential</span>' : ''}</td><td class="num">${money(c.spent)}</td>
            <td class="num hint">${c.monthly_budget ? `${over ? '<span class="pill bad">over</span> ' : ''}of ${money(c.monthly_budget)}` : ''}</td></tr>`; }).join('')}</tbody></table>`
          : '<p class="empty">No spending imported for this month yet.</p>'}
      </div>
      <div class="card"><h2>Creditor follow-ups due</h2>
        ${followups.length ? `<table><tbody>${followups.map(f => `<tr class="${f.follow_up_date < today() ? 'overdue' : ''}"><td>${esc(fmtDate(f.follow_up_date))}</td><td><b>${esc(refName('debts', f.debt_id))}</b><br>${esc(f.summary)}</td></tr>`).join('')}</tbody></table>`
          : '<p class="empty">Nothing due this week.</p>'}
      </div>
      <div class="card"><h2>Last 6 months</h2>
        ${cash.length ? `<table><thead><tr><th>Month</th><th class="num">In</th><th class="num">Out</th><th class="num">Net</th></tr></thead><tbody>${cash.map(c => `<tr><td>${new Date(c.month + 'T00:00:00').toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })}</td><td class="num in">${money(c.money_in || 0)}</td><td class="num">${money(c.money_out || 0)}</td><td class="num ${Number(c.net) < 0 ? 'out' : 'in'}"><b>${money(c.net || 0)}</b></td></tr>`).join('')}</tbody></table>`
          : '<p class="empty">Import a statement to see this.</p>'}
      </div>
    </div>`;
  $('#go-uncat')?.addEventListener('click', () => show('transactions', { uncategorised: true }));
}

// ---------- TRANSACTIONS ----------
async function transactions(opts = {}) {
  const state = { month: opts.uncategorised ? '' : today().slice(0, 7), account: '', uncategorised: !!opts.uncategorised, search: '' };
  view.innerHTML = `<div class="card"><div class="formgrid">
      <label>Month <input type="month" id="f-month" value="${state.month}"></label>
      <label>Account <select id="f-acct"><option value="">All accounts</option>${cache.accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>
      <label>Search <input type="search" id="f-search" placeholder="e.g. woolworths"></label>
      <label style="align-self:end"><input type="checkbox" id="f-uncat" ${state.uncategorised ? 'checked' : ''}> Only uncategorised</label>
    </div></div><div class="card" id="txlist"></div>`;
  const catOpts = (sel) => `<option value="">— choose —</option>` + cache.categories.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  async function load() {
    let query = sb.from('transactions').select('*').order('txn_date', { ascending: false }).order('created_at', { ascending: false }).limit(500);
    if (state.month) { const [y, m] = state.month.split('-').map(Number); const end = new Date(y, m, 1).toLocaleDateString('en-CA'); query = query.gte('txn_date', state.month + '-01').lt('txn_date', end); }
    if (state.account) query = query.eq('account_id', state.account);
    if (state.uncategorised) query = query.is('category_id', null);
    if (state.search) query = query.ilike('description', `%${state.search.replace(/[%_]/g, '')}%`);
    const rows = await q(query);
    const total = rows.reduce((s, r) => s + Number(r.amount), 0);
    const box = $('#txlist');
    box.innerHTML = rows.length ? `<p>${rows.length} transaction(s) · net ${money(total)}${rows.length === 500 ? ' (showing first 500)' : ''}</p>
      <div class="tablewrap"><table><thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th><th>Category</th><th class="hide-sm">Shared</th><th></th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td>${esc(fmtDate(r.txn_date))}<br><span class="hint hide-sm">${esc(refName('accounts', r.account_id))}</span></td><td>${esc(r.description)}</td>
        <td class="num ${r.amount > 0 ? 'in' : ''}">${money(r.amount)}</td>
        <td><select data-i="${i}" class="cat" aria-label="Category">${catOpts(r.category_id)}</select>${r.category_source === 'rule' ? '<br><span class="hint">by rule</span>' : ''}</td>
        <td class="hide-sm"><input type="checkbox" class="shr" data-i="${i}" ${r.is_shared ? 'checked' : ''} aria-label="Shared"></td>
        <td><button class="small mkrule" data-i="${i}" title="Always categorise transactions like this">Make rule</button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty">No transactions match.</p>';
    box.querySelectorAll('.cat').forEach(s => s.onchange = async () => {
      const r = rows[s.dataset.i];
      await q(sb.from('transactions').update({ category_id: s.value || null, category_source: s.value ? 'manual' : 'none' }).eq('id', r.id));
      r.category_id = s.value || null; toast('Category saved');
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
  $('#f-month').onchange = e => { state.month = e.target.value; load(); };
  $('#f-acct').onchange = e => { state.account = e.target.value; load(); };
  $('#f-uncat').onchange = e => { state.uncategorised = e.target.checked; load(); };
  let t; $('#f-search').oninput = e => { clearTimeout(t); t = setTimeout(() => { state.search = e.target.value.trim(); load(); }, 350); };
  await load();
}

function makeRule(txn, after) {
  const guess = txn.description.replace(/[0-9#*]+/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ').toUpperCase();
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form method="dialog"><h2>Make a rule</h2><p class="hint">From: ${esc(txn.description)}</p>
    <label>When the description contains <input name="m" value="${esc(guess)}" required></label>
    <label>Set category <select name="c" required>${cache.categories.map(c => `<option value="${c.id}" ${c.id === txn.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <label><input type="checkbox" name="s"> Also add to shared costs</label>
    <p class="hint">The rule applies to money ${txn.amount > 0 ? 'coming in' : 'going out'}, and is re-run on everything not set by hand.</p>
    <div class="row"><button class="primary" value="save">Save rule</button><button value="cancel" formnovalidate>Cancel</button></div></form>`;
  document.body.appendChild(dlg);
  const f = $('form', dlg);
  f.addEventListener('submit', async e => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    await q(sb.from('category_rules').insert({ match_text: f.m.value.trim(), direction: txn.amount > 0 ? 'in' : 'out', category_id: f.c.value, mark_shared: f.s.checked, priority: 20 }));
    const n = await q(sb.rpc('recategorise_uncategorised'));
    toast(`Rule saved — ${n} transaction(s) updated`); dlg.close(); after();
  });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
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
  view.innerHTML = `<div class="card"><h2>Import bank statements</h2>
    <p class="hint">Choose one or more files at once: <b>CSV</b> exports from CommBank or Westpac, or the <b>Account activity PDF</b> from the Westpac app.
    Each file is matched to an account (or a new account is set up for you). Importing the same dates twice is safe — duplicates are skipped.</p>
    <label>Statement files <input type="file" id="i-file" accept=".csv,text/csv,.pdf,application/pdf" multiple></label>
    <div id="i-preview"></div></div>
    <div class="card" id="i-history"></div>`;

  $('#i-file').onchange = async e => {
    const files = [...e.target.files]; if (!files.length) return;
    const pv = $('#i-preview'); pv.innerHTML = '<p>Reading files…</p>';
    const jobs = [];
    for (const file of files) {
      let parsed;
      try {
        parsed = /\.pdf$/i.test(file.name) || file.type === 'application/pdf'
          ? parseWestpacActivity(await readPdfItems(file))
          : parseBankCsv(await file.text());
      } catch (err) { parsed = { format: 'unknown', rows: [], skipped: [], error: 'Could not read this file: ' + err.message }; }
      const acc = parsed.account || {};
      const match = cache.accounts.find(a => acc.last4 && a.nickname_last4 === acc.last4)
        || cache.accounts.find(a => acc.name && a.name.toLowerCase() === acc.name.toLowerCase() && !a.nickname_last4);
      jobs.push({ file, parsed, accountId: match ? match.id : 'new',
        newName: acc.name ? `${acc.name}${acc.last4 ? ' …' + acc.last4 : ''}` : (guessInstitution(parsed, file.name) + ' account') });
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
          return `<tr><td>${esc(j.file.name)}<br><span class="hint">${esc(label(p.format))}${p.account?.name ? ' · ' + esc(p.account.name) : ''}${p.account?.last4 ? ' …' + esc(p.account.last4) : ''}</span></td>
            <td><b>${p.rows.length}</b> transactions<br><span class="hint">${esc(fmtDate(dates[0]))} – ${esc(fmtDate(dates.at(-1)))}<br>in ${money(ins)} · out ${money(outs)}${p.account?.balance != null ? '<br>balance now ' + money(p.account.balance) : ''}</span>
              ${p.skipped.length ? `<br><span class="msg error">${p.skipped.length} line(s) skipped</span>` : ''}</td>
            <td><select data-i="${i}" class="j-acct"><option value="new" ${j.accountId === 'new' ? 'selected' : ''}>+ New account</option>
              ${cache.accounts.map(a => `<option value="${a.id}" ${a.id === j.accountId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
              ${j.accountId === 'new' ? `<input class="j-name" data-i="${i}" value="${esc(j.newName)}" aria-label="New account name">
                <label style="font-weight:400"><input type="checkbox" class="j-joint" data-i="${i}" ${j.joint ? 'checked' : ''}> Joint / shared account</label>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>
        ${ok.length ? `<details><summary>Preview first rows</summary>${ok.map(j => `<h3>${esc(j.file.name)}</h3><div class="tablewrap"><table><tbody>${j.parsed.rows.slice(0, 5).map(r => `<tr><td>${esc(fmtDate(r.date))}</td><td>${esc(r.description)}</td><td class="num ${r.amount > 0 ? 'in' : ''}">${money(r.amount)}</td></tr>`).join('')}</tbody></table></div>`).join('')}</details>
        <div class="row" style="margin-top:1rem"><button class="primary" id="i-go">Import ${ok.reduce((s, j) => s + j.parsed.rows.length, 0)} transactions from ${ok.length} file(s)</button></div>` : ''}`;
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
        }
        // send in chunks so very long histories go through reliably
        let tot = { inserted: 0, duplicates: 0, linked_to_bills: 0, shared_added: 0 };
        for (let k = 0; k < p.rows.length; k += 1000) {
          const res = await q(sb.rpc('import_transactions', { p_account_id: accountId, p_rows: p.rows.slice(k, k + 1000), p_filename: j.file.name, p_format: p.format }));
          for (const key in tot) tot[key] += res[key] || 0;
        }
        results.push(`<li><b>${esc(j.file.name)}</b> → ${esc(refName('accounts', accountId))}: ${tot.inserted} new, ${tot.duplicates} already there, ${tot.linked_to_bills} matched to bills, ${tot.shared_added} added to shared costs</li>`);
      }
      pv.innerHTML = `<p class="msg"><b>Done.</b></p><ul>${results.join('')}</ul>
        <p>Next: <button class="link" id="go-uncat2">sort the uncategorised transactions</button>.</p>`;
      $('#go-uncat2').onclick = () => show('transactions', { uncategorised: true });
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

// ---------- BILLS ----------
async function bills() {
  view.innerHTML = `<div class="card" id="b-up"></div><div class="card" id="b-list"></div>`;
  const drawUpcoming = async () => {
    const up = await q(sb.rpc('upcoming_items', { p_days: 35 }));
    const outs = up.filter(u => u.direction === 'out').reduce((s, u) => s + Number(u.my_amount), 0);
    const ins = up.filter(u => u.direction === 'in').reduce((s, u) => s + Number(u.my_amount), 0);
    $('#b-up').innerHTML = `<h2>Next 5 weeks</h2><p>Coming in ${money(ins)} · Going out ${money(outs)} (your share) · Difference <b>${money(ins - outs)}</b></p>
      ${up.length ? `<div class="tablewrap"><table><tbody>${up.map(u => `<tr class="${u.overdue ? 'overdue' : ''}"><td>${esc(fmtDate(u.due_date))}${u.overdue ? ' <span class="pill bad">overdue</span>' : ''}</td><td>${esc(u.name)}</td><td class="num ${u.direction === 'in' ? 'in' : ''}">${u.direction === 'in' ? '+' : '−'}${money(u.my_amount)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Add your bills and income below.</p>'}`;
  };
  const drawList = () => renderCrud($('#b-list'), 'recurring_items', { onChange: async () => { await drawUpcoming(); await drawList(); } });
  await Promise.all([drawUpcoming(), drawList()]);
}

// ---------- DEBTS ----------
async function debts() {
  view.innerHTML = `<div class="grid" id="d-sum"></div><div class="card" id="d-list"></div><div class="card hidden" id="d-log"></div>`;
  const sum = async () => {
    const d = await q(sb.from('v_debt_summary').select('*').maybeSingle()) || {};
    $('#d-sum').innerHTML = `
      <div class="stat warn"><div class="label">My total owed</div><div class="value">${money(d.my_total_owed || 0)}</div></div>
      <div class="stat ${Number(d.my_total_arrears) > 0 ? 'bad' : ''}"><div class="label">Overdue (arrears)</div><div class="value">${money(d.my_total_arrears || 0)}</div></div>
      <div class="stat"><div class="label">Minimum payments / month</div><div class="value">${money(d.my_monthly_minimums || 0)}</div></div>
      <div class="stat good"><div class="label">On hardship arrangements</div><div class="value">${d.on_hardship || 0} of ${d.active_debts || 0}</div></div>`;
  };
  const showLog = async (debt) => {
    const box = $('#d-log'); box.classList.remove('hidden');
    await renderCrud(box, 'debt_contacts', { filter: { debt_id: debt.id }, title: `Contact log — ${debt.creditor}` });
    box.scrollIntoView({ behavior: 'smooth' });
  };
  let current = [];
  const list = async () => {
    current = await renderCrud($('#d-list'), 'debts', {
      onChange: async () => { await sum(); await list(); },
      extra: (r, i) => `<button class="small log" data-i="${i}">Log</button>`,
    });
    $('#d-list').querySelectorAll('.log').forEach(b => b.onclick = () => showLog(current[b.dataset.i]));
  };
  await Promise.all([sum(), list()]);
}

// ---------- SHARED ----------
async function shared() {
  view.innerHTML = `<div class="grid" id="s-bal"></div><div class="card" id="s-list"></div>`;
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
  view.innerHTML = `<div class="card"><h2>Settings</h2><form id="set"><div class="formgrid">
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
const VIEWS = { dashboard, transactions, import: importView, bills, debts, shared, setup };
async function show(name, opts) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  history.replaceState(null, '', '#' + name);
  try { await VIEWS[name](opts); } catch (e) { view.innerHTML = `<div class="card"><p class="msg error">Something went wrong loading this page: ${esc(e.message)}</p></div>`; }
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
