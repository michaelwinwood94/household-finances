import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js?v=202611232040';
import { parseBankCsv, parseWestpacActivity, splitAccounts, linesFromItems } from './csv.js?v=202611232040';
import { readPayslip, toLines } from './payslip.js?v=202611232040';
import { readBill } from './bill.js?v=202611232040';
import { toast, softDelete, busy, friendlyError, watchOnline, info, wireInfoTips, skeleton, wireInstall, applyPrefs, settingsMenu, prefs, setPref, store } from './ui.js?v=202611232040';
import { columnChart, hbarChart, lineChart, SERIES, moneyRound, moneyCompact } from './charts.js?v=202611232040';

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
const label = (s) => s === 'bimonthly' ? 'Every 2 months' : String(s ?? '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

// ---------- lookups (accounts, categories, debts) ----------
const cache = { accounts: [], categories: [], debts: [], settings: null, members: [] };
async function loadLookups() {
  const [a, c, d, s, m] = await Promise.all([
    q(sb.from('accounts').select('*').order('name')),
    q(sb.from('categories').select('*').order('sort_order').order('name')),
    q(sb.from('debts').select('id, creditor, status').order('creditor')),
    q(sb.from('settings').select('*').maybeSingle()),
    q(sb.from('household_members').select('*').order('is_primary', { ascending: false }).order('sort_order').order('created_at')),
  ]);
  Object.assign(cache, { accounts: a, categories: c, debts: d, settings: s, members: m });
  // older saved views used 'me' / 'partner'
  if (personView === 'me') personView = primaryId() || 'all';
  if (personView === 'partner') personView = cache.members[1]?.id || 'all';
  if (personView !== 'all' && !cache.members.some(x => x.id === personView)) personView = 'all';
}
const refOptions = {
  accounts: () => cache.accounts.map(a => [a.id, a.name]),
  categories: () => cache.categories.map(c => [c.id, `${c.name} (${c.kind})`]),
  debts: () => cache.debts.map(d => [d.id, d.creditor]),
};
const refName = (ref, id) => { if (!id) return '—'; const o = refOptions[ref]().find(([v]) => v === id); return o ? o[1].replace(/ \((income|expense|transfer)\)$/, '') : '—'; };

const FREQ = ['once', 'weekly', 'fortnightly', 'monthly', 'bimonthly', 'quarterly', 'yearly'];
const PER_MONTH = { once: 0, weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1, bimonthly: 1 / 2, quarterly: 1 / 3, yearly: 1 / 12 };
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
      { k: 'split', label: 'Whose money is it?', type: 'split', hint: 'For a joint account choose equal or set each person’s %' },
      { k: 'is_active', label: 'Active', type: 'checkbox', default: true },
    ],
    columns: ['name', 'institution', 'account_type', 'nickname_last4', 'share'],
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
      { k: 'split', label: 'Who pays / whose is it?', type: 'split' },
      { k: 'is_active', label: 'Active', type: 'checkbox', default: true },
      { k: 'notes', label: 'Notes', type: 'textarea' },
    ],
    columns: ['name', 'direction', 'amount', 'frequency', 'next_due', 'share'],
    footer: rows => {
      const m = (dir, who) => sum(rows.filter(r => r.is_active && r.direction === dir), r => r.amount * PER_MONTH[r.frequency] * shareFor(r.split, who || 'all'));
      const inAll = m('in'), outAll = m('out');
      return `Per month (including loan repayments) — <b>household:</b> in ${money(inAll)} · out ${money(outAll)} · left ${money(inAll - outAll)}
        ${cache.members.length > 1 ? cache.members.map(mb => `&nbsp;|&nbsp; <b>${esc(memberName(mb))}:</b> in ${money(m('in', mb.id))} · out ${money(m('out', mb.id))} · left ${money(m('in', mb.id) - m('out', mb.id))}`).join('') : ''}
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
      { k: 'split', label: 'Whose debt is it?', type: 'split' },
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
      { k: 'paid_by', label: 'Paid by', type: 'select', options: ['me', 'partner'], labels: () => ({ me: memberName(cache.members[0]) || 'Me', partner: cache.settings?.partner_label || 'Others' }) },
      { k: 'my_share_pct', label: 'Main person’s share %', type: 'number', default: () => myDefaultPct(), hint: 'Ignored for settlements' },
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
  if (k === 'paid_by') return v === 'partner' ? esc(cache.settings?.partner_label || 'Others') : esc(memberName(cache.members[0]) || 'Me');
  if (f.type === 'split') return esc(splitLabel(v));
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
const FREQ_WORD = { once: 'once', weekly: 'week', fortnightly: 'fortnight', monthly: 'month', bimonthly: '2 months', quarterly: 'quarter', yearly: 'year' };
TABLES.bills = { ...TABLES.recurring_items, table: 'recurring_items', title: 'Your bills', order: ['next_due'], addTitle: 'bill',
  columns: ['name', 'amount_freq', 'who_month', 'next', 'share'],
  footer: rows => {
    const act = rows.filter(r => r.is_active);
    return { who_month: `<b>${money(sum(act, r => r.amount * PER_MONTH[r.frequency] * shareFor(r.split)))}</b>`,
             name: `<b>Total per month</b><br><span class="hint">including loan repayments</span>` };
  } };
TABLES.income = { ...TABLES.recurring_items, table: 'recurring_items', title: 'Your income', order: ['next_due'], addTitle: 'income',
  fields: TABLES.recurring_items.fields.filter(f => f.k !== 'debt_id').map(f => f.k === 'match_text' ? { ...f, hint: 'When an imported deposit contains this, it is marked received and the date moves on' } : f),
  columns: ['name', 'amount_freq', 'who_month', 'next', 'share'],
  footer: rows => {
    const act = rows.filter(r => r.is_active);
    return { who_month: `<b>${money(sum(act, r => r.amount * PER_MONTH[r.frequency] * shareFor(r.split)))}</b>`, name: `<b>Total per month</b>` };
  } };
TABLES.debts.columns = ['creditor', 'current_balance', 'arrears_amount', 'monthly', 'hardship_status', 'share'];
TABLES.debts.headers = { creditor: 'Owed to', current_balance: 'Balance', arrears_amount: 'Overdue', hardship_status: 'Hardship' };
TABLES.debts.footer = rows => {
  const act = rows.filter(r => r.status === 'active');
  return { creditor: '<b>Total</b> <span class="hint">(active)</span>', current_balance: `<b>${money(sum(act, r => r.current_balance))}</b>`,
    arrears_amount: money(sum(act, r => r.arrears_amount)), monthly: `<b>${money(sum(act, r => r.min_payment * PER_MONTH[r.payment_frequency || 'monthly']))}</b>` };
};
// Whose view a page is showing: 'all' (household) or a member's id
let personView = (() => { try { return localStorage.getItem('personView') || 'all'; } catch { return 'all'; } })();
const RELATIONSHIPS = { me: 'Me', partner: 'Partner', 'ex-partner': 'Ex-partner', child: 'Child', boarder: 'Boarder', housemate: 'Housemate', family: 'Family', other: 'Other' };
const memberName = m => !m ? '' : (m.name && m.name.trim()) || (m.is_primary ? 'Me' : 'Unnamed');
const memberById = id => cache.members.find(m => m.id === id);
const primaryId = () => cache.members.find(m => m.is_primary)?.id || cache.members[0]?.id;
const personNames = () => Object.fromEntries([['all', 'Household'], ...cache.members.map(m => [m.id, memberName(m)])]);
const personName = (who = personView) => personNames()[who] || 'Household';
// A split is null (equal between everyone) or { memberId: percent }
const shareFor = (split, who = personView) => {
  if (who === 'all' || who == null) return 1;
  if (!split || !Object.keys(split).length) return 1 / Math.max(1, cache.members.length);
  return Number(split[who] || 0) / 100;
};
const onlyFor = id => ({ [id]: 100 });
const myDefaultPct = () => Math.round(shareFor(cache.settings?.default_split, primaryId()) * 10000) / 100;
function splitLabel(split) {
  const n = cache.members.length;
  if (!split || !Object.keys(split).length) return n > 1 ? `Equal (${n} people)` : memberName(cache.members[0]) || 'Me';
  const parts = Object.entries(split).filter(([, v]) => Number(v) > 0);
  if (parts.length === 1) return `All ${memberName(memberById(parts[0][0])) || 'removed member'}`;
  return parts.map(([id, v]) => `${memberName(memberById(id)) || '?'} ${Math.round(v)}%`).join(' · ');
}
function splitEditor(name, split) {
  const ms = cache.members, n = ms.length;
  if (n <= 1) return `<div class="split-ed" data-split="${name}" data-single="1"><p class="hint">Only one person in the household — add people on the <b>Household</b> page to split costs.</p></div>`;
  const custom = !!(split && Object.keys(split).length);
  const eq = Math.round(10000 / n) / 100;
  return `<div class="split-ed" data-split="${name}">
    <div class="split-mode"><label class="inline"><input type="radio" name="${name}-mode" value="equal" ${custom ? '' : 'checked'}> Split equally (${eq}% each)</label>
      <label class="inline"><input type="radio" name="${name}-mode" value="custom" ${custom ? 'checked' : ''}> Choose who / set %</label></div>
    <div class="split-rows ${custom ? '' : 'hidden'}">
      ${ms.map(m => `<label class="split-row"><span>${esc(memberName(m))}</span><input type="number" min="0" max="100" step="0.01" data-mid="${m.id}" value="${custom ? Number(split[m.id] || 0) : eq}"><span>%</span></label>`).join('')}
      <div class="split-quick">${ms.map(m => `<button type="button" class="small" data-all="${m.id}">All ${esc(memberName(m))}</button>`).join('')}<button type="button" class="small" data-eq="1">Equal</button></div>
      <p class="hint split-total"></p></div></div>`;
}
function wireSplits(root) {
  root.querySelectorAll('.split-ed:not([data-single])').forEach(ed => {
    const rows = ed.querySelector('.split-rows'), inputs = [...ed.querySelectorAll('input[data-mid]')], tot = ed.querySelector('.split-total');
    const upd = () => { const t = inputs.reduce((a, i) => a + Number(i.value || 0), 0); tot.textContent = Math.abs(t - 100) < 0.05 ? 'Adds up to 100% ✓' : `Adds up to ${Math.round(t * 100) / 100}% — needs to be 100%`; tot.classList.toggle('bad-text', Math.abs(t - 100) >= 0.05); };
    ed.querySelectorAll('input[type=radio]').forEach(r => r.onchange = () => { rows.classList.toggle('hidden', ed.querySelector('input[type=radio]:checked').value !== 'custom'); upd(); });
    inputs.forEach(i => i.oninput = upd);
    ed.querySelectorAll('[data-all]').forEach(b => b.onclick = () => { inputs.forEach(i => { i.value = i.dataset.mid === b.dataset.all ? 100 : 0; }); upd(); });
    ed.querySelector('[data-eq]').onclick = () => { inputs.forEach(i => { i.value = Math.round(10000 / inputs.length) / 100; }); upd(); };
    upd();
  });
}
// returns null (equal), an object, or throws a message
function readSplit(root, name) {
  const ed = root.querySelector(`.split-ed[data-split="${name}"]`);
  if (!ed || ed.dataset.single) return null;
  if (ed.querySelector('input[type=radio]:checked').value !== 'custom') return null;
  const out = {}; let t = 0;
  ed.querySelectorAll('input[data-mid]').forEach(i => { const v = Number(i.value || 0); t += v; if (v > 0) out[i.dataset.mid] = v; });
  if (Math.abs(t - 100) >= 0.05) throw new Error(`The split adds up to ${Math.round(t * 100) / 100}% — it needs to be 100%.`);
  return out;
}
// Pages that change with the person switch; others show household figures and say so
const PERSON_PAGES = ['dashboard', 'budget', 'bills', 'income', 'debts', 'pay', 'tax', 'report'];
function renderWhoSwitch() {
  const box = $('#whoswitch'); if (!box) return;
  box.classList.toggle('single', cache.members.length < 2);
  box.innerHTML = `<span class="who-label">Showing</span>` + Object.entries(personNames()).map(([k, v]) =>
    `<button class="${k === personView ? 'on' : ''}" data-person="${k}" aria-pressed="${k === personView}">${esc(v)}</button>`).join('');
  box.classList.toggle('dim', !PERSON_PAGES.includes(currentView));
  box.title = PERSON_PAGES.includes(currentView) ? '' : 'This page shows household figures';
  box.querySelectorAll('[data-person]').forEach(b => b.onclick = () => {
    personView = b.dataset.person; try { localStorage.setItem('personView', personView); } catch {}
    renderWhoSwitch(); if (PERSON_PAGES.includes(currentView)) show(currentView);
  });
}
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
    : money(r.amount * PER_MONTH[r.frequency] * shareFor(r.split)) },
  amount_freq: { label: 'Amount', num: true, html: r => `${money(r.amount)} <span class="hint">/ ${FREQ_WORD[r.frequency] || r.frequency}</span>` },
  per_month: { label: 'Per month', num: true, html: r => r.debt_id ? '<span class="hint">in Debts</span>' : money(r.amount * PER_MONTH[r.frequency]) },
  monthly: { label: 'Per month', num: true, html: r => r.min_payment ? money(r.min_payment * PER_MONTH[r.payment_frequency || 'monthly']) : '<span class="hint">—</span>' },
  next: { label: 'Next due', html: r => {
    if (!r.is_active) return '<span class="pill">paused</span>';
    const d = daysFromToday(r.next_due);
    const pill = d < 0 ? `<span class="pill bad">${r.direction === 'in' ? 'late' : 'overdue'}</span>` : d === 0 ? '<span class="pill warn">today</span>' : d <= 7 ? `<span class="pill warn">in ${d} day${d === 1 ? '' : 's'}</span>` : '';
    return `${esc(fmtDate(r.next_due))} ${pill}`; } },
  share: { label: 'Whose', html: r => `<span class="nowrap">${esc(splitLabel(r.split))}</span>` },
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
function openForm(key, row = null, fixed = {}, prefill = null) {
  const def = TABLES[key];
  const table = def.table || key;
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    const fieldsHtml = def.fields.filter(f => !(f.k in fixed)).map(f => {
      let val = row ? row[f.k] : prefill && f.k in prefill ? prefill[f.k] : (typeof f.default === 'function' ? f.default() : f.default);
      const req = f.required ? 'required' : '';
      const hint = f.hint ? `<span class="hint">${esc(f.hint)}</span>` : '';
      if (f.type === 'checkbox') return `<label><input type="checkbox" name="${f.k}" ${val ? 'checked' : ''}> ${esc(f.label)} ${hint}</label>`;
      if (f.type === 'split') return `<div class="full"><div class="field-label">${esc(f.label)} ${hint}</div>${splitEditor(f.k, val)}</div>`;
      if (f.type === 'select' || f.type === 'ref') {
        if (f.type === 'ref' && f.ref === 'categories') return `<label>${esc(f.label)} ${hint}<select name="${f.k}" ${req} data-cat>${catOptions(val, { blank: '— none —' })}</select></label>`;
        const lbls = f.labels ? f.labels() : {};
        const opts = f.type === 'ref' ? refOptions[f.ref]() : f.options.map(o => [o, lbls[o] || label(o)]);
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
    wireSplits(form);
    form.addEventListener('submit', async (e) => {
      if (e.submitter?.value !== 'save') return;
      e.preventDefault();
      const out = { ...fixed };
      for (const f of def.fields) {
        if (f.k in fixed) continue;
        if (f.type === 'split') { try { out[f.k] = readSplit(form, f.k); } catch (err) { toast(err.message, { kind: 'bad' }); return; } continue; }
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
  let [alertsRaw, bal, cash, debt, shared, upcoming, followups, catSpend, uncat, lastTxn, debtRows, itemSplits] = await Promise.all([
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
    q(sb.from('debts').select('current_balance, split, arrears_amount').eq('status', 'active')),
    q(sb.from('recurring_items').select('id, split')),
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
  // each account counts by its split between household members
  const acctShare = id => shareFor(cache.accounts.find(x => x.id === id)?.split);
  const myCash = sum(cashAccts, a => Number(a.calculated_balance) * acctShare(a.id));
  const pName = personView === 'all' ? 'household' : personName();
  const splitOfItem = new Map(itemSplits.map(i => [i.item_id ?? i.id, i.split]));
  const upShare = u => Number(u.amount) * shareFor(splitOfItem.get(u.item_id));
  upcoming = upcoming.filter(u => upShare(u) > 0.004).map(u => ({ ...u, my_amount: upShare(u) }));
  const spendShare = shareFor(cache.settings?.default_split);
  const thisMonth = cash.find(c => c.month === monthStart) || {};
  // comparisons
  const transferIds = new Set(cache.categories.filter(c => c.kind === 'transfer').map(c => c.id));
  const d30 = new Date(Date.now() - 30 * 864e5).toLocaleDateString('en-CA');
  const cashIds = new Map(cashAccts.map(a => [a.id, a]));
  const change30 = sum(recent.filter(t => t.txn_date > d30 && cashIds.has(t.account_id)), t => Number(t.amount) * acctShare(t.account_id));
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
      <div class="tile"><div class="tile-label">Debt ${info('Everything owed: home loans (updated from your statements), power, Afterpay and other debts you entered. Shared debts count only the selected person\'s share.')}</div><div class="tile-value">${moneyCompact(sum(debtRows, x => x.current_balance * shareFor(x.split)))}</div>
        <div class="tile-sub">${esc(pName)}${sum(debtRows, x => x.arrears_amount * shareFor(x.split)) ? ` · overdue ${moneyRound(sum(debtRows, x => x.arrears_amount * shareFor(x.split)))}` : ''}</div></div>
    </div>

    ${true ? `<div class="chips">
      <button class="chip" data-go="insights">📈 4-week forecast & insights →</button>
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
  const names = { overall: 'Household', ...Object.fromEntries((r.members || []).map(m => [m.id, m.name])) };
  const draw = () => {
    const budgetWho = personView === 'all' || !r.people[personView] ? 'overall' : personView;
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
      <section class="card" id="b-budget"><p class="loading">Loading…</p></section>
      ${budgetWho !== 'overall' ? `<p class="hint">Each bill, income, debt and account has a "who pays" split — ${esc(names[budgetWho])}'s part is shown. Everyday spending uses the usual split from Setup. Money moved between members isn't counted.</p>` : ''}`;
    hbarChart($('#b-compare'), { items: [
      { label: 'Income', value: p.regular_in, color: SERIES.blue },
      { label: 'Bills', value: p.regular_out, color: SERIES.orange },
      { label: 'Debt repayments', value: p.debt_monthly, color: SERIES.orange },
    ], max: Math.max(p.regular_in, p.regular_out + p.debt_monthly, p.regular_out, p.debt_monthly, 1) });
    let spend = p.categories.filter(c => c.amount < 0).map(c => ({ label: c.name, value: -c.amount })).sort((a, b) => b.value - a.value);
    if (spend.length > 8) { const rest = spend.slice(7); spend = spend.slice(0, 7).concat([{ label: `Other (${rest.length})`, value: sum(rest, x => x.value) }]); }
    hbarChart($('#b-spend'), { items: spend, color: SERIES.orange, empty: 'No spending imported.' });
    if (spend.length) $('#b-spend').insertAdjacentHTML('beforeend', `<p class="hint total-line">Total ${money(p.actual_out)} per month · income ${money(p.actual_in)}</p>`);
    budgetEditor($('#b-budget')).catch(e => { $('#b-budget').innerHTML = `<p class="msg error">${esc(friendlyError(e))}</p>`; });

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
        await q(sb.from('shared_ledger').insert({ entry_date: r.txn_date, description: r.description, total_amount: Math.abs(r.amount), paid_by: 'me', my_share_pct: myDefaultPct() ?? 50, transaction_id: r.id }));
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
  const share = myDefaultPct();
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

// Check a scanned bill, then add it or update the matching bill
async function billForm(r) {
  const items = await q(sb.from('recurring_items').select('*').eq('direction', 'out').order('name'));
  const key = (r.match_text || r.biller || '').toUpperCase(), first = key.split(' ')[0];
  const match = items.find(i => i.match_text && key.includes(i.match_text.toUpperCase()))
    || items.find(i => i.match_text && i.match_text.toUpperCase().includes(key) && key.length >= 3)
    || (first.length >= 3 ? items.find(i => i.name.toUpperCase().includes(first)) : null);
  const cat = cache.categories.find(c => c.name === r.category);
  const noteBits = [r.biller_code ? `BPAY biller code ${r.biller_code}` : '', r.ref_last4 ? `ref ending ${r.ref_last4}` : '',
    r.period_start ? `bill for ${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}` : ''].filter(Boolean).join(', ');
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog"><h2>Check this bill</h2>
      <p class="hint">Read from <b>${esc(r.file || 'the bill')}</b>. Fix anything that's wrong before saving.</p>
      ${r.notes.length ? `<div class="callout ${r.overdue ? 'bad' : ''}">${r.notes.map(esc).join('<br>')}</div>` : ''}
      <div class="seg-list">
        ${match ? `<label class="inline"><input type="radio" name="mode" value="update" checked> Update <b>${esc(match.name)}</b> <span class="hint">(now ${money(match.amount)}, due ${esc(fmtDate(match.next_due))})</span></label>` : ''}
        <label class="inline"><input type="radio" name="mode" value="new" ${match ? '' : 'checked'}> Add as a new regular bill</label>
        <label class="inline"><input type="radio" name="mode" value="once"> Just this once (a one-off payment)</label>
      </div>
      <div class="formgrid">
        <label>Biller <input name="name" required value="${esc(match?.name || r.biller || '')}"></label>
        <label>Amount due <input name="amount" type="number" step="0.01" required value="${esc(r.amount ?? '')}"></label>
        <label>Due date <input name="next_due" type="date" required value="${esc(r.due_date || '')}"></label>
        <label>How often <select name="frequency">${FREQ.filter(f => f !== 'once').map(f => `<option value="${f}" ${f === (match?.frequency || r.frequency) ? 'selected' : ''}>${label(f)}</option>`).join('')}</select></label>
        <label>Category <select name="category_id" data-cat>${catOptions(match?.category_id || cat?.id, { blank: '— none —' })}</select></label>
        <label>Text on bank statement <span class="hint">to match the payment when you import</span><input name="match_text" value="${esc(match?.match_text || r.match_text || '')}"></label>
        <div class="full"><div class="field-label">Who pays</div>${splitEditor('split', match ? match.split : (cache.settings?.default_split ?? null))}</div>
        <label class="full">Notes <textarea name="notes" rows="2">${esc(noteBits)}</textarea></label>
      </div>
      <p class="hint">Only the last 4 digits of any reference are kept.</p>
      <div class="row"><button class="primary" value="save">Save</button><button value="cancel" formnovalidate>Cancel</button></div></form>`;
    document.body.appendChild(dlg);
    const f = $('form', dlg);
    f.querySelectorAll('select[data-cat]').forEach(sel => wireCatSelect(sel, () => {}));
    wireSplits(f);
    const freqSel = f.frequency;
    f.querySelectorAll('input[name=mode]').forEach(x => x.onchange = () => { freqSel.disabled = f.mode.value === 'once'; });
    f.addEventListener('submit', async e => {
      if (e.submitter?.value !== 'save') return;
      e.preventDefault();
      let split; try { split = readSplit(f, 'split'); } catch (err) { toast(err.message, { kind: 'bad' }); return; }
      const mode = f.mode.value;
      const row = { name: f.name.value.trim(), amount: Number(f.amount.value), next_due: f.next_due.value, frequency: mode === 'once' ? 'once' : freqSel.value,
        category_id: f.category_id.value || null, match_text: f.match_text.value.trim() || null, split, direction: 'out', is_active: true };
      const note = f.notes.value.trim();
      try {
        await busy(e.submitter, async () => {
          if (mode === 'update' && match) {
            const notes = [match.notes, note && `[${new Date().toLocaleDateString('en-AU')}: scanned bill — ${note}]`].filter(Boolean).join(' ');
            await q(sb.from('recurring_items').update({ ...row, notes }).eq('id', match.id));
          } else await q(sb.from('recurring_items').insert({ ...row, notes: note || null }));
        });
        toast(mode === 'update' ? `${row.name} updated: ${money(row.amount)} due ${fmtDate(row.next_due)}` : `${row.name} added: ${money(row.amount)} due ${fmtDate(row.next_due)}`, { ms: 5000 });
        dlg.close(); resolve(true);
      } catch { /* toast shown */ }
    });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(false); });
    dlg.showModal();
  });
}

