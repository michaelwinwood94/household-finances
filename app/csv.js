// Bank CSV parsing — Westpac, CommBank and a generic fallback.
// Pure functions (no browser APIs) so they can be tested on their own.

export function parseCsvText(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows.map(r => r.map(c => c.trim()));
}

export function parseMoney(s) {
  if (s == null) return null;
  let t = String(s).trim();
  if (t === '') return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/\bDR\b/i.test(t)) { neg = true; }
  t = t.replace(/\b(CR|DR)\b/gi, '').replace(/[$,\s]/g, '');
  if (t.startsWith('-')) { neg = !neg; t = t.slice(1); }
  if (t.startsWith('+')) t = t.slice(1);
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return neg ? -n : n;
}

// Australian dates: dd/mm/yyyy, d/m/yy, yyyy-mm-dd, "20 Nov 2026"
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
export function parseDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return iso(y, +m[2], +m[1]); }
  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}
function iso(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const norm = h => h.toLowerCase().replace(/[^a-z]/g, '');
function findCol(headers, names) {
  const h = headers.map(norm);
  for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; }
  for (const n of names) { const i = h.findIndex(x => x.includes(n)); if (i >= 0) return i; }
  return -1;
}

// Returns { format, rows:[{date,description,amount,balance}], skipped:[{line,reason,raw}] }
export function parseBankCsv(text) {
  const all = parseCsvText(text);
  if (!all.length) return { format: 'empty', rows: [], skipped: [] };
  const first = all[0];
  const looksLikeHeader = first.some(c => /date|narrative|description|amount|debit|credit|balance/i.test(c))
                          && !parseDate(first[0]);

  let format, map, body, startLine;
  if (looksLikeHeader) {
    const h = first;
    body = all.slice(1); startLine = 2;
    const date = findCol(h, ['date', 'transactiondate', 'effectivedate']);
    const desc = findCol(h, ['narrative', 'description', 'details', 'transactiondetails', 'memo', 'payee']);
    const amount = findCol(h, ['amount', 'transactionamount']);
    const debit = findCol(h, ['debitamount', 'debit', 'withdrawal', 'withdrawals', 'moneyout']);
    const credit = findCol(h, ['creditamount', 'credit', 'deposit', 'deposits', 'moneyin']);
    const balance = findCol(h, ['balance', 'runningbalance']);
    const isWestpac = h.map(norm).includes('narrative') && h.map(norm).includes('bankaccount');
    const hn = h.map(norm).join('|');
    format = isWestpac ? 'westpac' : hn === 'transactiondate|description|amount|balance' ? 'commbank' : 'generic';
    // Separate Debit/Credit columns win over a single Amount column (fuzzy "amount" would match "Debit Amount")
    map = { date, desc, amount: (debit >= 0 && credit >= 0) ? -1 : amount, debit, credit, balance,
            acct: findCol(h, ['bankaccount', 'accountnumber']) };
    if (date < 0 || desc < 0 || (map.amount < 0 && debit < 0 && credit < 0)) {
      return { format: 'unknown', rows: [], skipped: [], error:
        'Could not find Date, Description and Amount (or Debit/Credit) columns in this file. Headers found: ' + h.join(', ') };
    }
  } else if (first.length >= 3 && parseDate(first[0]) && parseMoney(first[1]) !== null) {
    // CommBank NetBank export: Date, Amount, Description, Balance (no header row)
    format = 'commbank';
    body = all; startLine = 1;
    map = { date: 0, amount: 1, desc: 2, balance: first.length >= 4 ? 3 : -1, debit: -1, credit: -1, acct: -1 };
  } else {
    return { format: 'unknown', rows: [], skipped: [], error:
      'This file doesn’t look like a Westpac or CommBank export. First line: ' + first.join(', ') };
  }

  const rows = [], skipped = [];
  body.forEach((r, i) => {
    const line = startLine + i;
    const date = parseDate(r[map.date]);
    const description = (r[map.desc] || '').replace(/\s+/g, ' ').trim();
    let amount = null;
    if (map.amount >= 0) amount = parseMoney(r[map.amount]);
    else {
      const d = map.debit >= 0 ? parseMoney(r[map.debit]) : null;
      const c = map.credit >= 0 ? parseMoney(r[map.credit]) : null;
      if (d !== null && d !== 0) amount = -Math.abs(d);
      else if (c !== null && c !== 0) amount = Math.abs(c);
      else if (d === 0 || c === 0) amount = 0;
    }
    const balance = map.balance >= 0 ? parseMoney(r[map.balance]) : null;
    if (!date) return skipped.push({ line, reason: 'date not recognised', raw: r.join(', ') });
    if (amount === null) return skipped.push({ line, reason: 'amount not recognised', raw: r.join(', ') });
    if (amount === 0) return skipped.push({ line, reason: 'zero amount', raw: r.join(', ') });
    const row = { date, description: description || '(no description)', amount: Math.round(amount * 100) / 100, balance };
    if (map.acct >= 0 && r[map.acct]) row.acct = r[map.acct].replace(/\D/g, '');
    rows.push(row);
  });
  return { format, rows, skipped };
}

