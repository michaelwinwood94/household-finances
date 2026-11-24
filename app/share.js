// View-only Report: reads a frozen snapshot through the public get_shared_report() function using the secret after the # in the address.
// No sign-in, no editing, nothing but the snapshot is reachable from here.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js?v=202611241700';

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
const money = n => n == null ? '—' : AUD.format(Number(n));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = iso => iso ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const view = document.getElementById('view');

export function renderReport(res) {
  const s = res.snapshot, per = s.per, sm = s.summary;
  const rows = (items, f) => items.map(f).join('');
  const sec = (title, body, total) => `<section class="card"><h2>${title}${total != null ? ` <span class="rpt-total">${money(total)} per ${esc(per)}</span>` : ''}</h2>${body}</section>`;
  view.innerHTML = `
    <div class="page-head"><div><h1 class="page-title">Financial position — ${esc(s.who)}</h1>
      <p class="hint">As at ${esc(fmt(s.as_at))}. Amounts are per ${esc(per)}. Spending averaged over ${esc(s.range)} (${s.months_n} full month${s.months_n > 1 ? 's' : ''}).</p></div>
      <div class="row no-print"><button class="primary" id="sh-print">Print / PDF</button></div></div>
    <div class="callout">This is a view-only copy taken on ${esc(fmt(res.created_at))}. The link stops working on ${esc(fmt(res.expires_at))}.</div>
    ${sec('Summary', `<table class="list rpt-tbl"><tbody>
      <tr><td>Total income</td><td class="num">${money(sm.income)}</td></tr>
      <tr><td>Total living expenses</td><td class="num">− ${money(sm.living)}</td></tr>
      <tr class="total"><td><b>Total income less total living expenses (before repayments)</b></td><td class="num"><b class="${sm.available < 0 ? 'neg' : ''}">${money(sm.available)}</b></td></tr>
      <tr><td>Less current repayments being made</td><td class="num">− ${money(sm.repay)}</td></tr>
      <tr class="total"><td><b>${sm.after < 0 ? 'Shortfall' : 'Surplus'}</b></td><td class="num"><b class="${sm.after < 0 ? 'neg' : 'pos'}">${money(sm.after)}</b></td></tr></tbody></table>`)}
    ${sec('Income', s.income.length ? `<table class="list rpt-tbl"><tbody>${rows(s.income, x => `<tr><td>${esc(x.name)}<div class="hint">${esc(x.whose)}</div></td><td class="num">${money(x.per)}</td></tr>`)}</tbody>
      <tfoot><tr class="total"><td><b>Total income</b></td><td class="num"><b>${money(s.income_total)}</b></td></tr></tfoot></table>
      <p class="hint">Income actually received over the period averaged ${money(s.income_actual)} per ${esc(per)}.</p>` : '<p class="empty">No regular income recorded.</p>', s.income_total)}
    ${sec('Living expenses', `<table class="list rpt-tbl"><tbody>${rows(s.living, g => `<tr class="grp"><td><b>${esc(g.g)}</b></td><td class="num"><b>${money(g.total)}</b></td></tr>${rows(g.lines, ([n, v]) => `<tr class="sub"><td>${esc(n)}</td><td class="num">${money(v)}</td></tr>`)}`)}</tbody>
      <tfoot><tr class="total"><td><b>Total living expenses</b></td><td class="num"><b>${money(s.living_total)}</b></td></tr></tfoot></table>
      <p class="hint">Average actually spent. Mortgage, loans and buy-now-pay-later repayments are shown under Debts, not here.${s.oneoff ? ` ${s.oneoff.n} one-off purchase${s.oneoff.n === 1 ? '' : 's'} (about ${money(s.oneoff.per)} per ${esc(per)} if counted) ${s.oneoff.n === 1 ? 'is' : 'are'} not included in the ongoing figures.` : ''}${s.excluded?.length ? ` Left out of these figures: ${esc(s.excluded.join(', '))}.` : ''}</p>`, s.living_total)}
    ${sec('Month by month', `<table class="list rpt-tbl"><thead><tr><th>Month</th><th class="num">Money in</th><th class="num">Spending</th><th class="num">Left over</th></tr></thead><tbody>
      ${rows(s.months, r => `<tr><td data-label="Month">${esc(r.m)}</td><td class="num" data-label="Money in">${money(r.inn)}</td><td class="num" data-label="Spending">${money(r.out)}</td><td class="num ${r.left < 0 ? 'neg' : ''}" data-label="Left over">${money(r.left)}</td></tr>`)}</tbody>
      <tfoot><tr class="total"><td><b>Average</b></td><td class="num"><b>${money(s.avg.inn)}</b></td><td class="num"><b>${money(s.avg.out)}</b></td><td class="num"><b>${money(s.avg.left)}</b></td></tr></tfoot></table>`)}
    ${sec('Debts', s.debts.length ? `<table class="list rpt-tbl"><thead><tr><th>Owed to</th><th class="num">Balance</th><th class="num">Overdue</th><th class="num">Repayment</th></tr></thead><tbody>
      ${rows(s.debts, d => `<tr><td data-label="Owed to"><b>${esc(d.creditor)}</b><div class="hint">${esc(d.type)}${d.hardship ? ` · hardship: ${esc(d.hardship.toLowerCase())}` : ''}</div></td><td class="num" data-label="Balance">${money(d.balance)}</td><td class="num ${d.overdue > 0 ? 'neg' : ''}" data-label="Overdue">${d.overdue > 0 ? money(d.overdue) : '—'}</td><td class="num" data-label="Repayment">${d.repay > 0 ? money(d.repay) : '—'}</td></tr>`)}</tbody>
      <tfoot><tr class="total"><td><b>Total</b></td><td class="num"><b>${money(s.debt_total)}</b></td><td class="num"><b>${money(s.overdue_total)}</b></td><td class="num"><b>${money(s.repay_total)}</b></td></tr></tfoot></table>
      <p class="hint">Repayments are per ${esc(per)}.</p>` : '<p class="empty">No debts recorded.</p>')}
    ${sec('Bank balances and assets', `${s.cash.length ? `<table class="list rpt-tbl"><tbody>${rows(s.cash, a => `<tr><td>${esc(a.name)}</td><td class="num">${money(a.v)}</td></tr>`)}</tbody><tfoot><tr class="total"><td><b>Total in the bank</b></td><td class="num"><b>${money(s.cash_total)}</b></td></tr></tfoot></table>` : '<p class="empty">No bank balances recorded.</p>'}
      ${s.assets.length ? `<table class="list rpt-tbl"><tbody>${rows(s.assets, x => `<tr><td>${esc(x.q)}</td><td>${esc(x.a)}</td></tr>`)}</tbody></table>` : ''}`)}
    <p class="hint">Prepared from the household's own records. View-only copy; it does not update.</p>`;
  document.getElementById('sh-print')?.addEventListener('click', () => window.print());
}

async function load() {
  const token = decodeURIComponent(location.hash.slice(1));
  if (token.length < 32) { view.innerHTML = '<section class="card narrow"><h2>No report here</h2><p>This link is incomplete. Ask the sender for the full link.</p></section>'; return; }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_shared_report`, { method: 'POST', cache: 'no-store',
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_token: token }) });
    const res = r.ok ? await r.json() : null;
    if (!res || !res.snapshot) { view.innerHTML = '<section class="card narrow"><h2>This link has expired or been withdrawn</h2><p>Ask the sender for a new link.</p></section>'; return; }
    renderReport(res);
  } catch { view.innerHTML = '<section class="card narrow"><h2>Couldn’t load the report</h2><p>Check your connection and refresh the page.</p></section>'; }
}
if (typeof document !== 'undefined' && location.pathname.endsWith('share.html')) load();