async function importView() {
  const fresh = await q(sb.from('v_account_balances').select('id, name, last_transaction_date').eq('is_active', true));
  const freshHtml = fresh.length ? `<div class="chips">${fresh.map(a => { const d = a.last_transaction_date ? -daysFromToday(a.last_transaction_date) : null;
    return `<span class="chip"><span class="fresh"><span class="fresh-dot ${d == null || d > 14 ? 'stale' : d > 7 ? 'old' : ''}"></span>${esc(a.name)}: ${d == null ? 'no data yet' : 'up to ' + fmtDate(a.last_transaction_date)}</span></span>${(l => l ? `<a class="chip link-chip" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">Open ${esc(l.name)} ↗</a>` : '')(linkFor({ account_id: a.id }))}`; }).join('')}</div>` : '';
  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Import</h1><p class="hint">Add bank statements: CommBank or Westpac CSV, or the Westpac Account activity PDF.</p></div></div>${freshHtml}<div class="card"><h2>Choose files</h2>
    <p class="hint">Choose one or more files at once: <b>CSV</b> exports from CommBank or Westpac, or the <b>Account activity PDF</b> from the Westpac app.
    Each file is matched to an account (or a new account is set up for you). Importing the same dates twice is safe — duplicates are skipped.</p>
    <label>Statement files <input type="file" id="i-file" accept=".csv,text/csv,.pdf,application/pdf" multiple></label>
    <div id="i-preview"></div></div>
    <section class="card"><div class="sec-head"><div><h2>Scan a bill</h2><p class="hint">A PDF or a photo of a power, water, rates, phone or insurance bill. It reads the biller, amount, due date and billing period — you check them — then adds the bill or updates the one you already have. Read on this device; the file isn't uploaded.</p></div>
      <label class="button primary" style="margin:0">Choose bill<input type="file" id="b-file" accept="application/pdf,.pdf,image/*" hidden></label></div></section>
    <div class="card" id="i-history"></div>`;

  $('#b-file').onchange = async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    toast('Reading bill…', { ms: 60000 });
    try {
      const lines = await scanPayslipFile(file, (pc, msg) => toast(msg || `Reading bill… ${pc}%`, { ms: 60000 }), 'bill');
      const r = readBill(lines);
      toast('Done — check the details', { ms: 2500 });
      await billForm({ ...r, file: file.name });
    } catch (err) { toast(err.message || 'Could not read that file', { ms: 6000, kind: 'bad' }); }
  };

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
            split: j.joint ? (cache.settings?.default_split ?? null) : onlyFor(primaryId()) }).select().single());
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
      let extra = '';
      try { const r = await sb.rpc('refresh_insights'); const d = r.data || {};
        if (d.bounces_tagged) extra += `<li>${d.bounces_tagged} bounced payment${d.bounces_tagged > 1 ? 's' : ''} found and set aside (not counted as income or spending)</li>`;
        if (d.prices_updated) extra += `<li>${d.prices_updated} bill amount${d.prices_updated > 1 ? 's' : ''} updated to the new price — see the alerts on Home</li>`; } catch { /* insights are a bonus */ }
      results.push(extra);
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
  const names = personNames();
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
    ${isBills ? '' : '<div id="r-cl"></div>'}
    <section class="card" id="r-list"></section>`;


  const drawTop = async () => {
    const [itemsAll, up] = await Promise.all([
      q(sb.from('recurring_items').select('*').eq('direction', dir).eq('is_active', true)),
      q(sb.rpc('upcoming_items', { p_days: 35 })),
    ]);
    const items = itemsAll.filter(i => shareFor(i.split) > 0);
    const monthly = i => i.amount * PER_MONTH[i.frequency] * shareFor(i.split);
    const pm = sum(items, monthly);
    const allItems = await q(sb.from('recurring_items').select('id, split'));
    const splitOfItem = new Map(allItems.map(i => [i.id, i.split]));
    const upShare = u => Number(u.amount) * shareFor(splitOfItem.get(u.item_id));
    const mine = up.filter(u => u.direction === dir && upShare(u) > 0.004);
    const late = mine.filter(u => u.overdue);
    const pmFor = who => sum(itemsAll, i => i.amount * PER_MONTH[i.frequency] * shareFor(i.split, who));
    $('#r-tiles').innerHTML = personView === 'all' ? `
      <div class="tile"><div class="tile-label">${isBills ? 'Bills' : 'Income'} per month ${info('Every regular item converted to a monthly amount: weekly × 52 ÷ 12, fortnightly × 26 ÷ 12, quarterly ÷ 3, yearly ÷ 12.')}</div><div class="tile-value">${moneyRound(pm)}</div><div class="tile-sub">household${isBills ? ', including loan repayments' : ''}</div></div>
      ${cache.members.length > 1 ? cache.members.slice(0, 4).map(m => `<div class="tile"><div class="tile-label">${esc(memberName(m))}</div><div class="tile-value">${moneyRound(pmFor(m.id))}</div><div class="tile-sub">per month</div></div>`).join('') : ''}
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
        note: shareFor(i.split) < 1 ? `${Math.round(shareFor(i.split) * 100)}% of ${money(i.amount * PER_MONTH[i.frequency])}` : null }))
      .sort((x, y) => y.value - x.value), color: isBills ? SERIES.orange : SERIES.blue, empty: `No ${isBills ? 'bills' : 'income'} for ${whoName}.` });
    if (items.length) $('#r-chart').insertAdjacentHTML('beforeend', `<p class="hint total-line">Total ${money(pm)} per month</p>`);
  };
  let rows = [];
  const drawList = async () => {
    rows = await renderCrud($('#r-list'), kind, {
      filter: { direction: dir }, title: personView === 'all' ? (isBills ? 'All bills' : 'All income') : `${whoName}'s ${isBills ? 'bills' : 'income'}`,
      subtitle: personView === 'all' ? '' : `Shared items show ${esc(whoName)}'s part. Change who pays with Edit → Who pays.`,
      rowFilter: r => shareFor(r.split) > 0,
      headers: { who_month: personView === 'all' ? 'Per month' : `${whoName} / month` },
      onChange: async () => { await drawTop(); await drawList(); },
      extra: (r, i) => isBills && r.is_active ? `<button class="small b-paid" data-i="${i}">Paid</button>` : '',
    });
    $('#r-list').querySelectorAll('.b-paid').forEach(b => b.onclick = () => { const r = rows[b.dataset.i]; markPaid(r.id, r.next_due, () => recurringPage(kind)); });
  };
  await Promise.all([drawTop(), drawList(), isBills ? null : renderCentrelink($('#r-cl'))]);
}
const bills = () => { store.set('visitedBills', true); return recurringPage('bills'); };
const income = () => recurringPage('income');