// ---------- Westpac "Account activity" PDF (from the Westpac app / online banking) ----------
// Input: pages of text items [{str, x, y}] (pdf.js gives y from the bottom of the page).
// Each transaction has its date and amount on one line; description lines can sit just above and below it.

export function linesFromItems(pages, tol = 1.5) {
  const out = [];
  pages.forEach((items, p) => {
    const sorted = items.filter(i => i.str && i.str.trim()).slice().sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      const ln = lines.find(l => Math.abs(l.y - it.y) <= tol);
      if (ln) ln.items.push(it); else lines.push({ y: it.y, items: [it] });
    }
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      out.push({ page: p, y: l.y, x: l.items[0].x, text: l.items.map(i => i.str.trim()).join(' ').replace(/\s+/g, ' ').trim() });
    }
  });
  return out;
}

const DATE_RE = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})\b\s*(.*)$/;
const AMT_RE = /(-?)\$([\d,]+\.\d{2})\s*$/;

export function parseWestpacActivity(pages) {
  const lines = linesFromItems(pages);
  const p0 = lines.filter(l => l.page === 0);
  const hdrIdx = p0.findIndex(l => /^Date\b.*Description.*Debit.*Credit/.test(l.text));
  if (hdrIdx < 0) return { format: 'unknown', rows: [], skipped: [], error: 'This PDF doesn’t look like a Westpac "Account activity" export.' };

  // Account details from the header block
  const meta = p0.slice(0, hdrIdx).map(l => l.text).filter(t => !/^(Account activity|Transactions)$/i.test(t));
  const numIdx = meta.findIndex(t => /^\d{3}-\d{3}\s+\d{4,}$/.test(t));
  const name = (numIdx > 0 ? meta.slice(0, numIdx) : meta.slice(0, 1)).join(' ').trim();
  const last4 = numIdx >= 0 ? meta[numIdx].replace(/\D/g, '').slice(-4) : '';
  const balLine = meta.find(t => /^-?\$[\d,]+\.\d{2}$/.test(t));
  const balance = balLine ? parseMoney(balLine) : null;

  const hdrY = p0[hdrIdx].y;
  const body = lines.filter(l => !(l.page === 0 && l.y >= hdrY - 0.5))
    .filter(l => !/^(Copyright|ABN)\b/.test(l.text));

  const anchors = [], extras = [];
  for (const l of body) {
    const m = l.text.match(DATE_RE);
    if (m && MONTHS[m[2].toLowerCase()]) {
      let rest = m[4];
      const a = rest.match(AMT_RE);
      let amount = null;
      if (a) { amount = Number(a[2].replace(/,/g, '')) * (a[1] === '-' ? -1 : 1); rest = rest.slice(0, a.index).trim(); }
      anchors.push({ ...l, date: iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]), amount, own: rest, above: [], below: [] });
    } else extras.push(l);
  }
  for (const e of extras) {
    let best = null, bd = Infinity;
    for (const a of anchors) { if (a.page !== e.page) continue; const d = Math.abs(a.y - e.y); if (d < bd) { bd = d; best = a; } }
    if (best && bd < 12) (e.y > best.y ? best.above : best.below).push(e);
  }
  const rows = [], skipped = [];
  anchors.forEach((a, i) => {
    const desc = [...a.above.sort((x, y) => y.y - x.y), { text: a.own }, ...a.below.sort((x, y) => y.y - x.y)]
      .map(x => x.text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (a.amount === null) return skipped.push({ line: i + 1, reason: 'amount not found', raw: desc });
    rows.push({ date: a.date, description: desc || '(no description)', amount: Math.round(a.amount * 100) / 100, balance: null });
  });
  return { format: 'westpac-pdf', account: { name, last4, balance }, rows, skipped };
}

// A Westpac CSV export can hold several accounts (one "Bank Account" column).
// Split it into one parsed result per account, each tagged with the account's last 4 digits.
export function splitAccounts(parsed) {
  if (!parsed.rows.some(r => r.acct)) return [parsed];
  const groups = new Map();
  for (const r of parsed.rows) {
    const k = r.acct || '';
    if (!groups.has(k)) groups.set(k, []);
    const { acct, ...rest } = r;
    groups.get(k).push(rest);
  }
  return [...groups.entries()].map(([acct, rows]) => ({
    ...parsed, rows, skipped: groups.size === 1 ? parsed.skipped : [],
    account: { name: null, last4: acct.slice(-4) || '', number: acct, balance: null },
  }));
}

