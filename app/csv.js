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
    format = isWestpac ? 'westpac' : 'generic';
    // Separate Debit/Credit columns win over a single Amount column (fuzzy "amount" would match "Debit Amount")
    map = { date, desc, amount: (debit >= 0 && credit >= 0) ? -1 : amount, debit, credit, balance };
    if (date < 0 || desc < 0 || (map.amount < 0 && debit < 0 && credit < 0)) {
      return { format: 'unknown', rows: [], skipped: [], error:
        'Could not find Date, Description and Amount (or Debit/Credit) columns in this file. Headers found: ' + h.join(', ') };
    }
  } else if (first.length >= 3 && parseDate(first[0]) && parseMoney(first[1]) !== null) {
    // CommBank NetBank export: Date, Amount, Description, Balance (no header row)
    format = 'commbank';
    body = all; startLine = 1;
    map = { date: 0, amount: 1, desc: 2, balance: first.length >= 4 ? 3 : -1, debit: -1, credit: -1 };
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
    rows.push({ date, description: description || '(no description)', amount: Math.round(amount * 100) / 100, balance });
  });
  return { format, rows, skipped };
}