// ---------- DEBTS ----------
async function debts() {
  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Debts</h1><div class="who-now inline">${esc(personName())}</div><p class="hint">Everything owed, with a log of every call to creditors. Home loan balances update when you import.</p></div></div>
    <div class="tiles" id="d-sum"></div>
    <section class="card"><div class="sec-head"><div><h2>Who you owe</h2><p class="hint">${personView === 'all' ? 'Household balances' : esc(personName()) + "'s share of each balance"} · the long bars are the home loans</p></div></div><div id="d-chart"></div></section>
    <section class="card" id="d-list"></section><section class="card hidden" id="d-inst"></section><section class="card hidden" id="d-log"></section>`;
  const instalments = async () => {
    const box = $('#d-inst');
    const rows = await q(sb.from('debt_instalments').select('id, debt_id, due_date, merchant, amount, is_paid, auto_matched').order('due_date').order('merchant').limit(1000));
    if (!rows.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const names = Object.fromEntries(cache.debts.map(d => [d.id, d.creditor]));
    const days = {};
    rows.forEach(r => (days[r.due_date] ||= []).push(r));
    const owing = rows.filter(r => !r.is_paid);
    const in30 = sum(owing.filter(r => r.due_date <= new Date(Date.now() + 30 * 864e5).toLocaleDateString('en-CA')), r => Number(r.amount));
    box.innerHTML = `<div class="sec-head"><div><h2>Instalments still to pay</h2><p class="hint">${owing.length} left · ${money(sum(owing, r => Number(r.amount)))} in total · ${money(in30)} in the next 30 days. Tick one when it's paid; the debt balance follows.</p></div></div>` +
      Object.entries(days).map(([d, list], i) => `<details ${i < 2 ? 'open' : ''}><summary><strong>${esc(shortDate(d))}</strong> · ${money(sum(list.filter(r => !r.is_paid), r => Number(r.amount)))} · ${list.length} payment${list.length === 1 ? '' : 's'}</summary>
        <table class="rpt-tbl"><tbody>${list.map(r => `<tr><td><label><input type="checkbox" class="inst-paid" data-id="${r.id}" data-debt="${r.debt_id}" ${r.is_paid ? 'checked' : ''}> ${esc(r.merchant)}${r.auto_matched ? ' <span class="tag" title="Matched to a bank payment. Untick to undo.">auto-matched</span>' : ''}</label></td><td class="num">${money(r.amount)}</td></tr>`).join('')}</tbody></table></details>`).join('');
    box.querySelectorAll('.inst-paid').forEach(c => c.onchange = async () => {
      await q(sb.from('debt_instalments').update(c.checked ? { is_paid: true, paid_on: today(), match_ignored: false } : { is_paid: false, paid_on: null, matched_txn_id: null, auto_matched: false, match_ignored: true }).eq('id', c.dataset.id));
      const left = await q(sb.from('debt_instalments').select('amount').eq('debt_id', c.dataset.debt).eq('is_paid', false));
      await q(sb.from('debts').update({ current_balance: sum(left, r => Number(r.amount)), balance_as_at: today() }).eq('id', c.dataset.debt));
      await instalments(); await top(); await list();
    });
  };
  const top = async () => {
    const [d, allRows] = await Promise.all([q(sb.from('v_debt_summary').select('*').maybeSingle()), q(sb.from('debts').select('*').eq('status', 'active').order('current_balance', { ascending: false }))]);
    const sd = d || {};
    const f = x => shareFor(x.split);
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
      rowFilter: r => shareFor(r.split) > 0,
      subtitle: personView === 'all' ? '' : 'Balances in this list are the full amounts; the tiles and chart above show ' + esc(personName()) + "'s share.",
      onChange: async () => { await top(); await list(); },
      extra: (r, i) => `<button class="small log" data-i="${i}">Calls</button>${(l => l ? `<a class="button small" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="${esc(l.name)}">Website ↗</a>` : '')(linkFor({ debt_id: r.id }))}`,
    });
    $('#d-list').querySelectorAll('.log').forEach(b => b.onclick = () => showLog(current[b.dataset.i]));
  };
  try { await sb.rpc('match_instalments', { p_owner: session.user.id }); } catch { /* matching also runs on import and every morning */ }
  await Promise.all([top(), list(), instalments()]);
}


// ---------- BUDGET EDITOR (monthly limit per category vs this month's spending) ----------
async function budgetEditor(box) {
  const m0 = today().slice(0, 7) + '-01';
  const [cats, tx] = await Promise.all([
    q(sb.from('categories').select('id, name, monthly_budget, sort_order').eq('kind', 'expense').order('sort_order').order('name')),
    q(sb.from('transactions').select('category_id, amount').gte('txn_date', m0).lt('amount', 0).eq('is_one_off', false).limit(5000)),
  ]);
  const spent = {};
  tx.forEach(t => { if (t.category_id) spent[t.category_id] = (spent[t.category_id] || 0) - Number(t.amount); });
  const rows = cats.filter(c => !/^bounced/i.test(c.name)).map(c => ({ ...c, b: c.monthly_budget == null ? null : Number(c.monthly_budget), s: spent[c.id] || 0 }));
  const used = rows.filter(r => r.b != null || r.s > 0).sort((x, y) => (y.b != null) - (x.b != null) || y.s - x.s);
  const rest = rows.filter(r => !used.includes(r));
  const set = rows.filter(r => r.b > 0);
  const row = r => {
    const pct = r.b > 0 ? r.s / r.b * 100 : 0;
    const left = r.b > 0 ? r.b - r.s : null;
    return `<tr><td data-label="Category">${esc(r.name)}${r.b > 0 ? `<div class="progress sm" aria-hidden="true"><span style="width:${Math.min(100, pct)}%;${pct > 100 ? 'background:var(--bad)' : pct > 85 ? 'background:var(--warn)' : ''}"></span></div>` : ''}</td>
      <td class="num" data-label="This month">${money(r.s)}</td>
      <td class="num" data-label="Monthly budget"><input type="number" min="0" step="1" inputmode="decimal" class="bud" data-id="${r.id}" value="${r.b ?? ''}" placeholder="—" aria-label="Monthly budget for ${esc(r.name)}"></td>
      <td class="num ${left != null && left < 0 ? 'neg' : ''}" data-label="Left">${left == null ? '<span class="hint">—</span>' : left >= 0 ? money(left) : `over ${money(-left)}`}</td></tr>`;
  };
  const table = list => `<div class="tablewrap"><table class="list"><thead><tr><th>Category</th><th class="num">This month</th><th class="num">Budget / month</th><th class="num">Left</th></tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>`;
  const tb = sum(set, r => r.b), ts = sum(set, r => r.s);
  box.innerHTML = `<div class="sec-head"><div><h2>Budget by category</h2><p class="hint">Set a monthly limit; the bar shows this month so far. One-offs and bounced payments aren't counted.</p></div></div>
    ${set.length ? `<p class="callout ${ts > tb ? 'bad' : 'good'}">Budgeted categories: <b>${money(ts)}</b> spent of <b>${money(tb)}</b>${ts > tb ? ` — over by ${money(ts - tb)}` : ` — ${money(tb - ts)} left`}.</p>` : ''}
    ${table(used)}
    ${rest.length ? `<details class="fold"><summary><span class="hint">${rest.length} more categories with no spending this month</span></summary>${table(rest)}</details>` : ''}`;
  box.querySelectorAll('input.bud').forEach(i => i.onchange = async () => {
    const v = i.value === '' ? null : Math.max(0, Number(i.value));
    await q(sb.from('categories').update({ monthly_budget: v }).eq('id', i.dataset.id));
    const c = cache.categories.find(x => x.id === i.dataset.id); if (c) c.monthly_budget = v;
    toast('Budget saved'); budgetEditor(box);
  });
}

// ---------- GOALS (buffer, catch up on arrears, pay-down order) ----------
const CASH_TYPES = ['transaction', 'savings', 'offset', 'cash'];
const num = v => Number(v || 0);
function monthsToClear(balance, ratePct, monthlyPay) {
  if (!(monthlyPay > 0)) return null;
  const r = (ratePct || 0) / 1200;
  if (r === 0) return Math.ceil(balance / monthlyPay);
  if (monthlyPay <= r * balance) return Infinity;
  return Math.ceil(-Math.log(1 - r * balance / monthlyPay) / Math.log(1 + r));
}
const monthsWord = m => m == null ? '—' : m === Infinity ? 'not at this payment' : m < 12 ? `${m} mo` : `${Math.floor(m / 12)} yr${m % 12 ? ' ' + (m % 12) + ' mo' : ''}`;