// Latitude loan statement PDF ("Transaction Details": date dd-mm-yyyy, description, Credit, Debit).
// Loan sign convention (same as the Westpac loan PDFs): repayments/waivers are +, interest and fees are −,
// so the account balance is the amount owed shown as a negative number.

export function isLatitudeStatement(pages) {
  const t = (pages[0] || []).map(i => i.str).join(' ');
  return /Latitude/i.test(t) && /Transaction Description/i.test(pages.flat().map(i => i.str).join(' ')) && /Account Number/i.test(t);
}

export function parseLatitudeStatement(pages) {
  // Some PDF readers split dates into pieces ("26 - 05 - 2023"); tidy them back up first
  const lines = linesFromItems(pages, 4).map(l => l.text
    .replace(/(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4})/g, '$1-$2-$3')
    .replace(/([A-Z]{2,4})\s*-\s*(\d{4,})/g, '$1-$2'));
  const all = lines.join('\n');
  const num = s => Number(s.replace(/,/g, ''));
  const grab = re => { const m = all.match(re); return m ? m[1] : null; };
  const acctNo = grab(/Account Number:\s*([A-Z0-9-]+)/);
  const closing = grab(/\d{2}-\d{2}-\d{4}\s+Closing Balance\s+\$\s?([\d,]+\.\d{2})/) || grab(/Closing Balance as at \d{2}-\d{2}-\d{4}\s+\$\s?([\d,]+\.\d{2})/);
  const overdue = grab(/Amount overdue\s*\*?\s*:\s*\$\s?([\d,]+\.\d{2})/);
  const minPay = grab(/Minimum Monthly Payment:\s*\$\s?([\d,]+\.\d{2})/);
  const rate = grab(/Current Interest Rate:\s*([\d.]+)%/);
  const due = all.match(/Next Payment Due Date:\s*(\d{2})-(\d{2})-(\d{4})/);
  const stmt = all.match(/Statement date:\s*(\d{2})-(\d{2})-(\d{4})/);
  let start = lines.findIndex(t => /Transaction\s+Description/.test(t));
  if (start < 0) start = lines.findIndex(t => /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\s.*\$\s?[\d,]+\.\d{2}\s+\$\s?[\d,]+\.\d{2}/.test(t)) - 1;
  if (start < -1 || (start < 0 && !lines.some(t => /\$\s?[\d,]+\.\d{2}\s+\$\s?[\d,]+\.\d{2}/.test(t)))) return { format: 'unknown', rows: [], skipped: [], error: 'This PDF doesn’t look like a Latitude loan statement.' };

  const rows = [], skipped = [];
  const AMT_G = /\$\s?([\d,]+\.\d{2})/g;
  const amtsOf = t => [...t.matchAll(AMT_G)].map(m => ({ v: num(m[1]), i: m.index }));
  let pending = null; // date from a wrapped "30-04-2024 14.99%" line, applies to the dateless row after it
  for (const t of lines.slice(start + 1)) {
    if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\s+Closing Balance/.test(t)) break;
    if (/Opening Balance|Closing Balance|^Important Information|Licence Number|^Page \d/.test(t)) continue;
    const dm = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b\s*(.*)$/);
    const body = dm ? dm[4] : t;
    const a = amtsOf(body);
    let d, desc;
    if (dm && a.length >= 2) { d = iso(+dm[3], +dm[2], +dm[1]); desc = body.slice(0, a[0].i); pending = null; }
    else if (dm) { pending = iso(+dm[3], +dm[2], +dm[1]); continue; }
    else if (a.length >= 2 && pending) { d = pending; desc = body.slice(0, a[0].i); }
    else continue;
    const cr = a[0].v, db = a[1].v;
    if (cr === 0 && db === 0) continue; // interest-rate change notes
    rows.push({ date: d, description: desc.replace(/\s+/g, ' ').trim(), amount: Math.round((cr - db) * 100) / 100, balance: null });
  }
  if (!rows.length) return { format: 'latitude-pdf', rows: [], skipped: [], error: 'Latitude statement recognised but no transactions could be read. Layout seen: ' + lines.slice(start, start + 4).map(t => t.slice(0, 70)).join(' | ') };
  const toIso = m => m ? iso(+m[3], +m[2], +m[1]) : null;
  return {
    format: 'latitude-pdf',
    account: { name: 'Latitude personal loan', last4: acctNo ? acctNo.replace(/\W/g, '').slice(-4) : '', balance: closing != null ? -num(closing) : null },
    statement: { closing: closing != null ? num(closing) : null, overdue: overdue != null ? num(overdue) : null, minPayment: minPay != null ? num(minPay) : null,
      rate: rate != null ? Number(rate) : null, due: toIso(due), date: toIso(stmt) },
    rows: rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0), skipped: skipped.filter(s => s.line),
  };
}