async function goals() {
  const [bals, ds, gs, st] = await Promise.all([
    q(sb.from('v_account_balances').select('name, account_type, calculated_balance').eq('is_active', true)),
    q(sb.from('debts').select('*').eq('status', 'active')),
    q(sb.from('goals').select('*').eq('goal_type', 'catch_up')),
    q(sb.from('settings').select('buffer_target').maybeSingle()),
  ]);
  const target = num(st?.buffer_target ?? 1000);
  const cash = sum(bals.filter(b => CASH_TYPES.includes(b.account_type)), b => b.calculated_balance);
  const pct = target > 0 ? Math.max(0, Math.min(100, cash / target * 100)) : 0;

  // catch-up on arrears
  const arrears = ds.filter(d => num(d.arrears_amount) > 0).sort((x, y) => num(y.arrears_amount) - num(x.arrears_amount));
  const cleared = gs.filter(g => g.status === 'active' && ds.some(d => d.id === g.debt_id && num(d.arrears_amount) <= 0));
  cleared.forEach(g => sb.from('goals').update({ status: 'achieved' }).eq('id', g.id).then(() => {}));
  const catchRow = d => {
    const g = gs.find(x => x.debt_id === d.id && x.status === 'active');
    const owing = num(d.arrears_amount), tgt = Math.max(num(g?.target_amount), owing);
    const done = tgt > 0 ? Math.max(0, tgt - owing) / tgt * 100 : 0;
    let need = '<span class="hint">Pick a date to see the fortnightly amount.</span>';
    if (g?.target_date) {
      const days = daysFromToday(g.target_date);
      need = days <= 0 ? '<span class="neg">Date has passed — pick a new one.</span>' : `<b>${money(owing / Math.max(1, Math.ceil(days / 14)))}</b> a fortnight to clear by ${esc(fmtDate(g.target_date))}`;
    }
    return `<div class="goal"><div class="goal-top"><b>${esc(d.creditor)}</b><span class="num neg">${money(owing)} overdue</span></div>
      <div class="progress" aria-hidden="true"><span style="width:${done}%"></span></div>
      <div class="goal-bot"><span>${need}</span><label class="inline">Clear by <input type="date" class="g-date" data-debt="${d.id}" value="${esc(g?.target_date || '')}"></label></div></div>`;
  };

  // pay-down order: overdue first (biggest first), then highest interest, then smallest balance
  const live = ds.filter(d => num(d.current_balance) > 0);
  const order = [...live].sort((x, y) => (num(y.arrears_amount) > 0) - (num(x.arrears_amount) > 0)
    || (num(x.arrears_amount) > 0 ? num(y.arrears_amount) - num(x.arrears_amount) : num(y.interest_rate_pct) - num(x.interest_rate_pct) || num(x.current_balance) - num(y.current_balance)));
  const missing = ds.filter(d => num(d.current_balance) <= 0 && d.debt_type !== 'bnpl');
  const payRow = (d, i) => {
    const pay = num(d.min_payment) * (PER_MONTH[d.payment_frequency || 'monthly'] || 0);
    const why = num(d.arrears_amount) > 0 ? 'Overdue — clear first' : num(d.interest_rate_pct) > 0 ? 'Highest interest next' : 'No interest — smallest first';
    return `<tr><td class="num" data-label="#">${i + 1}</td><td data-label="Debt"><b>${esc(d.creditor)}</b><div class="hint">${why}</div></td>
      <td class="num" data-label="Owing">${money(d.current_balance)}</td><td class="num" data-label="Rate">${d.interest_rate_pct != null ? num(d.interest_rate_pct) + '%' : '—'}</td>
      <td class="num" data-label="Repay / month">${pay ? money(pay) : '—'}</td>
      <td class="num" data-label="Time to clear">${d.debt_type === 'bnpl' ? '<span class="hint">scheduled</span>' : monthsWord(monthsToClear(num(d.current_balance), num(d.interest_rate_pct), pay))}</td></tr>`;
  };

  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Goals</h1><p class="hint">Build a buffer, catch up on overdue amounts, then work down the debts in order</p></div></div>
    <section class="card"><div class="sec-head"><div><h2>1 · Buffer</h2><p class="hint">Cash on hand across everyday, savings and offset accounts</p></div></div>
      <div class="goal-top"><span class="tile-value">${money(cash)}</span><span class="hint">target ${money(target)}</span></div>
      <div class="progress" aria-hidden="true"><span style="width:${pct}%"></span></div>
      <p class="callout ${cash >= target ? 'good' : cash < 0 ? 'bad' : ''}">${cash < 0 ? `Overdrawn by ${money(-cash)} across your accounts — that comes before any buffer.` : cash >= target ? 'Buffer target reached ✓' : `${money(target - cash)} to go.`}</p>
      <div class="row"><label class="inline">Buffer target <input type="number" id="g-target" min="0" step="50" value="${target}"></label><button class="small" id="g-target-save">Save</button></div></section>
    <section class="card"><div class="sec-head"><div><h2>2 · Catch up on overdue amounts</h2><p class="hint">Amounts entered as arrears under Debts</p></div></div>
      ${arrears.length ? arrears.map(catchRow).join('') : '<p class="callout good">Nothing overdue recorded ✓ <span class="hint">If a creditor says otherwise, enter the overdue amount on that debt under Debts.</span></p>'}
      ${cleared.length ? `<p class="hint">Cleared: ${cleared.map(g => esc(g.name.replace(/^Clear arrears — /, ''))).join(', ')} ✓</p>` : ''}</section>
    <section class="card"><div class="sec-head"><div><h2>3 · Pay-down order</h2><p class="hint">Overdue first, then highest interest, then smallest balance. Keep every minimum going; put any extra on #1.</p></div></div>
      ${order.length ? `<div class="tablewrap"><table class="list"><thead><tr><th class="num">#</th><th>Debt</th><th class="num">Owing</th><th class="num">Rate</th><th class="num">Repay / month</th><th class="num">Time to clear</th></tr></thead><tbody>${order.map(payRow).join('')}</tbody></table></div>` : '<p class="empty">No debts with a balance.</p>'}
      ${missing.length ? `<p class="hint">Balance not entered, so not ranked: ${missing.map(d => esc(d.creditor)).join(', ')}. Add it under Debts.</p>` : ''}
      <p class="hint">Time to clear assumes the repayment shown and the entered rate; it is a guide only.</p></section>`;
  $('#g-target-save').onclick = async () => {
    const v = Number($('#g-target').value);
    if (!(v >= 0)) return toast('Enter a target of $0 or more');
    await q(sb.from('settings').update({ buffer_target: v }).eq('owner_id', session.user.id));
    cache.settings = { ...cache.settings, buffer_target: v }; toast('Buffer target saved'); goals();
  };
  view.querySelectorAll('.g-date').forEach(i => i.onchange = async () => {
    const d = ds.find(x => x.id === i.dataset.debt), g = gs.find(x => x.debt_id === d.id && x.status === 'active'), owing = num(d.arrears_amount);
    if (g) await q(sb.from('goals').update({ target_date: i.value || null, target_amount: Math.max(num(g.target_amount), owing) }).eq('id', g.id));
    else await q(sb.from('goals').insert({ name: `Clear arrears — ${d.creditor}`, goal_type: 'catch_up', debt_id: d.id, target_amount: owing, target_date: i.value || null, priority: d.priority }));
    toast('Saved'); goals();
  });
}

// ---------- INSIGHTS (worked out from the transactions; refreshed every morning and after each import) ----------
const SUB_FREQ = { weekly: 'weekly', fortnightly: 'fortnightly', 'every 3 weeks': 'every 3 weeks', monthly: 'monthly', quarterly: 'quarterly', yearly: 'yearly' };
const shortDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
async function insightsView() {
  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Insights</h1>
      <p class="hint">Worked out automatically from your transactions — refreshed every morning and after each import. Household figures.</p></div></div>
    <div class="tiles" id="n-tiles"></div>
    <section class="card"><div class="sec-head"><div><h2>Next 4 weeks</h2><p class="hint" id="n-fc-hint"></p></div></div><div id="n-fc"></div><p class="hint" id="n-fc-note"></p></section>
    <div class="grid2">
      <section class="card" id="n-bounce"></section>
      <section class="card" id="n-fees"></section>
    </div>
    <section class="card" id="n-subs"></section>
    <div class="grid2">
      <section class="card" id="n-price"></section>
      <section class="card" id="n-spike"></section>
    </div>
    <section class="card" id="n-bnpl"></section>
    <section class="card" id="n-dup"></section>`;
  try { await sb.rpc('refresh_insights'); } catch { /* still show what we have */ }
  const ins = await q(sb.rpc('insights', { p_days: 28 }));
  const fc = ins.forecast, days = fc.days || [];
  const low = days.reduce((a, d) => (!a || Number(d.bal) < Number(a.bal) ? d : a), null);
  const nextIn = fc.next_income;
  const untilPay = days.filter(d => !nextIn || d.d < nextIn);
  const safe = untilPay.length ? Math.max(0, Math.min(Number(fc.start), ...untilPay.map(d => Number(d.bal)))) : Number(fc.start);
  const overdueTotal = sum(fc.overdue, o => o.amount);
  $('#n-tiles').innerHTML = `
    <div class="tile"><div class="tile-label">Money in everyday accounts ${info('CommBank and Westpac Choice added together, as at your last import. Loan accounts are not included.')}</div><div class="tile-value">${moneyRound(fc.start)}</div><div class="tile-sub">household, now</div></div>
    <div class="tile ${low && low.bal < 0 ? 'bad' : 'good'}"><div class="tile-label">Lowest point, next 4 weeks ${info('Your balance today, plus income and bills when they are due, minus your usual everyday spending each day. Below $0 means overdrawn fees ($15 each) unless you move money or spend less.')}</div><div class="tile-value">${low ? moneyRound(low.bal) : '—'}</div><div class="tile-sub">${low ? 'around ' + esc(shortDate(low.d)) : ''}</div></div>
    <div class="tile ${safe > 0 ? 'good' : 'warn'}"><div class="tile-label">Safe to spend before next pay ${info('How much extra you could spend today and still not go below $0 before the next income arrives — after bills and your usual daily spending.')}</div><div class="tile-value">${moneyRound(safe)}</div><div class="tile-sub">${nextIn ? 'next money in ' + esc(shortDate(nextIn)) : 'no regular income set up'}</div></div>
    <div class="tile"><div class="tile-label">Everyday spending ${info('Average per day over the last 90 days of spending that isn’t a regular bill: shopping, food, fuel, Afterpay and so on. One-offs you have marked are left out.')}</div><div class="tile-value">${moneyRound(fc.daily_spend)}<small> /day</small></div><div class="tile-sub">about ${moneyRound(fc.daily_spend * 7)} a week</div></div>`;
  const firstNeg = days.find(d => Number(d.bal) < 0);
  $('#n-fc-hint').textContent = low && low.bal < 0
    ? `Likely to go below $0 from around ${shortDate(firstNeg.d)} (lowest ${moneyRound(low.bal)} around ${shortDate(low.d)}). Spending about ${moneyRound(Math.ceil(-low.bal / (days.indexOf(low) + 1) / 5) * 5)} a day less, or moving money in before then, avoids overdrawn fees.`
    : 'Your balance stays above $0 on the current plan.';
  lineChart($('#n-fc'), { title: 'Forecast balance', points: days.map(d => ({ value: Number(d.bal),
    label: new Date(d.d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }), tipLabel: shortDate(d.d),
    extra: (d.items || []).map(i => `<div>${i.amount > 0 ? '+' : '−'}${esc(money(Math.abs(i.amount)))} ${esc(i.name)}</div>`).join('') })) });
  $('#n-fc-note').innerHTML = `Includes regular bills and income paid into everyday accounts, and ${moneyRound(fc.daily_spend)} a day of usual spending. Board paid straight into the loan isn’t counted.`
    + (fc.overdue.length ? ` <b>Not included: ${fc.overdue.length} overdue item${fc.overdue.length > 1 ? 's' : ''} (${moneyRound(overdueTotal)})</b> — ${fc.overdue.map(o => esc(o.name)).join(', ')}.` : '');

  // bounced payments
  const b = ins.bounces || [];
  $('#n-bounce').innerHTML = `<div class="sec-head"><div><h2>Bounced payments</h2><p class="hint">Direct debits returned for lack of funds · last 12 months</p></div></div>
    ${b.length ? `<ul class="ins-list">${b.map(x => `<li><b>${esc(x.payee.replace(/\b\w+/g, w => w[0] + w.slice(1).toLowerCase()) || 'Unknown')}</b><span class="ins-amt">${x.n}×</span>
      <p class="hint">${moneyRound(x.total)} returned · last ${esc(fmtDate(x.last))}${x.recent ? ` · <span class="pill bad">${x.recent} in the last 90 days</span>` : ''}</p></li>`).join('')}</ul>
      <p class="hint">These are set aside automatically, so they don’t count as income or spending. Each bounce can bring a dishonour fee from the company — if one keeps bouncing, ask them to move the debit to the day after payday.</p>`
      : '<p class="empty">No bounced payments. 👍</p>'}`;

  // fees
  const fees = ins.fees.by_type || [], od = ins.fees.days_overdrawn || [];
  $('#n-fees').innerHTML = `<div class="sec-head"><div><h2>Bank fees</h2><p class="hint">Last 12 months</p></div></div>
    ${fees.length ? `<ul class="ins-list">${fees.map(f => `<li><b>${esc(f.kind)}</b><span class="ins-amt">${money(f.total)}</span><p class="hint">${f.n} charge${f.n > 1 ? 's' : ''}</p></li>`).join('')}</ul>` : '<p class="empty">No bank fees.</p>'}
    ${od.length ? `<p class="hint">Days overdrawn: ${od.map(o => `${esc(o.account)} <b>${o.days}</b> (lowest ${money(o.lowest)})`).join(' · ')}.</p>` : ''}
    ${fees.some(f => f.kind === 'Loan package fee') ? '<p class="hint">The loan package fee is worth questioning: ask Westpac whether a no-fee loan with the same rate is available, or what the package actually saves you.</p>' : ''}`;

  // subscriptions & repeat charges
  const subs = ins.subscriptions || [];
  const act = subs.filter(x => x.active), untracked = act.filter(x => !x.tracked);
  $('#n-subs').innerHTML = `<div class="sec-head"><div><h2>Subscriptions & repeat charges</h2><p class="hint">Same amount to the same place at regular intervals · ${act.length} still active, about ${moneyRound(sum(act, x => x.yearly))} a year${untracked.length ? ` · <b>${untracked.length} not set up as bills</b>` : ''}</p></div></div>
    ${subs.length ? `<div class="tablewrap"><table class="list"><thead><tr><th>Paid to</th><th class="num">Amount</th><th>How often</th><th class="num">Per year</th><th>Last charged</th><th></th></tr></thead><tbody>
      ${subs.map((x, i) => `<tr class="${x.active ? '' : 'muted'}"><td data-label="Paid to">${esc(x.payee.replace(/\b\w+/g, w => w.length <= 4 && /^[A-Z]+$/.test(w) && !/^(BIG|THE|AND)$/.test(w) ? w : w[0] + w.slice(1).toLowerCase()))}</td><td class="num" data-label="Amount">${money(x.avg)}</td><td data-label="How often">${esc(SUB_FREQ[x.freq] || x.freq)} <span class="hint">(${x.n}×)</span></td>
        <td class="num" data-label="Per year">${moneyRound(x.yearly)}</td><td data-label="Last charged">${esc(fmtDate(x.last))}</td>
        <td>${!x.active ? '<span class="pill">stopped</span>' : x.tracked ? '<span class="pill good">a bill</span>' : `<button class="small add-bill" data-i="${i}">Add as bill</button>`}</td></tr>`).join('')}
      </tbody></table></div><p class="hint">Not sure what one is? Search it in Transactions. Apple charges are app or iCloud subscriptions — check Settings → your name → Subscriptions on the iPhone to cancel.</p>`
      : '<p class="empty">No repeat charges found yet.</p>'}`;
  $('#n-subs').querySelectorAll('.add-bill').forEach(btn => btn.onclick = async () => {
    const x = subs[btn.dataset.i];
    const freq = x.freq === 'every 3 weeks' ? 'monthly' : x.freq;
    const next = new Date(x.last + 'T00:00:00'); next.setDate(next.getDate() + Number(x.gap));
    while (next.toLocaleDateString('en-CA') < today()) next.setDate(next.getDate() + Number(x.gap));
    const name = x.payee.replace(/\b\w+/g, w => w[0] + w.slice(1).toLowerCase());
    const ok = await openForm('recurring_items', null, { direction: 'out' }, { name, amount: x.avg, frequency: freq, next_due: next.toLocaleDateString('en-CA'),
      match_text: x.payee.split(' ').slice(0, 2).join(' '), split: cache.settings?.default_split ?? null, is_active: true });
    if (ok) insightsView();
  });

  // price changes
  const pc = ins.price_changes || [];
  $('#n-price').innerHTML = `<div class="sec-head"><div><h2>Bills that changed price</h2><p class="hint">First payment this year vs now · bill amounts update themselves</p></div></div>
    ${pc.length ? `<ul class="ins-list">${pc.map(x => { const up = x.now_amt > x.first_amt, pct = Math.round((x.now_amt / x.first_amt - 1) * 100);
      return `<li><b>${esc(x.name)}</b><span class="ins-amt">${money(x.first_amt)} → ${money(x.now_amt)}</span>
      <p class="hint"><span class="pill ${up ? 'bad' : 'good'}">${up ? '▲' : '▼'} ${Math.abs(pct)}%</span> ${up ? 'Worth a call to ask for a better price or a hardship rate.' : ''}</p></li>`; }).join('')}</ul>` : '<p class="empty">No price changes found.</p>'}`;

  // spending spikes
  const sp = ins.spikes || [];
  $('#n-spike').innerHTML = `<div class="sec-head"><div><h2>Higher than usual this month</h2><p class="hint">So far this month vs the average of the last 3 months</p></div></div>
    ${sp.length ? `<div id="n-spike-chart"></div>` : '<p class="empty">Nothing unusual this month.</p>'}`;
  if (sp.length) hbarChart($('#n-spike-chart'), { items: sp.map(x => ({ label: x.category, value: Number(x.mtd), note: `usually about ${moneyRound(x.avg3)} a month` })), color: SERIES.orange });

  // BNPL load
  const bn = (ins.bnpl || []).filter(x => x.bnpl || x.income);
  const last6 = bn.slice(-6), pct6 = sum(last6, x => x.income) ? Math.round(sum(last6, x => x.bnpl) / sum(last6, x => x.income) * 100) : null;
  $('#n-bnpl').innerHTML = `<div class="sec-head"><div><h2>Afterpay & buy-now-pay-later</h2><p class="hint">Repayments each month next to income${pct6 != null ? ` · over the last 6 months BNPL took <b>${pct6}%</b> of income` : ''}</p></div></div><div id="n-bnpl-chart"></div>
    <p class="hint">BNPL repayments come out automatically and are the biggest part of your everyday spending. Pausing new purchases for a few weeks is the quickest way to stop the balance dipping below $0.</p>`;
  if (bn.length) columnChart($('#n-bnpl-chart'), { title: 'BNPL vs income', labels: bn.map(x => new Date(x.month + '-01T00:00:00').toLocaleDateString('en-AU', { month: 'short' })),
    tipLabels: bn.map(x => new Date(x.month + '-01T00:00:00').toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })),
    series: [{ name: 'Income', color: SERIES.blue, values: bn.map(x => Number(x.income) || 0) }, { name: 'BNPL repayments', color: SERIES.orange, values: bn.map(x => Number(x.bnpl) || 0) }] });

  // possible double charges
  const dup = ins.duplicates || [];
  $('#n-dup').innerHTML = `<div class="sec-head"><div><h2>Possible double charges</h2><p class="hint">Same amount, same place, a day apart · last 12 months</p></div></div>
    ${dup.length ? `<ul class="ins-list">${dup.map(x => `<li><b>${esc(x.description)}</b><span class="ins-amt">${money(x.amount)} × 2</span><p class="hint">${esc(fmtDate(x.d))} · ${esc(x.account)} — if you only bought it once, ask for a refund (for Apple: reportaproblem.apple.com).</p></li>`).join('')}</ul>` : '<p class="empty">None found.</p>'}`;
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
  taxWho = personView === 'all' ? (memberById(taxWho) ? taxWho : primaryId()) : personView;
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
  // the interest category is the one holding the interest (renamed "Loan interest (not counted)"), not an empty duplicate
  const interestCat = cache.categories.filter(c => /^loan interest/i.test(c.name)).sort((a, b) => (b.kind === 'transfer') - (a.kind === 'transfer'))[0];
  const loans = cache.accounts.filter(a => ['mortgage', 'loan'].includes(a.account_type));
  const boardTx = txns.filter(t => boardCat && t.category_id === boardCat.id && t.amount > 0);
  const boardItem = boardItems.filter(i => boardCat && i.category_id === boardCat.id && i.is_active);

  const defaults = {
    split: boardItem.length ? boardItem[0].split : null,
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
    const share = shareFor(st.split, taxWho);
    const who = personName(taxWho);
    const fromDate = st.rented_from || boardTx[0]?.txn_date || null;   // blank = from the first board payment
    const rFrom = fromDate && fromDate > fyStart ? fromDate : fyStart;
    const rTo = st.rented_to && st.rented_to < periodEnd ? st.rented_to : periodEnd;
    const periodDays = dayDiff(fyStart, periodEnd);
    const rentedDays = fromDate ? Math.max(0, dayDiff(rFrom, rTo)) : 0;
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
          <div class="seg big ${cache.members.length < 2 ? 'hidden' : ''}" role="tablist">${cache.members.map(m => [m.id, memberName(m)]).map(([k, v]) => `<button class="${taxWho === k ? 'on' : ''}" data-taxwho="${k}" role="tab" aria-selected="${taxWho === k}">${esc(v)}</button>`).join('')}</div>
          <select id="tax-fy" aria-label="Financial year" style="width:auto;margin:0">${fys.map(f => `<option ${f === taxFy ? 'selected' : ''} value="${f}">FY ${f.slice(0, 4)}–${f.slice(5)}${f === fyOf(today()) ? ' (so far)' : ''}</option>`).join('')}</select>
        </div></div>

      ${floor == null ? `<div class="alert warning"><span class="alert-icon">•</span><div><b>Set the share of the home the boarders use</b><div class="hint">Fill in "Home used by boarders" in <b>Settings</b> further down — claimable costs can't be worked out without it.</div></div><span></span></div><br>` : ''}

      <div class="tiles">
        <div class="tile"><div class="tile-label">Board received — ${esc(who)}</div><div class="tile-value">${moneyRound(incomeMine)}</div><div class="tile-sub">${Math.round(share * 100)}% of ${moneyRound(boardTotal)} · ${boardTx.length} payment${boardTx.length === 1 ? '' : 's'}</div></div>
        <div class="tile"><div class="tile-label">Claimable costs — ${esc(who)} ${info('Each ticked house cost × the share of the home the boarders use × the share of the year they lived there × this person\'s ownership share. This follows the ATO floor-area method — check it with Tax Help or a tax agent.')}</div><div class="tile-value">${moneyRound(claimMine)}</div><div class="tile-sub">${floor == null ? 'needs the floor-area %' : `${Math.round(factor * 1000) / 10}% of included costs`}</div></div>
        <div class="tile ${net < 0 ? 'good' : ''}"><div class="tile-label">Net rental ${net < 0 ? 'loss' : 'income'} ${info('Board received minus claimable costs. This is the estimate that goes in the rental section of the tax return.')}</div><div class="tile-value">${moneyRound(net)}</div><div class="tile-sub">what goes on the return (estimate)</div></div>
      </div>

      <div class="row no-print" style="margin-bottom:1rem"><button id="t-csv">Download for tax agent (CSV)</button><button id="t-print">Print</button></div>

      <section class="card"><div class="sec-head"><div><h2>Claim summary — ${esc(who)}</h2><p class="hint">FY ${taxFy.slice(0, 4)}–${taxFy.slice(5)} · ${Math.round(share * 100)}% share · ${floor == null ? 'floor-area % not set yet' : `${Math.round(factor * 1000) / 10}% of each counted cost`}</p></div></div>
        <div class="tablewrap"><table class="list rpt-tbl"><tbody>
          <tr class="grp"><td><b>Board received</b></td><td class="num"><b>${money(incomeMine)}</b></td></tr>
          ${candidates.filter(x => incl(x.id)).map(x => `<tr class="sub"><td>${esc(x.c.name.replace(' (not counted)', ''))}</td><td class="num">${money(x.total * factor * share)}</td></tr>`).join('')}
          ${extras.filter(e => e.kind === 'expense').map(e => `<tr class="sub"><td>${esc(e.description)} <span class="hint">(added)</span></td><td class="num">${money(e.amount * (e.apportion ? factor : 1) * share)}</td></tr>`).join('')}
          <tr class="grp"><td><b>Claimable costs</b></td><td class="num"><b>− ${money(claimMine)}</b></td></tr>
          <tr class="total"><td><b>Net rental ${net < 0 ? 'loss' : 'income'}</b></td><td class="num"><b>${money(net)}</b></td></tr>
        </tbody></table></div>
        <p class="hint">Change what counts in <b>Settings</b> further down.</p>
      </section>

      <div class="grid2">
        <section class="card"><div class="sec-head"><div><h2>Board received by month</h2><p class="hint">Household · ${esc(who)}'s share is ${Math.round(share * 100)}%</p></div></div>
          <div id="t-months"></div></section>

          <section class="card"><div class="sec-head"><div><h2>Centrelink check</h2><p class="hint">How much of the board Centrelink counts (lodging only, no meals)</p></div></div>
        <div id="t-cl"></div></section>
      </div>

      <h2 class="section-divider" id="t-settings">Settings <span class="hint">— adjust how it's worked out</span></h2>

      <section class="card"><div class="sec-head"><div><h2>Which house costs count</h2>
          <p class="hint">Tick the costs that are for the home. Only home-related costs count — not car insurance, food for yourselves, or personal items. Interest counts only on loans used to buy the home.</p></div></div>
        <div class="tablewrap"><table class="list"><thead><tr><th>Count?</th><th>Cost</th><th class="num">Paid this year</th><th class="num">Claimable (household)</th><th class="num">${esc(who)}</th></tr></thead><tbody>
          ${candidates.map(x => `<tr><td><input type="checkbox" class="t-cat" data-id="${x.id}" ${incl(x.id) ? 'checked' : ''} aria-label="Count ${esc(x.c.name)}"></td>
            <td>${esc(x.c.name.replace(' (not counted)', ''))}${interestCat && x.id === interestCat.id ? `<div class="hint">${loans.map(a => `<label class="mcheck" style="display:inline-block;margin-right:.8rem"><input type="checkbox" class="t-loan" data-id="${a.id}" ${st.included_loan_accounts.includes(a.id) ? 'checked' : ''}> ${esc(a.name)}</label>`).join('')}</div>` : ''}
              ${/insurance/i.test(x.c.name) ? '<div class="hint">only home &amp; contents / building insurance counts</div>' : ''}
              ${/^mortgage$/i.test(x.c.name) ? `<div class="hint ${incl(x.id) ? 'bad-text' : ''}">Repayments are mostly principal, which can’t be claimed — leave this unticked; the interest is counted under Loan interest.</div>` : ''}</td>
            <td class="num">${money(x.total)}</td><td class="num">${incl(x.id) ? money(x.total * factor) : '<span class="hint">—</span>'}</td><td class="num">${incl(x.id) ? money(x.total * factor * share) : '<span class="hint">—</span>'}</td></tr>`).join('')}
        </tbody><tfoot><tr class="total"><td></td><td><b>Total from bank data</b></td><td></td><td class="num"><b>${money(catClaim)}</b></td><td class="num"><b>${money(catClaim * share)}</b></td></tr></tfoot></table></div>
      </section>

      <section class="card" id="t-extras"></section>

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
            <label>Boarders there from <span class="hint">blank = first board payment${boardTx[0] ? ' (' + esc(fmtDate(boardTx[0].txn_date)) + ')' : ''}</span><input type="date" id="t-from" value="${esc(st.rented_from ?? '')}"></label>
            <label>Until <span class="hint">blank = still there</span><input type="date" id="t-to" value="${esc(st.rented_to ?? '')}"></label>
          </div>
          ${cache.members.length > 1 ? `<div class="field-label">Who owns the house and gets the board</div>${splitEditor('t-split', st.split)}` : ''}
          <p class="hint">Time: ${rentedDays} of ${periodDays} days${taxFy === fyOf(today()) ? ' so far this year' : ''} (${Math.round(timePct * 100)}%). Claimable share = ${floor == null ? '?' : Math.round(floor * 1000) / 10 + '%'} of the home × ${Math.round(timePct * 100)}% of the time${floor == null ? '' : ` = <b>${Math.round(factor * 1000) / 10}%</b> of each included cost`}.</p>
          <div class="row"><button class="primary" id="t-save">Save</button><span class="hint" id="t-saved"></span></div>
        </section>

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
    wireSplits(view);
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
        rented_from: $('#t-from').value || null, rented_to: $('#t-to').value || null });
      try { st.split = readSplit(view, 't-split'); } catch (err) { toast(err.message, { kind: 'bad' }); return; }
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
      rented_from: st.rented_from, rented_to: st.rented_to, split: st.split ?? null, included_categories: st.included_categories,
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
  const v = k => row?.[k] ?? scan?.fields?.[k] ?? '';
  const num = (k, lbl, hint = '') => `<label>${lbl}${hint ? ` <span class="hint">${hint}</span>` : ''}<input type="number" step="0.01" min="0" name="${k}" value="${esc(v(k))}"></label>`;
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog"><h2>${row ? 'Edit' : scan ? 'Check scanned' : 'Add'} payslip</h2>
      ${scan ? `<p class="callout ${scan.found.size ? 'good' : 'bad'}">${scan.found.size ? `Read <b>${scan.found.size}</b> value${scan.found.size === 1 ? '' : 's'} from <b>${esc(scan.file)}</b> — they're outlined in green. <b>Check every number against the payslip</b>, fill any blanks, then Save.` : ''}${scan.notes.map(n => `<br>• ${esc(n)}`).join('')}</p>` : ''}
      <div class="formgrid">
        <label>Whose payslip <select name="member_id">${cache.members.map(m => `<option value="${m.id}">${esc(memberName(m))}</option>`).join('')}</select></label>
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
    f.member_id.value = row?.member_id || (personView !== 'all' ? personView : primaryId());
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
      out.person = out.member_id === primaryId() ? 'me' : 'partner';
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
async function scanPayslipFile(file, progress, what = 'payslip') {
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
  throw new Error(`Choose a PDF or a photo of the ${what}.`);
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
  const who = new Proxy({}, { get: (_, id) => personName(id) });
  for (const p of all) if (!p.member_id) p.member_id = p.person === 'me' ? primaryId() : cache.members.find(m => !m.is_primary)?.id;
  const mine = all.filter(p => personView === 'all' || p.member_id === personView);
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
        <div class="row"><button class="primary" id="ps-scan">Scan payslip (PDF or photo)</button><button id="ps-add">Type it in</button></div></section>
      <div id="ps-cl"></div>`;
    renderCentrelink($('#ps-cl'));
    renderCentrelink($('#ps-cl'));
  $('#ps-add').onclick = async () => { if (await payslipForm()) payView(); };
    $('#ps-scan').onclick = () => scanPayslip(payView);
    return;
  }

  const t = k => sum(rows, p => p[k]);
  const gross = t('gross_pay'), tax = t('tax_withheld'), net = t('net_pay'), sup = t('super_employer');
  const sgDue = sum(rows, p => (Number(p.ordinary_pay) + Number(p.leave_pay) + Number(p.salary_sacrifice)) * SG_RATE);
  const shortSlips = rows.filter(p => p.ordinary_pay > 0 && Number(p.super_employer) + 0.05 < (Number(p.ordinary_pay) + Number(p.leave_pay) + Number(p.salary_sacrifice)) * SG_RATE);
  const latest = {}; for (const p of mine) if (!latest[p.member_id]) latest[p.member_id] = p;

  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Payslips</h1><div class="who-now inline">${esc(label)}</div></div>
      <div class="row"><select id="ps-fy" style="width:auto;margin:0" aria-label="Financial year">${fys.map(f => `<option value="${f}" ${f === payFy ? 'selected' : ''}>FY ${f.slice(0, 4)}–${f.slice(5)}</option>`).join('')}</select>
        <button class="primary" id="ps-scan">Scan payslip</button><button id="ps-add">+ Type one in</button></div></div>
    <div id="ps-cl"></div>
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
        ${rows.map((p, i) => `<tr><td>${esc(fmtDate(p.pay_date))}</td>${personView === 'all' ? `<td>${esc(who[p.member_id])}</td>` : ''}<td>${esc(p.employer)}</td><td class="num">${p.hours ?? '—'}</td>
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
    if (!confirm(`Add "${p.employer} wages" as regular income: ${money(p.net_pay)} ${freq}, all ${who[p.member_id]}'s?`)) return;
    await q(sb.from('recurring_items').insert({ name: `${p.employer} wages (${who[p.member_id]})`, direction: 'in', amount: p.net_pay, frequency: freq,
      next_due: next.toLocaleDateString('en-CA'), category_id: work?.id || null, match_text: p.employer.toUpperCase().slice(0, 20), split: onlyFor(p.member_id || primaryId()),
      notes: 'Set up from a payslip — take-home pay. Update the amount if it changes.' }));
    toast('Added to Income'); 
  });
  $('#ps-csv').onclick = () => {
    const head = ['Pay date', 'Who', 'Employer', 'Period from', 'Period to', 'Hours', 'Ordinary', 'Overtime', 'Allowances', 'Bonus', 'Leave pay', 'Gross', 'Tax withheld', 'Salary sacrifice', 'Other deductions', 'Net pay', 'Employer super', 'YTD gross', 'YTD tax', 'YTD super'];
    const lines = [head, ...rows.map(p => [p.pay_date, who[p.member_id], p.employer, p.period_start, p.period_end, p.hours, p.ordinary_pay, p.overtime_pay, p.allowances, p.bonus, p.leave_pay, p.gross_pay, p.tax_withheld, p.salary_sacrifice, p.other_deductions, p.net_pay, p.super_employer, p.ytd_gross, p.ytd_tax, p.ytd_super])];
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

// ---------- REPORT: Statement of Financial Position for hardship calls & financial counsellors ----------
const RPT_FREQ = { weekly: { label: 'week', f: 12 / 52 }, fortnightly: { label: 'fortnight', f: 12 / 26 }, monthly: { label: 'month', f: 1 } };
const EXP_GROUPS = [
  ['Housing & utilities', /rates|water|power|electric|gas\b|strata|body corp|rent(?! received)|repair|maintenance|home/i],
  ['Phone & internet', /phone|internet|mobile|nbn/i],
  ['Food & groceries', /grocer|takeaway|eating|food|meal/i],
  ['Transport', /fuel|car cost|transport|rego|registration|parking|toll|petrol/i],
  ['Insurance', /insurance/i],
  ['Medical & health', /medical|pharmacy|health|doctor|dental|chemist/i],
  ['Children & education', /kid|child|school|education|daycare/i],
  ['Personal & other', /.*/],
];
const DEBT_CATS = /mortgage|bnpl|afterpay|debt|loan|latitude|credit card|zip/i;
const RPT_QUESTIONS = [
  ['reason', 'Why are you in financial difficulty?', 'e.g. released from prison and on JobSeeker; separated; reduced income — what happened and when'],
  ['changes', 'What has changed / is it short or long term?', 'e.g. looking for work, expect income to change in 3 months'],
  ['asking', 'What are you asking for?', 'e.g. pause repayments for 3 months, interest-only, reduce to $X a fortnight, waive fees'],
  ['employment', 'Work / income situation', 'e.g. unemployed, on JobSeeker; partner on Carer Payment'],
  ['home_value', 'Home — estimated value', 'e.g. about $520,000 (from a recent valuation)'],
  ['vehicles', 'Vehicles (make, year, value, any loan)', 'e.g. 2012 Hilux, about $12,000, owned outright'],
  ['super', 'Superannuation balance(s)', 'e.g. about $18,000 with AustralianSuper'],
  ['other_assets', 'Other assets', 'e.g. tools of trade, savings elsewhere — or none'],
  ['other', 'Anything else they should know', 'e.g. health, dependants, safety, other help already received'],
];
let rptFreq = (() => { try { return localStorage.getItem('rptFreq') || 'fortnightly'; } catch { return 'fortnightly'; } })();
async function reportView() {
  const now = new Date(), m0 = new Date(now.getFullYear(), now.getMonth() - 3, 1).toLocaleDateString('en-CA'), m1 = new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString('en-CA');
  const [items, txns, debtsRaw, contacts, bal, ins] = await Promise.all([
    q(sb.from('recurring_items').select('*').eq('is_active', true)),
    q(sb.from('transactions').select('amount, category_id, account_id, txn_date, recurring_item_id').gte('txn_date', m0).lt('txn_date', m1).range(0, 9999)),
    q(sb.from('debts').select('*').eq('status', 'active').order('priority').order('current_balance', { ascending: false })),
    q(sb.from('debt_contacts').select('*').order('contact_date', { ascending: false }).limit(200)),
    q(sb.from('v_account_balances').select('*').eq('is_active', true)),
    sb.rpc('insights', { p_days: 28 }).then(r => r.data).catch(() => null),
  ]);
  const notes = { ...(cache.settings?.report || {}) };
  const who = personView, whoName = personName();
  const F = RPT_FREQ[rptFreq] || RPT_FREQ.fortnightly, per = `/${F.label}`;
  const fx = monthly => monthly * F.f;            // monthly -> chosen frequency
  const cats = new Map(cache.categories.map(c => [c.id, c]));
  const acctSplit = id => cache.accounts.find(a => a.id === id)?.split;
  const itemSplit = new Map(items.map(i => [i.id, i.split]));

  // income: regular income items
  const income = items.filter(i => i.direction === 'in').map(i => ({ name: i.name, m: i.amount * PER_MONTH[i.frequency] * shareFor(i.split, who), freq: i.frequency, amount: i.amount,
    whose: splitLabel(i.split) })).filter(x => x.m > 0.004).sort((a, b) => b.m - a.m);
  const incomeM = sum(income, x => x.m);
  const actualInM = sum(txns.filter(t => t.amount > 0 && cats.get(t.category_id)?.kind !== 'transfer'), t => t.amount * shareFor(t.recurring_item_id ? itemSplit.get(t.recurring_item_id) : acctSplit(t.account_id), who)) / 3;

  // living expenses: actual average of the last 3 full months, grouped like a hardship form (debt repayments are listed separately)
  const exp = new Map();
  let unsorted = 0;
  for (const t of txns) {
    if (t.amount >= 0) continue;
    const c = cats.get(t.category_id);
    if (c && (c.kind === 'transfer' || c.kind === 'income' || DEBT_CATS.test(c.name))) continue;
    const share = shareFor(t.recurring_item_id ? itemSplit.get(t.recurring_item_id) : cache.settings?.default_split, who);
    const amt = -t.amount * share / 3;
    if (!c) { unsorted += amt; continue; }
    const g = EXP_GROUPS.find(([, re]) => re.test(c.name))[0];
    if (!exp.has(g)) exp.set(g, new Map());
    exp.get(g).set(c.name, (exp.get(g).get(c.name) || 0) + amt);
  }
  if (unsorted > 0.5) { if (!exp.has('Personal & other')) exp.set('Personal & other', new Map()); exp.get('Personal & other').set('Not yet sorted', unsorted); }
  const extraFood = Number(notes.extra_food_weekly || 0) * 52 / 12 * shareFor(cache.settings?.default_split, who);
  const extraOther = Number(notes.extra_other_weekly || 0) * 52 / 12 * shareFor(cache.settings?.default_split, who);
  if (extraFood > 0) { if (!exp.has('Food & groceries')) exp.set('Food & groceries', new Map()); exp.get('Food & groceries').set('Food paid another way (your estimate)', extraFood); }
  if (extraOther > 0) { if (!exp.has('Personal & other')) exp.set('Personal & other', new Map()); exp.get('Personal & other').set('Other costs paid another way (your estimate)', extraOther); }
  const foodFromBank = sum(txns.filter(t => t.amount < 0 && /grocer/i.test(cats.get(t.category_id)?.name || '')), t => -t.amount) / 3;
  const groups = EXP_GROUPS.map(([g]) => [g, exp.get(g)]).filter(([, m]) => m && m.size).map(([g, m]) => ({ g, total: sum([...m.values()], v => v), lines: [...m.entries()].sort((a, b) => b[1] - a[1]) }));
  const livingM = sum(groups, x => x.total);

  // debts
  const debts = debtsRaw.map(d => { const sh = shareFor(d.split, who);
    const last = contacts.find(c => c.debt_id === d.id);
    return { ...d, sh, bal: Number(d.current_balance || 0) * sh, arr: Number(d.arrears_amount || 0) * sh, repM: Number(d.min_payment || 0) * PER_MONTH[d.payment_frequency || 'monthly'] * sh, last,
      secured: ['mortgage', 'car_loan'].includes(d.debt_type) }; }).filter(d => d.sh > 0);
  const debtTotal = sum(debts, d => d.bal), arrTotal = sum(debts, d => d.arr), repM = sum(debts, d => d.repM);
  const available = incomeM - livingM, after = available - repM;

  // assets in the bank data
  const isLoan = a => ['loan', 'mortgage', 'credit_card'].includes(a.account_type);
  const cash = bal.filter(a => !isLoan(a)).map(a => ({ name: a.name, v: Number(a.calculated_balance) * shareFor(acctSplit(a.id), who) }));
  const cashTotal = sum(cash, a => a.v);
  const people = cache.members;
  const kids = people.filter(m => m.relationship === 'child').length;
  const hasMortgage = debtsRaw.some(d => d.debt_type === 'mortgage') || bal.some(a => a.account_type === 'mortgage');
  const recentBounces = (ins?.bounces || []).filter(b => b.recent > 0);
  const fcLow = (ins?.forecast?.days || []).reduce((a, d) => (!a || Number(d.bal) < Number(a.bal) ? d : a), null);
  const overdueItems = items.filter(i => i.direction === 'out' && i.next_due < today() && shareFor(i.split, who) > 0);
  const M = v => money(fx(v));

  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Financial report</h1>
      <p class="hint">Your Statement of Financial Position — the questions a lender’s hardship team, a financial counsellor or Centrelink will ask, answered from your data. ${who === 'all' ? 'Whole household.' : `Showing <b>${esc(whoName)}</b>’s share.`} As at ${esc(fmtDate(today()))}.</p></div>
      <div class="row no-print">
        <div class="seg" role="tablist" aria-label="Show amounts per">${Object.entries(RPT_FREQ).map(([k, v]) => `<button class="${k === rptFreq ? 'on' : ''}" data-rf="${k}">Per ${v.label}</button>`).join('')}</div>
        <button id="rp-copy">Copy as text</button><button id="rp-print">Print / PDF</button><button id="rp-csv">CSV</button></div></div>

    <section class="card rpt-quick"><h2>On the phone: quick answers</h2>
      <dl class="qa">
        <dt>Total income</dt><dd>${M(incomeM)} ${per}</dd>
        <dt>Living expenses (not counting debt repayments)</dt><dd>${M(livingM)} ${per}</dd>
        <dt>Left for debts after living costs</dt><dd class="${available < 0 ? 'neg' : ''}">${M(available)} ${per}</dd>
        <dt>Debt repayments you’re meant to make</dt><dd>${M(repM)} ${per}</dd>
        <dt>${after < 0 ? 'Shortfall' : 'Left over'} after all repayments</dt><dd class="${after < 0 ? 'neg' : 'pos'}">${M(after)} ${per}</dd>
        <dt>What you could offer this creditor</dt><dd>${available > 0 ? `Up to ${M(available)} ${per} <span class="hint">across <b>all</b> your debts combined — share it fairly, essentials first</span>` : '<b>Nothing right now</b> <span class="hint">— income doesn’t cover living costs; ask for a pause</span>'}</dd>
        <dt>Total owed</dt><dd>${money(debtTotal)} <span class="hint">· ${debts.length} debt${debts.length === 1 ? '' : 's'}${arrTotal ? ` · ${money(arrTotal)} overdue` : ''}</span></dd>
        <dt>Money in the bank</dt><dd>${money(cashTotal)}</dd>
        <dt>People in the household</dt><dd>${people.length} adult${people.length - kids === 1 ? '' : 's'}${kids ? ` + ${kids} child${kids > 1 ? 'ren' : ''}` : ''} · ${hasMortgage ? 'own home with a mortgage' : 'housing: see notes'}</dd>
      </dl>
      ${notes.reason ? `<p><b>Why:</b> ${esc(notes.reason)}</p>` : ''}${notes.asking ? `<p><b>Asking for:</b> ${esc(notes.asking)}</p>` : ''}
      ${recentBounces.length || overdueItems.length || (fcLow && fcLow.bal < 0) ? `<div class="callout">${[
        overdueItems.length ? `Behind on: ${overdueItems.map(i => esc(i.name)).join(', ')}.` : '',
        recentBounces.length ? `Payments bouncing in the last 90 days: ${recentBounces.map(b => esc(b.payee.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()))).join(', ')}.` : '',
        fcLow && fcLow.bal < 0 ? `On current bills the bank balance is forecast to go to ${money(fcLow.bal)} around ${esc(fmtDate(fcLow.d))}.` : ''].filter(Boolean).join(' ')}</div>` : ''}
      <p class="hint">Free help: National Debt Helpline <b>1800 007 007</b> (Mon–Fri). Ask any lender for their <b>hardship team</b> — they must consider your request and tell you the outcome in writing.</p>
    </section>

    <details class="card rpt" open><summary><h2>1. You and your household</h2></summary>
      <table class="list rpt-tbl"><thead><tr><th>Name</th><th>Who</th><th class="hide-sm">Contact</th></tr></thead><tbody>
      ${people.map(m => `<tr><td><b>${esc(memberName(m))}</b><div class="hint show-sm">${esc([m.phone, m.email].filter(Boolean).join(' · '))}</div></td><td>${esc(m.is_primary ? 'Main contact' : RELATIONSHIPS[m.relationship] || '')}</td><td class="hide-sm">${esc([m.phone, m.email].filter(Boolean).join(' · ') || '—')}</td></tr>`).join('')}
      </tbody></table>
      <p class="hint">Housing: ${hasMortgage ? 'own home, paying a mortgage' : 'not recorded'}. Edit people on the <button class="link" data-go="members">Household</button> page.</p>
    </details>

    <details class="card rpt" open><summary><h2>2. Income <span class="rpt-total">${M(incomeM)} ${per}</span></h2></summary>
      ${income.length ? `<table class="list rpt-tbl"><thead><tr><th>Source</th><th class="hide-sm">Whose</th><th class="num hide-sm">Amount</th><th class="num">Per ${F.label}</th></tr></thead><tbody>
        ${income.map(x => `<tr><td>${esc(x.name)}<div class="hint show-sm">${esc(x.whose)} · ${money(x.amount)} / ${FREQ_WORD[x.freq] || x.freq}</div></td><td class="hide-sm">${esc(x.whose)}</td><td class="num hide-sm">${money(x.amount)} <span class="hint">/ ${FREQ_WORD[x.freq] || x.freq}</span></td><td class="num">${M(x.m)}</td></tr>`).join('')}
        </tbody><tfoot><tr class="total"><td><b>Total income</b></td><td class="hide-sm"></td><td class="hide-sm"></td><td class="num"><b>${M(incomeM)}</b></td></tr></tfoot></table>
        <p class="hint">From your regular income list. Actually received over the last 3 months averaged ${M(actualInM)} ${per}${Math.abs(actualInM - incomeM) > incomeM * 0.15 ? ' — quite different, so check the Income page is up to date' : ''}. Have Centrelink income statements and payslips ready if asked.</p>`
        : '<p class="empty">No regular income set up — add it on the Income page.</p>'}
    </details>

    <details class="card rpt" open><summary><h2>3. Living expenses <span class="rpt-total">${M(livingM)} ${per}</span></h2></summary>
      ${groups.length ? `<table class="list rpt-tbl"><tbody>${groups.map(g => `<tr class="grp"><td><b>${esc(g.g)}</b></td><td class="num"><b>${M(g.total)}</b></td></tr>${g.lines.map(([n, v]) => `<tr class="sub"><td>${esc(n.replace(' (not counted)', ''))}</td><td class="num">${M(v)}</td></tr>`).join('')}`).join('')}</tbody>
        <tfoot><tr class="total"><td><b>Total living expenses</b></td><td class="num"><b>${M(livingM)}</b></td></tr></tfoot></table>
        ${foodFromBank < 80 * 52 / 12 && !extraFood ? `<div class="callout">Groceries from the bank are only about ${moneyRound(foodFromBank * 12 / 52)} a week for the household. If food is bought with Afterpay, cash or a card that isn’t in the app, put a realistic weekly amount in <b>Your answers</b> below — otherwise your living costs will look too low and the offer too high.</div>` : ''}
        <p class="hint">Average actually spent over the last 3 full months (${esc(fmtDate(m0))} – ${esc(fmtDate(new Date(new Date(m1) - 864e5).toLocaleDateString('en-CA')))}). Mortgage, loans and Afterpay are in Debts below, not here.${unsorted > 0.5 ? ` ${M(unsorted)} ${per} isn’t sorted into a category yet — sorting it on <b>To sort</b> makes this more accurate.` : ''}</p>`
        : '<p class="empty">No spending in the last 3 months yet — import your statements.</p>'}
    </details>

    <details class="card rpt" open><summary><h2>4. Debts <span class="rpt-total">${money(debtTotal)}</span></h2></summary>
      ${debts.length ? `<div class="tablewrap"><table class="list"><thead><tr><th>Owed to</th><th class="num">Balance</th><th class="num">Overdue</th><th class="num">Repayment per ${F.label}</th><th>Hardship</th><th>Last contact</th></tr></thead><tbody>
        ${debts.map(d => `<tr><td data-label="Owed to"><b>${esc(d.creditor)}</b>${d.secured ? ' <span class="pill">secured</span>' : ''}${d.reference_note ? `<div class="hint">${esc(d.reference_note)}</div>` : ''}</td>
          <td class="num" data-label="Balance">${money(d.bal)}</td><td class="num" data-label="Overdue">${d.arr ? `<span class="neg">${money(d.arr)}</span>` : '—'}</td>
          <td class="num" data-label="Repayment">${d.repM ? M(d.repM) : '—'}</td>
          <td data-label="Hardship">${esc(label(d.hardship_status || 'none'))}${d.hardship_until ? ` <span class="hint">to ${esc(fmtDate(d.hardship_until))}</span>` : ''}</td>
          <td data-label="Last contact">${d.last ? `${esc(fmtDate(d.last.contact_date))}${d.last.reference_number ? ` · ref ${esc(d.last.reference_number)}` : ''}<div class="hint">${esc((d.last.agreed || d.last.summary || '').slice(0, 90))}</div>` : '<span class="hint">none logged</span>'}</td></tr>`).join('')}
        </tbody><tfoot><tr class="total"><td><b>Total</b></td><td class="num" data-label="Balance"><b>${money(debtTotal)}</b></td><td class="num" data-label="Overdue">${money(arrTotal)}</td><td class="num" data-label="Repayments"><b>${M(repM)}</b></td><td class="hide-sm"></td><td class="hide-sm"></td></tr></tfoot></table></div>
        <p class="hint">Repayment = the contracted or minimum payment you entered. Log every call on the Debts page (Calls button) so the dates and reference numbers show here.</p>`
        : '<p class="empty">No debts recorded.</p>'}
    </details>

    <details class="card rpt" open><summary><h2>5. Assets</h2></summary>
      <table class="list rpt-tbl"><tbody>${cash.map(a => `<tr><td>${esc(a.name)}</td><td class="num">${money(a.v)}</td></tr>`).join('')}
        ${['home_value', 'vehicles', 'super', 'other_assets'].map(k => `<tr><td>${esc(RPT_QUESTIONS.find(x => x[0] === k)[1])}</td><td>${notes[k] ? esc(notes[k]) : '<span class="hint">not filled in — see below</span>'}</td></tr>`).join('')}
      </tbody></table>
    </details>

    <details class="card rpt" open><summary><h2>6. Summary</h2></summary>
      <table class="list rpt-tbl"><tbody>
        <tr><td>Total income</td><td class="num">${M(incomeM)}</td></tr>
        <tr><td>less living expenses</td><td class="num">− ${M(livingM)}</td></tr>
        <tr class="total"><td><b>Available for debt repayments</b></td><td class="num"><b class="${available < 0 ? 'neg' : ''}">${M(available)}</b></td></tr>
        <tr><td>less current debt repayments</td><td class="num">− ${M(repM)}</td></tr>
        <tr class="total"><td><b>${after < 0 ? 'Shortfall' : 'Surplus'}</b></td><td class="num"><b class="${after < 0 ? 'neg' : 'pos'}">${M(after)}</b></td></tr>
      </tbody></table><p class="hint">All amounts per ${F.label}.</p>
    </details>

    <details class="card rpt" open><summary><h2>7. Your answers <span class="hint">(saved for next time)</span></h2></summary>
      <p class="hint">The questions they always ask that aren’t in your bank data. Fill these in once; they show above and in the copy/print versions.</p>
      <form id="rp-notes"><div class="formgrid">
        <label>Food bought another way <span class="hint">$ per week, household — Afterpay, cash, another card</span><input type="number" step="1" min="0" name="extra_food_weekly" value="${esc(notes.extra_food_weekly ?? '')}"></label>
        <label>Other living costs paid another way <span class="hint">$ per week, household</span><input type="number" step="1" min="0" name="extra_other_weekly" value="${esc(notes.extra_other_weekly ?? '')}"></label>
        ${RPT_QUESTIONS.map(([k, q, ph]) => `<label class="full">${esc(q)}<textarea name="${k}" rows="2" placeholder="${esc(ph)}">${esc(notes[k] || '')}</textarea></label>`).join('')}</div>
      <button class="primary">Save answers</button></form>
    </details>

    <details class="card rpt"><summary><h2>8. Recent calls & letters</h2></summary>
      ${contacts.length ? `<ul class="ins-list">${contacts.slice(0, 15).map(c => { const d = debtsRaw.find(x => x.id === c.debt_id);
        return `<li><b>${esc(fmtDate(c.contact_date))} · ${esc(d?.creditor || 'creditor')}</b><span class="ins-amt">${esc(label(c.method || ''))}</span><p class="hint">${c.spoke_to ? `Spoke to ${esc(c.spoke_to)}. ` : ''}${c.reference_number ? `Ref ${esc(c.reference_number)}. ` : ''}${esc(c.summary || '')}${c.agreed ? ` <b>Agreed:</b> ${esc(c.agreed)}` : ''}</p></li>`; }).join('')}</ul>`
        : '<p class="empty">No calls logged yet. After each call, add it on the Debts page → Calls.</p>'}
    </details>`;

  view.querySelectorAll('[data-rf]').forEach(b => b.onclick = () => { rptFreq = b.dataset.rf; try { localStorage.setItem('rptFreq', rptFreq); } catch {} reportView(); });
  view.querySelectorAll('[data-go]').forEach(b => b.onclick = () => show(b.dataset.go));
  $('#rp-notes').onsubmit = async e => {
    e.preventDefault();
    const out = {}; for (const [k] of RPT_QUESTIONS) out[k] = e.target[k].value.trim();
    for (const k of ['extra_food_weekly', 'extra_other_weekly']) out[k] = e.target[k].value === '' ? null : Number(e.target[k].value);
    Object.assign(out, { links: cache.settings?.report?.links || [] });
    await busy(e.submitter, () => q(sb.from('settings').update({ report: out }).eq('owner_id', session.user.id)));
    cache.settings.report = out; toast('Answers saved'); reportView();
  };
  $('#rp-print').onclick = () => { view.querySelectorAll('details.rpt').forEach(d => d.open = true); window.print(); };
  const textReport = () => {
    const L = [], line = (a, b = '') => L.push(b === '' ? a : `${a}: ${b}`);
    line(`FINANCIAL POSITION — ${who === 'all' ? 'household' : whoName} — as at ${fmtDate(today())} (amounts per ${F.label})`); L.push('');
    line('People', people.map(m => `${memberName(m)}${m.is_primary ? ' (main contact' + (m.phone ? ', ' + m.phone : '') + ')' : ' (' + (RELATIONSHIPS[m.relationship] || '') + ')'}`).join('; '));
    line('Housing', hasMortgage ? 'own home with a mortgage' : 'see notes');
    for (const [k, q] of RPT_QUESTIONS) if (notes[k]) line(q.replace(/\?$/, ''), notes[k]);
    L.push('', `INCOME ${M(incomeM)}`); income.forEach(x => line(`  ${x.name}`, M(x.m)));
    L.push('', `LIVING EXPENSES ${M(livingM)}`); groups.forEach(g => line(`  ${g.g}`, M(g.total)));
    L.push('', `DEBTS ${money(debtTotal)} owed, repayments ${M(repM)}`); debts.forEach(d => line(`  ${d.creditor}`, `${money(d.bal)} owed${d.arr ? `, ${money(d.arr)} overdue` : ''}${d.repM ? `, repayment ${M(d.repM)}` : ''}${d.hardship_status && d.hardship_status !== 'none' ? `, hardship: ${label(d.hardship_status)}` : ''}`));
    L.push('', `ASSETS`); cash.forEach(a => line(`  ${a.name}`, money(a.v)));
    L.push('', 'SUMMARY'); line('  Income', M(incomeM)); line('  Living expenses', M(livingM)); line('  Available for debts', M(available)); line('  Current repayments', M(repM)); line(`  ${after < 0 ? 'Shortfall' : 'Surplus'}`, M(after));
    return L.join('\n');
  };
  $('#rp-copy').onclick = async () => { try { await navigator.clipboard.writeText(textReport()); toast('Copied — paste it into an email or form'); } catch { const w = window.open('', '_blank'); if (w) { w.document.body.innerText = textReport(); } } };
  $('#rp-csv').onclick = () => {
    const rows = [['Statement of financial position', who === 'all' ? 'Household' : whoName, fmtDate(today()), `per ${F.label}`], [],
      ['Income'], ...income.map(x => [x.name, x.whose, fx(x.m).toFixed(2)]), ['Total income', '', fx(incomeM).toFixed(2)], [],
      ['Living expenses'], ...groups.flatMap(g => [[g.g, '', fx(g.total).toFixed(2)], ...g.lines.map(([n, v]) => ['', n, fx(v).toFixed(2)])]), ['Total living expenses', '', fx(livingM).toFixed(2)], [],
      ['Debts', 'Balance', 'Overdue', 'Repayment', 'Hardship', 'Last contact', 'Reference'], ...debts.map(d => [d.creditor, d.bal.toFixed(2), d.arr.toFixed(2), fx(d.repM).toFixed(2), d.hardship_status || '', d.last?.contact_date || '', d.last?.reference_number || '']), [],
      ['Assets'], ...cash.map(a => [a.name, a.v.toFixed(2)]), ...['home_value', 'vehicles', 'super', 'other_assets'].map(k => [RPT_QUESTIONS.find(x => x[0] === k)[1], notes[k] || '']), [],
      ['Available for debts', fx(available).toFixed(2)], ['Current repayments', fx(repM).toFixed(2)], [after < 0 ? 'Shortfall' : 'Surplus', fx(after).toFixed(2)], [],
      ...RPT_QUESTIONS.filter(([k]) => notes[k]).map(([k, q]) => [q, notes[k]])];
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `financial-position-${today()}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
}

// ---------- CENTRELINK ESTIMATE (income test: board, wages from payslips, other income) ----------
function clPayment(rule, assessed) {
  const { max_rate: max, free_area: free, band1_to: b1, taper1: t1, taper2: t2 } = rule;
  const red = assessed <= free ? 0 : assessed <= b1 ? (assessed - free) * t1 : (b1 - free) * t1 + (assessed - b1) * t2;
  return Math.max(0, max - red);
}
async function renderCentrelink(el, { title = true } = {}) {
  if (!el) return;
  const ids = personView === 'all' ? cache.members.filter(m => m.centrelink?.rule && m.centrelink.rule !== 'none').map(m => m.id) : [personView];
  const results = (await Promise.all(ids.map(id => sb.rpc('centrelink_estimate', { p_member: id }).then(r => r.data).catch(() => null)))).filter(Boolean);
  const set = results.filter(r => r.configured);
  if (!set.length) {
    el.innerHTML = personView === 'all' ? '' : `<section class="card"><h2>Centrelink estimate</h2><p class="hint">Not set up for ${esc(personName())}. If they get JobSeeker, turn it on from the <button class="link" data-go="members">Household</button> page → Centrelink.</p></section>`;
    el.querySelectorAll('[data-go]').forEach(b => b.onclick = () => show(b.dataset.go));
    return;
  }
  el.innerHTML = set.map((e, i) => {
    const r = e.rule, name = e.name || personName(e.member);
    const cut = Number(e.cutoff_fn), free = Number(r.free_area), a = Number(e.assessed_fn);
    const pos = v => Math.min(100, Math.max(0, v / cut * 100));
    const zone = a <= free ? 'ok' : a < cut ? 'taper' : 'over';
    const boardRoom = Math.max(0, (Number(e.interest_fn) + free - Number(e.wages_fn) - Number(e.other_fn)) / Number(e.board_pct) - Number(e.board_fn));
    const basisWord = { lodging: 'lodging only', bnb: 'bed & breakfast', board: 'full board' }[e.board_basis] || e.board_basis;
    return `<section class="card cl-card" data-i="${i}">
      <div class="sec-head"><div><h2>Centrelink estimate — ${esc(name)}</h2><p class="hint">${esc(r.label)} · rates from ${esc(fmtDate(r.as_at))} · an estimate, not Centrelink’s decision</p></div></div>
      <div class="tiles cl-tiles">
        <div class="tile ${zone === 'ok' ? 'good' : zone === 'taper' ? 'warn' : 'bad'}"><div class="tile-label">Income Centrelink counts ${info(`Board: ${Math.round(e.board_pct * 100)}% of what boarders pay you (${basisWord}) minus your share of the home-loan interest, never below $0. Plus wages before tax from your latest payslip, plus any other income you set. The first ${money(free)} a fortnight doesn’t reduce your payment.`)}</div>
          <div class="tile-value">${money(a)}<small> /fn</small></div><div class="tile-sub">the first ${moneyRound(free)} is free</div></div>
        <div class="tile"><div class="tile-label">Estimated payment</div><div class="tile-value">${money(e.estimate_fn)}<small> /fn</small></div><div class="tile-sub">of ${money(r.max_rate)} maximum${Number(e.currently_set_up_fn) && Math.abs(e.currently_set_up_fn - e.estimate_fn) > 1 ? ` · Income page says ${money(e.currently_set_up_fn)}` : ''}</div></div>
        <div class="tile good"><div class="tile-label">Wages you can earn before it drops ${info('Gross wages (before tax) per fortnight you could earn on top of what’s already counted before your payment starts to reduce.')}</div><div class="tile-value">${money(e.wages_room_fn)}<small> /fn</small></div><div class="tile-sub">before tax</div></div>
      </div>
      <div class="cl-meter" role="meter" aria-valuemin="0" aria-valuemax="${cut}" aria-valuenow="${a}" aria-label="Income counted by Centrelink">
        <div class="cl-zone free" style="width:${pos(free)}%"></div><div class="cl-zone taper" style="left:${pos(free)}%;width:${100 - pos(free)}%"></div>
        <div class="cl-fill ${zone}" style="width:${Math.max(a > 0 ? 1 : 0, pos(a))}%"></div>
        <div class="cl-mark" style="left:${pos(free)}%"><span>${moneyRound(free)} free</span></div>
      </div>
      <div class="cl-scale"><span>$0</span><span>payment reduces 50c per $ to ${moneyRound(r.band1_to)}, then 60c</span><span>${moneyRound(cut)} — $0 paid</span></div>
      <table class="list rpt-tbl cl-break"><tbody>
        <tr><td>Board — your share ${money(e.board_fn)} × ${Math.round(e.board_pct * 100)}% (${esc(basisWord)})</td><td class="num">${money(e.board_fn * e.board_pct)}</td></tr>
        <tr class="sub"><td>less your share of home-loan interest</td><td class="num">− ${money(e.interest_fn)}</td></tr>
        <tr><td><b>Board counted</b></td><td class="num"><b>${money(e.board_assessed_fn)}</b></td></tr>
        <tr><td>Wages (before tax)${e.payslip ? ` <span class="hint">from ${esc(e.payslip.employer || 'payslip')}, ${esc(fmtDate(e.payslip.date))}</span>` : ' <span class="hint">no payslip in the last 6 weeks</span>'}</td><td class="num">${money(e.wages_fn)}</td></tr>
        ${Number(e.other_fn) ? `<tr><td>Other income</td><td class="num">${money(e.other_fn)}</td></tr>` : ''}
        <tr class="total"><td><b>Counted per fortnight</b></td><td class="num"><b>${money(a)}</b></td></tr>
      </tbody></table>
      <p class="hint">Board could go up by about <b>${money(boardRoom)}</b> a fortnight (your share) before it affects the payment — the interest soaks it up.</p>
      <div class="cl-whatif"><label>What if I earn <span class="hint">wages per fortnight, before tax</span>
        <input type="range" min="0" max="${Math.ceil(cut / 50) * 50 + 200}" step="10" value="${Math.round(e.wages_fn)}" class="cl-range"></label>
        <div class="cl-out" aria-live="polite"></div></div>
      <p class="hint">Report wages to Centrelink every fortnight, even when it’s under ${moneyRound(free)}. If you had low income for a while you may have <b>working credits</b>, which can let you keep more of the payment for a while when you start work — Centrelink works this out. <a href="${esc(r.source)}" target="_blank" rel="noopener">Income test details</a>.</p>
    </section>`; }).join('');
  el.querySelectorAll('.cl-card').forEach(card => {
    const e = set[card.dataset.i], range = card.querySelector('.cl-range'), out = card.querySelector('.cl-out');
    const other = Number(e.board_assessed_fn) + Number(e.other_fn);
    const upd = () => { const w = Number(range.value), pay = clPayment(e.rule, other + w);
      out.innerHTML = `Earning <b>${money(w)}</b> → JobSeeker about <b>${money(pay)}</b>${pay <= 0 ? ' (stops)' : ''} · together <b>${money(w + pay)}</b> a fortnight before tax${w > 0 ? ` (${money(w + pay - Number(e.rule.max_rate))} more than JobSeeker alone)` : ''}`; };
    range.oninput = upd; upd();
  });
  wireInfoTips();
}
function centrelinkSettings(m) {
  const c = m.centrelink || {};
  return new Promise(async resolve => {
    const rules = await q(sb.from('income_test_rules').select('*').order('label'));
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog"><h2>Centrelink — ${esc(memberName(m))}</h2>
      <p class="hint">Used to estimate how income (board, wages from payslips) changes their payment. Rates are kept up to date centrally.</p>
      <div class="formgrid">
        <label>Payment <select name="rule"><option value="none">Not on a Centrelink payment / don’t estimate</option>${rules.map(r => `<option value="${r.id}" ${c.rule === r.id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label>
        <label>What boarders get <select name="board_basis">${[['lodging', 'Room only, no meals (70% counted)'], ['bnb', 'Room and breakfast (50%)'], ['board', 'Room and meals (20%)']].map(([k, v]) => `<option value="${k}" ${(c.board_basis || 'lodging') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Other income per fortnight <span class="hint">counted by Centrelink, not wages or board</span><input type="number" step="0.01" min="0" name="other_fn" value="${esc(c.other_fn ?? '')}"></label>
        <label>Maximum rate per fortnight <span class="hint">leave blank for the standard rate</span><input type="number" step="0.01" min="0" name="max_rate" value="${esc(c.max_rate ?? '')}"></label>
      </div>
      <div class="row"><button class="primary" value="save">Save</button><button value="cancel" formnovalidate>Cancel</button></div></form>`;
    document.body.appendChild(dlg);
    const f = $('form', dlg);
    f.addEventListener('submit', async e => {
      if (e.submitter?.value !== 'save') return;
      e.preventDefault();
      const out = { rule: f.rule.value, board_basis: f.board_basis.value };
      if (f.other_fn.value !== '') out.other_fn = Number(f.other_fn.value);
      if (f.max_rate.value !== '') out.max_rate = Number(f.max_rate.value);
      await busy(e.submitter, () => q(sb.from('household_members').update({ centrelink: out }).eq('id', m.id)));
      toast('Centrelink settings saved'); dlg.close(); resolve(true);
    });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(false); });
    dlg.showModal();
  });
}

// ---------- LINKS (bank, debt and bill websites in one place; stored with the household's settings) ----------
const LINK_KINDS = { bank: 'Banks — download statements', debt: 'Debts — check balances', bill: 'Bills & utilities', government: 'Government', help: 'Free help', other: 'Other' };
const LINK_SUGGESTIONS = [
  { name: 'CommBank (NetBank)', url: 'https://www.commbank.com.au/', kind: 'bank', match: /commbank/i, notes: 'Log on → choose the account → Export → CSV, then Import here.' },
  { name: 'Westpac Online Banking', url: 'https://www.westpac.com.au/', kind: 'bank', match: /westpac choice|westpac/i, notes: 'Log on → the account → Export / Download transactions as CSV (home loans too).' },
  { name: 'Afterpay', url: 'https://www.afterpay.com/', kind: 'debt', match: /afterpay/i, notes: 'Check the total still owing, then press Update balance.' },
  { name: 'Deferit', url: 'https://www.deferit.com/', kind: 'debt', match: /deferit/i, notes: 'Check what’s left to pay, then Update balance.' },
  { name: 'Latitude', url: 'https://www.latitudefinancial.com.au/', kind: 'debt', match: /latitude/i, notes: 'Log on to see the balance owing.' },
  { name: 'Zip', url: 'https://zip.co/au', kind: 'debt', match: /\bzip\b/i, notes: '' },
  { name: 'Synergy', url: 'https://www.synergy.net.au/', kind: 'bill', match: /synergy/i, notes: 'Check the balance and any payment plan.' },
  { name: 'Water Corporation', url: 'https://www.watercorporation.com.au/', kind: 'bill', match: /water corp/i, notes: '' },
  { name: 'myGov (Centrelink)', url: 'https://my.gov.au/', kind: 'government', notes: 'Report income: Centrelink → Manage Income and Assets.' },
  { name: 'National Debt Helpline', url: 'https://ndh.org.au/', kind: 'help', notes: 'Free financial counselling: 1800 007 007 (Mon–Fri).' },
];
const allLinks = () => (cache.settings?.report?.links || []);
async function saveLinks(list) {
  const report = { ...(cache.settings?.report || {}), links: list };
  await q(sb.from('settings').update({ report }).eq('owner_id', session.user.id));
  cache.settings.report = report;
}
const linkFor = ({ account_id, debt_id }) => allLinks().find(l => (account_id && l.account_id === account_id) || (debt_id && l.debt_id === debt_id));
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
function linkForm(row = null) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog'); const r = row || { kind: 'bank' };
    dlg.innerHTML = `<form method="dialog"><h2>${row ? 'Edit' : 'Add'} link</h2><div class="formgrid">
      <label>Name <input name="name" required value="${esc(r.name || '')}" placeholder="e.g. Afterpay"></label>
      <label>Web address <span class="hint">must start with https://</span><input name="url" type="url" required pattern="https://.*" value="${esc(r.url || 'https://')}"></label>
      <label>Type <select name="kind">${Object.entries(LINK_KINDS).map(([k, v]) => `<option value="${k}" ${r.kind === k ? 'selected' : ''}>${esc(v.split(' —')[0])}</option>`).join('')}</select></label>
      <label>Linked bank account <select name="account_id"><option value="">— none —</option>${cache.accounts.map(a => `<option value="${a.id}" ${r.account_id === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label>Linked debt <select name="debt_id"><option value="">— none —</option>${cache.debts.map(d => `<option value="${d.id}" ${r.debt_id === d.id ? 'selected' : ''}>${esc(d.creditor)}</option>`).join('')}</select></label>
      <label class="full">Notes <span class="hint">e.g. where the CSV export is</span><textarea name="notes" rows="2">${esc(r.notes || '')}</textarea></label></div>
      <p class="hint">Never save passwords here. Always check the address bar shows the real website before logging in.</p>
      <div class="row"><button class="primary" value="save">Save</button><button value="cancel" formnovalidate>Cancel</button></div></form>`;
    document.body.appendChild(dlg);
    const f = $('form', dlg);
    f.addEventListener('submit', async e => {
      if (e.submitter?.value !== 'save') return;
      e.preventDefault();
      const item = { id: r.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())), name: f.name.value.trim(), url: f.url.value.trim(), kind: f.kind.value,
        account_id: f.account_id.value || null, debt_id: f.debt_id.value || null, notes: f.notes.value.trim() || null };
      if (!/^https:\/\//i.test(item.url)) { toast('The address must start with https://', { kind: 'bad' }); return; }
      const list = allLinks().filter(x => x.id !== item.id); list.push(item);
      await busy(e.submitter, () => saveLinks(list));
      toast('Link saved'); dlg.close(); resolve(true);
    });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(false); });
    dlg.showModal();
  });
}
async function linksView() {
  await loadLookups();
  const [bal, debtRows] = await Promise.all([
    q(sb.from('v_account_balances').select('id, name, last_transaction_date')),
    q(sb.from('debts').select('*').order('creditor')),
  ]);
  const links = allLinks();
  const sugg = LINK_SUGGESTIONS.filter(sg => !links.some(l => hostOf(l.url) === hostOf(sg.url)));
  const card = l => {
    const acc = l.account_id && bal.find(a => a.id === l.account_id), debt = l.debt_id && debtRows.find(d => d.id === l.debt_id);
    const age = acc?.last_transaction_date ? -daysFromToday(acc.last_transaction_date) : null;
    return `<div class="link-card">
      <div class="link-main"><a class="link-open" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.name)} <span aria-hidden="true">↗</span></a>
        <div class="hint">${esc(hostOf(l.url))}</div>
        ${acc ? `<div class="link-status"><span class="fresh-dot ${age == null || age > 14 ? 'stale' : age > 7 ? 'old' : ''}"></span>${esc(acc.name)}: ${age == null ? 'no data yet' : age <= 0 ? 'up to date' : `last transaction ${age} day${age === 1 ? '' : 's'} ago`}</div>` : ''}
        ${debt ? `<div class="link-status">${esc(debt.creditor)}: <b>${money(debt.current_balance)}</b>${debt.balance_as_at ? ` <span class="hint">as at ${esc(fmtDate(debt.balance_as_at))}</span>` : ''}${Number(debt.arrears_amount) ? ` · <span class="neg">${money(debt.arrears_amount)} overdue</span>` : ''}</div>` : ''}
        ${l.notes ? `<p class="hint">${esc(l.notes)}</p>` : ''}</div>
      <div class="link-actions">
        <a class="button primary small" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">Open</a>
        ${acc ? `<button class="small" data-go="import">Import CSV</button>` : ''}
        ${debt ? `<button class="small l-upd" data-debt="${debt.id}">Update balance</button>` : ''}
        <button class="small l-edit" data-id="${esc(l.id)}">Edit</button><button class="small ghost l-del" data-id="${esc(l.id)}" aria-label="Remove ${esc(l.name)}">✕</button></div></div>`; };
  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Links</h1>
      <p class="hint">Your banks, debts and bills in one place: open the site, download a CSV or check a balance, then import or update it here.</p></div>
      <button class="primary" id="l-add">+ Add link</button></div>
    ${links.length ? '' : '<section class="card"><p>No links yet. Add the suggested ones below with one tap, or add your own.</p></section>'}
    ${Object.entries(LINK_KINDS).map(([k, title]) => { const ls = links.filter(l => l.kind === k).sort((a, b) => a.name.localeCompare(b.name));
      return ls.length ? `<section class="card"><h2>${esc(title)}</h2><div class="link-grid">${ls.map(card).join('')}</div></section>` : ''; }).join('')}
    ${sugg.length ? `<section class="card"><h2>Suggested</h2><p class="hint">Common Australian sites. Adding one links it to the matching account or debt automatically.</p>
      <div class="chips">${sugg.map((sg, i) => `<button class="chip l-sugg" data-i="${i}">+ ${esc(sg.name)}</button>`).join('')}</div>
      <div class="row" style="margin-top:.6rem"><button class="small" id="l-sugg-all">Add all suggested</button></div></section>` : ''}
    <p class="hint">Links open in a new tab. Passwords are never stored in this app.</p>`;
  const fromSugg = sg => ({ id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()), name: sg.name, url: sg.url, kind: sg.kind, notes: sg.notes || null,
    account_id: sg.kind === 'bank' && sg.match ? (cache.accounts.find(a => sg.match.test(a.name) && !['mortgage', 'loan'].includes(a.account_type))?.id || null) : null,
    debt_id: sg.match && sg.kind !== 'bank' ? (debtRows.find(d => sg.match.test(d.creditor))?.id || null) : null });
  $('#l-add').onclick = async () => { if (await linkForm()) linksView(); };
  view.querySelectorAll('.l-sugg').forEach(b => b.onclick = async () => { await saveLinks([...allLinks(), fromSugg(sugg[b.dataset.i])]); toast(`${sugg[b.dataset.i].name} added`); linksView(); });
  $('#l-sugg-all')?.addEventListener('click', async e => { await busy(e.target, () => saveLinks([...allLinks(), ...sugg.map(fromSugg)])); toast(`${sugg.length} links added`); linksView(); });
  view.querySelectorAll('.l-edit').forEach(b => b.onclick = async () => { if (await linkForm(allLinks().find(l => l.id === b.dataset.id))) linksView(); });
  view.querySelectorAll('.l-del').forEach(b => b.onclick = async () => {
    const before = allLinks(), gone = before.find(l => l.id === b.dataset.id);
    await saveLinks(before.filter(l => l.id !== b.dataset.id)); linksView();
    toast(`${gone.name} removed`, { action: 'Undo', onAction: async () => { await saveLinks(before); linksView(); } });
  });
  view.querySelectorAll('.l-upd').forEach(b => b.onclick = async () => { if (await openForm('debts', debtRows.find(d => d.id === b.dataset.debt))) linksView(); });
  view.querySelectorAll('[data-go]').forEach(b => b.onclick = () => show(b.dataset.go));
}

// ---------- HOUSEHOLD MEMBERS (people inside this login) ----------
TABLES.household_members = { title: 'People in the household', addTitle: 'person', order: ['sort_order'],
  fields: [
    { k: 'name', label: 'Name', type: 'text', required: true, hint: 'First name is fine' },
    { k: 'relationship', label: 'Who they are', type: 'select', options: Object.keys(RELATIONSHIPS), labels: () => RELATIONSHIPS, default: 'partner' },
    { k: 'email', label: 'Email (optional)', type: 'email' },
    { k: 'phone', label: 'Phone (optional)', type: 'tel' },
    { k: 'notes', label: 'Notes', type: 'textarea', hint: 'e.g. pays board weekly, on Centrelink, shares the power bill' },
  ], columns: ['name', 'relationship', 'email', 'phone'] };
async function membersView() {
  await loadLookups();
  const ms = cache.members;
  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Household</h1>
      <p class="hint">The people whose money this app tracks. Everyone uses this one login — each person gets their own view from the switch at the top, and bills, debts and accounts can be split between them.</p></div>
      <button class="primary" id="m-add">+ Add person</button></div>
    <div class="members">${ms.map(m => `<section class="card member">
      <div class="member-head"><span class="avatar" aria-hidden="true">${esc((memberName(m)[0] || '?').toUpperCase())}</span>
        <div><h2>${m.name ? esc(m.name) : '<span class="muted">No name yet</span>'}</h2><span class="pill">${esc(m.is_primary ? 'Main person (you)' : RELATIONSHIPS[m.relationship] || m.relationship)}</span></div></div>
      <dl class="member-dl">${m.email ? `<dt>Email</dt><dd>${esc(m.email)}</dd>` : ''}${m.phone ? `<dt>Phone</dt><dd>${esc(m.phone)}</dd>` : ''}${m.notes ? `<dt>Notes</dt><dd>${esc(m.notes)}</dd>` : ''}</dl>
      <p class="hint">Centrelink: ${m.centrelink?.rule && m.centrelink.rule !== 'none' ? '<b>estimating JobSeeker</b>' : 'not set up'}</p>
      <div class="row"><button class="small m-edit" data-id="${m.id}">Edit details</button><button class="small m-cl" data-id="${m.id}">Centrelink</button>${m.is_primary ? '' : `<button class="small danger m-del" data-id="${m.id}">Remove</button>`}</div>
    </section>`).join('')}</div>
    <section class="card"><h2>How splitting works</h2>
      <p>New bills, debts and accounts are <b>split equally</b> between everyone unless you choose otherwise. Open any bill, debt or account and use <b>Who pays</b> to give it to one person or set your own percentages.</p>
      <p class="hint">Adding a person re-spreads the items that are split equally; items with their own percentages stay as they are (the new person gets 0% of those until you change them). Removing a person shares their part out between the others.</p></section>`;
  $('#m-add').onclick = async () => {
    if (await openForm('household_members', null, { sort_order: ms.length, is_primary: false })) { await loadLookups(); renderWhoSwitch(); membersView(); }
  };
  view.querySelectorAll('.m-edit').forEach(b => b.onclick = async () => {
    const m = memberById(b.dataset.id);
    const fixed = m.is_primary ? { relationship: 'me' } : {};
    if (await openForm('household_members', m, fixed)) { await loadLookups(); renderWhoSwitch(); membersView(); }
  });
  view.querySelectorAll('.m-cl').forEach(b => b.onclick = async () => { if (await centrelinkSettings(memberById(b.dataset.id))) { await loadLookups(); membersView(); } });
  view.querySelectorAll('.m-del').forEach(b => b.onclick = async () => {
    const m = memberById(b.dataset.id);
    if (!confirm(`Remove ${memberName(m)} from the household?\n\nTheir share of any split bills, debts and accounts is shared out between the others. Their payslips are kept but no longer linked to anyone.`)) return;
    await q(sb.from('household_members').delete().eq('id', m.id));
    if (personView === m.id) { personView = 'all'; try { localStorage.setItem('personView', 'all'); } catch {} }
    toast(`${memberName(m)} removed`); await loadLookups(); renderWhoSwitch(); membersView();
  });
}

// First visit: the main person has no name yet — ask for their details (and anyone else in the house)
function welcomeForm() {
  const me = cache.members.find(m => m.is_primary);
  if (!me || (me.name && me.name.trim())) return;
  try { if (sessionStorage.getItem('welcomeLater')) return; } catch {}
  const dlg = document.createElement('dialog'); dlg.className = 'welcome';
  dlg.innerHTML = `<form method="dialog"><h2>Welcome 👋</h2>
    <p>Let’s set up your household. Start with you — you can add other people now or later.</p>
    <div class="formgrid">
      <label>Your name <input name="name" required autocomplete="given-name" placeholder="First name"></label>
      <label>Email <span class="hint">optional</span><input name="email" type="email" autocomplete="email"></label>
      <label>Phone <span class="hint">optional</span><input name="phone" type="tel" autocomplete="tel"></label>
    </div>
    <h3>Anyone else whose money is part of this household?</h3>
    <p class="hint">A partner, ex-partner you share costs with, a boarder, an adult child… Leave this empty if it’s just you.</p>
    <div id="w-others"></div>
    <button type="button" class="small" id="w-add">+ Add another person</button>
    <div class="row" style="margin-top:1rem"><button class="primary" value="save">Save and start</button><button value="later" formnovalidate>Later</button></div></form>`;
  document.body.appendChild(dlg);
  const others = $('#w-others', dlg);
  const addRow = () => { const d = document.createElement('div'); d.className = 'formgrid w-row';
    d.innerHTML = `<label>Name <input class="w-name"></label><label>Who they are <select class="w-rel">${Object.entries(RELATIONSHIPS).filter(([k]) => k !== 'me').map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
      <button type="button" class="small ghost w-x" aria-label="Remove">✕</button>`;
    d.querySelector('.w-x').onclick = () => d.remove(); others.appendChild(d); d.querySelector('.w-name').focus(); };
  $('#w-add', dlg).onclick = addRow;
  const form = $('form', dlg);
  form.addEventListener('submit', async e => {
    if (e.submitter?.value !== 'save') { try { sessionStorage.setItem('welcomeLater', '1'); } catch {} return; }
    e.preventDefault();
    await busy(e.submitter, async () => {
      await q(sb.from('household_members').update({ name: form.name.value.trim(), email: form.email.value.trim() || null, phone: form.phone.value.trim() || null }).eq('id', me.id));
      const rows = [...others.querySelectorAll('.w-row')].map((r, i) => ({ name: r.querySelector('.w-name').value.trim(), relationship: r.querySelector('.w-rel').value, sort_order: i + 1, is_primary: false })).filter(r => r.name);
      if (rows.length) await q(sb.from('household_members').insert(rows));
    });
    dlg.close(); await loadLookups(); renderWhoSwitch(); toast('All set ✓'); show(currentView);
  });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

// ---------- SETUP ----------
async function setup() {
  const s = cache.settings || {};
  view.innerHTML = `<div class="page-head"><div><h1 class="page-title">Setup</h1><p class="hint">Settings, bank accounts, categories and sorting rules.</p></div></div><div class="card"><h2>Settings</h2><form id="set"><div class="formgrid">
      <div class="full"><div class="field-label">People in the household</div><p class="hint">${cache.members.map(m => esc(memberName(m))).join(', ')} · <button type="button" class="link" data-go-members>Add or edit people</button></p></div>
      <div class="full"><div class="field-label">Usual split for everyday spending ${info('Used for spending that isn’t a set-up bill (groceries, fuel, Afterpay…) when working out each person’s share, and as the starting split for new joint accounts and subscriptions.')}</div>${splitEditor('default_split', s.default_split)}</div>
      <label>How often you're paid <select name="pay_frequency">${FREQ.filter(f => f !== 'once').map(f => `<option ${f === (s.pay_frequency || 'fortnightly') ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
      <label>Next pay date <input type="date" name="next_pay_date" value="${esc(s.next_pay_date)}"></label>
      <label>Safety buffer goal <input type="number" step="1" name="buffer_target" value="${esc(s.buffer_target ?? 1000)}"></label>
    </div><button class="primary">Save settings</button></form></div>
    <div class="card" id="u-acc"></div><div class="card" id="u-cat"></div><div class="card" id="u-rule"></div>`;
  wireSplits($('#set')); wireInfoTips();
  $('#set [data-go-members]').onclick = () => show('members');
  $('#set').onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    let ds; try { ds = readSplit(f, 'default_split'); } catch (err) { toast(err.message, { kind: 'bad' }); return; }
    await q(sb.from('settings').update({ default_split: ds, default_my_share_pct: Math.round(shareFor(ds, primaryId()) * 100),
      pay_frequency: f.pay_frequency.value, next_pay_date: f.next_pay_date.value || null,
      buffer_target: Number(f.buffer_target.value) }).eq('owner_id', session.user.id));
    await loadLookups(); toast('Settings saved');
  };
  await Promise.all([renderCrud($('#u-acc'), 'accounts'), renderCrud($('#u-cat'), 'categories'),
    renderCrud($('#u-rule'), 'category_rules', { onChange: async () => { const n = await q(sb.rpc('recategorise_uncategorised')); toast(`Rules re-run — ${n} transaction(s) updated`); await renderCrud($('#u-rule'), 'category_rules'); } })]);
}

// ---------- navigation & auth ----------
const VIEWS = { dashboard, insights: insightsView, members: membersView, report: reportView, links: linksView, budget, goals, bills, income, debts, transactions, sort: sortView, import: importView, shared, pay: payView, tax: taxView, setup };
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
$('#theme-btn').onclick = () => setPref('theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', rerender);
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
  welcomeForm();
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
