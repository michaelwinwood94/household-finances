// Afterpay / Deferit screenshot reader: turns OCR'd text boxes from a phone screenshot of the portal's
// "upcoming payments" list into instalment rows. Pure functions (no browser needed) so they can be tested.
// Input is what the text reader returns for each screen region: lines/words with a vertical position (y0, y1).
// Everything it produces is shown for checking before anything is saved.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthIdx = s => { const m = MONTHS.indexOf((s || '').toLowerCase().slice(0, 3)); return m; };
const pad = n => String(n).padStart(2, '0');
const mid = o => (o.y0 + o.y1) / 2;

// ---- shop names ----
const SMALL = new Set(['and', 'of', 'the', 'at', 'in', 'on']);
export function cleanMerchant(raw) {
  let s = String(raw || '').replace(/^[^A-Za-z0-9]*[a-z]{1,2}(?=\s+[A-Z0-9])/, '').replace(/[|@_~]+/g, ' ').replace(/^[^A-Za-z0-9]+/, '').replace(/[.…]{2,}\s*$|…\s*$/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/\s+(pty\.?\s*)?ltd\.?$/i, '').replace(/\s+pty\.?$/i, '').trim();
  if (s && s === s.toUpperCase() && /[A-Z]/.test(s)) {
    s = s.toLowerCase().replace(/(^|[\s\-'/&])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Kfc|Iga|Otr|Bp|Ig|Cba)\b/g, w => w.toUpperCase());
    s = s.split(' ').map((w, i) => i && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w).join(' ');
  }
  return s;
}
export const shopKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// match a shop name to remembered keys (a scanned name may be cut off with "..." or carry a store number)
export function bestShopKey(name, keys) {
  const k = shopKey(name); if (k.length < 3) return null;
  let best = null;
  for (const key of keys) {
    if (key === k) return key;
    if (key.length >= 4 && k.length >= 4 && (k.startsWith(key) || key.startsWith(k)) && (!best || key.length > best.length)) best = key;
  }
  return best;
}

// ---- dates ----
// "Tue, 1 Dec 2026" -> 2026-12-01. Returns null when no date is found.
export function parseLongDate(s) {
  const m = /(\d{1,2})\s*([A-Za-z]{3})[A-Za-z]*\.?,?\s*(20\d{2})/.exec(s || '');
  if (!m || monthIdx(m[2]) < 0) return null;
  const d = Number(m[1]); if (d < 1 || d > 31) return null;
  return `${m[3]}-${pad(monthIdx(m[2]) + 1)}-${pad(d)}`;
}
// A day + month with no year (Deferit): use the next occurrence that is not more than ~2 months in the past.
export function inferYear(day, monthIndex, todayISO) {
  const t = new Date(todayISO + 'T00:00:00');
  for (const y of [t.getFullYear() - 1, t.getFullYear(), t.getFullYear() + 1]) {
    const d = new Date(y, monthIndex, day);
    if (d.getMonth() === monthIndex && d >= new Date(t.getFullYear(), t.getMonth(), t.getDate() - 60)) return `${y}-${pad(monthIndex + 1)}-${pad(day)}`;
  }
  return null;
}

const AMOUNT = /(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})(?!\d)/;
const toAmount = s => { const m = AMOUNT.exec(s || ''); return m ? Number(m[1].replace(/,/g, '') + '.' + m[2]) : null; };
const OF = /(\d)\s*(?:of|0f|o\s?f|ot)\s*(\d)/i;
const parseOf = s => { const m = OF.exec(s || ''); if (!m) return null; const a = Number(m[1]), b = Number(m[2]); return a >= 1 && b >= a && b <= 9 ? [a, b] : null; };

// ---- Afterpay: each purchase is two text lines (shop; "2 of 4 • Tue, 1 Dec 2026") with the amount button on the right ----
// regions: text = lines read from the middle column, amounts = words read from the right column
export function parseAfterpay({ text, amounts }) {
  const lines = [...text].filter(l => l.text && l.text.trim()).sort((a, b) => a.y0 - b.y0);
  const detail = l => parseLongDate(l.text) && parseOf(l.text);
  const out = [];
  const used = new Set();
  const amts = amounts.map(w => ({ v: toAmount(w.text), y: mid(w) })).filter(a => a.v != null && a.v > 0);
  lines.forEach((l, i) => {
    const date = parseLongDate(l.text); if (!date) return;
    const of = parseOf(l.text) || [null, null];
    // shop name: nearest line above that is not itself a detail line and has letters
    let name = null;
    for (let j = i - 1; j >= 0 && j >= i - 2; j--) { if (!detail(lines[j]) && /[A-Za-z]{3}/.test(lines[j].text)) { name = lines[j]; break; } }
    const top = name ? name.y0 : l.y0 - (l.y1 - l.y0) * 1.5, bottom = l.y1;
    const centre = (top + bottom) / 2, half = (bottom - top) / 2 + (l.y1 - l.y0) * 0.6;
    let best = null;
    amts.forEach((a, k) => { if (used.has(k)) return; const dist = Math.abs(a.y - centre); if (dist <= half && (!best || dist < best.dist)) best = { k, dist, v: a.v }; });
    if (best) used.add(best.k);
    out.push({ provider: 'afterpay', merchant: cleanMerchant(name?.text || ''), instalment_no: of[0], instalments_total: of[1], due_date: date, amount: best ? best.v : null });
  });
  return out;
}

// ---- Deferit: a date block ("DEC" / "01"), then "SHOP NAME   $24.99" and "Instalment 2 of 4" (or "Monthly fee") ----
// regions: main = lines from the middle column, dates = lines from the date column
export function parseDeferit({ main, dates }, todayISO) {
  const mainLines = [...main].filter(l => l.text && l.text.trim()).sort((a, b) => a.y0 - b.y0);
  // date tokens from the date column: a month word and a day number, paired by position
  const tokens = [...dates].sort((a, b) => a.y0 - b.y0);
  const months = [], days = [];
  tokens.forEach(t => {
    const txt = t.text.trim();
    const mo = /^[A-Za-z]{3}$/.exec(txt); if (mo && monthIdx(mo[0]) >= 0) { months.push({ m: monthIdx(mo[0]), y: mid(t) }); return; }
    const dm = /^0?(\d{1,2})$/.exec(txt.replace(/\s+/g, '')); if (dm && Number(dm[1]) >= 1 && Number(dm[1]) <= 31) days.push({ d: Number(dm[1]), y: mid(t) });
  });
  const out = [];
  mainLines.forEach((l, i) => {
    const a = toAmount(l.text); if (a == null || !/[A-Za-z]{3}/.test(l.text.replace(AMOUNT, ''))) return;
    const next = mainLines[i + 1];
    const info = next && !toAmount(next.text) ? next.text : '';
    const isFee = /fee/i.test(info);
    const of = parseOf(info) || [null, null];
    const name = cleanMerchant(l.text.replace(/\$?\s*\d[\d,]*\.\d{2}.*$/, '').replace(/[|\[\]{}()]+\s*$/, ''));
    // nearest date block to this row
    const row = next && !toAmount(next.text) ? (l.y0 + next.y1) / 2 : mid(l);
    const near = (arr) => arr.reduce((b, x) => (!b || Math.abs(x.y - row) < Math.abs(b.y - row)) ? x : b, null);
    const dd = near(days), mm = near(months);
    const rowH = l.y1 - l.y0;
    const day = dd && Math.abs(dd.y - row) < rowH * 2.5 ? dd.d : null;
    const mon = mm && Math.abs(mm.y - row) < rowH * 4 ? mm.m : null;
    const due = day && mon != null ? inferYear(day, mon, todayISO) : null;
    out.push({ provider: 'deferit', merchant: isFee ? 'Deferit monthly fee' : name.trim(), instalment_no: of[0], instalments_total: of[1], due_date: due, amount: a, is_fee: isFee, _day: day });
  });
  // The month label is often too faint to read. The list is in date order, so work it out: the first row is the next
  // occurrence of that day of the month, and each later row stays in the same month unless the day number drops.
  let prev = null;
  out.forEach(r => {
    if (!r.due_date && r._day) {
      const t = new Date(todayISO + 'T00:00:00');
      let y, m;
      if (prev) { y = prev.y; m = prev.m + (r._day < prev.d ? 1 : 0); } else { y = t.getFullYear(); m = t.getMonth() + (r._day < t.getDate() ? 1 : 0); }
      const dt = new Date(y, m, r._day); r.due_date = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`; r.date_guessed = true;
    }
    if (r.due_date) { const [yy, mm, dd] = r.due_date.split('-').map(Number); prev = { y: yy, m: mm - 1, d: dd }; }
    delete r._day;
  });
  return out;
}

// merge rows read from several screenshots of the same list (overlapping scrolls repeat rows)
export function mergeRows(rows) {
  const seen = new Set(), out = [];
  for (const r of rows) {
    const k = [r.provider, shopKey(r.merchant).slice(0, 8), r.due_date, r.amount, r.instalment_no].join('|');
    if (seen.has(k)) continue; seen.add(k); out.push(r);
  }
  return out;
}

// is this scanned row already in the saved list? (same date and amount, and the shop names agree, allowing for cut-off names)
export function isKnown(row, existing) {
  const k = shopKey(row.merchant);
  return existing.some(e => e.due_date === row.due_date && Math.abs(Number(e.amount) - Number(row.amount)) < 0.025   // a text-read 6 can come out as 8
    && (() => { const ek = shopKey(e.merchant); return ek === k || (k.length >= 4 && ek.length >= 4 && (ek.startsWith(k) || k.startsWith(ek))) || (k.length >= 2 && ek.length >= 2 && k.slice(0, 2) === ek.slice(0, 2)); })());
}

// ---- PDFs saved from the portals' websites (picture-only, read as plain text lines) ----
const PAGE_NOISE = /^\d{1,2}\/\d{1,2}\/\d{2,4},|https?:|^\d+\s?\/\s?\d+$|Upcoming payments\s*\|?|^\W*afterpay\W*(TB)?\W*$|\bdays?\b|^\W*\$[\d,]+\.\d{2}(\s+\$[\d,]+\.\d{2})*\W*$/i;
function fragment(t) {
  let s = t.replace(/(?:pay\s*)?\$\s?[\d,]+(?:\.\d{2})?/ig, ' ').replace(/[|@_~«»<>—–=•*]+/g, ' ').replace(/^[^A-Za-z0-9]+/, '').replace(/\s+/g, ' ').trim();
  // an icon read as a short lowercase word in front of the shop name ("wow BigW", "cynic City Chic")
  s = s.replace(/^(?:[A-Za-z]{1,2}\)|[a-z]{1,6}|WE|[A-Z]{1,2})\s+(?=[A-Z0-9][A-Za-z0-9])/, (m) => /^(?:[A-Z]{2}|[A-Z])\s/.test(m) && !/^WE\s/.test(m) && m.trim().length > 1 && /\s[A-Z]/.test(m) && false ? m : '');
  return s;
}
export function parseAfterpayText(lines) {
  const out = []; let buf = [];
  for (const raw of lines) {
    const l = String(raw || '').trim(); if (!l) continue;
    const date = parseLongDate(l);
    if (!date) { if (!PAGE_NOISE.test(l)) buf.push(l); continue; }
    const block = buf; buf = [];
    const am = block.map(b => /\$\s?([\d,]+\.\d{2})/.exec(b)).find(Boolean);
    const am2 = am ? null : block.map(b => /\$\s?(\d{3,5})\b/.exec(b)).find(Boolean); // decimal point lost by OCR
    const amount = am ? Number(am[1].replace(/,/g, '')) : am2 ? Number(am2[1]) / 100 : null;
    const cands = block.map(fragment).filter(f => (f.match(/[A-Za-z]/g) || []).length >= 2 && !/^[A-Za-z]{1,2}$/.test(f) || /^[A-Z][a-z]$/.test(f));
    let name = cands.length > 1 && cands[0].replace(/\W/g, '').length <= 3 && cands[1].replace(/\W/g, '').length <= 5 ? cands[0] + cands[1]
      : cands.reduce((b, c) => (c.length > b.length ? c : b), '');
    const lo = /([1-4])\s*(?:of|0f|ot)\s*4/i.exec(l); const of = parseOf(l) || (lo ? [Number(lo[1]), 4] : [null, null]);
    out.push({ provider: 'afterpay', merchant: cleanMerchant(name), instalment_no: of[0], instalments_total: of[1] || 4, due_date: date, amount });
  }
  return out;
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export function parseDeferitText(lines, todayISO) {
  const out = []; let hdr = null, mon = null;
  const L = lines.map(x => String(x || '').trim()).filter(Boolean);
  L.forEach((l, i) => {
    const h = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})/i.exec(l);
    if (h) { hdr = { m: MONTH_NAMES.indexOf(h[1].toLowerCase()), y: Number(h[2]) }; return; }
    const mm = /^([A-Z]{3})$/.exec(l); if (mm && monthIdx(mm[1]) >= 0) { mon = monthIdx(mm[1]); return; }
    const kind = /(Instalment|Monthly\s*fee)/i.exec(l); const a = toAmount(l);
    if (!kind || a == null) return;
    const isFee = /fee/i.test(kind[1]);
    const before = l.slice(0, kind.index);
    const dm = /(?:^|\s)0?(\d{1,2})\s+(?:\S{0,5}\s+)?$/.exec(before + ' ') || /(?:^|\s)0?(\d{1,2})\s*$/.exec(before.trim() + ' ');
    let day = dm ? Number(dm[1]) : null, name = '';
    const nm = /([A-Za-z]{1,3})\s?\.{2,}|([A-Za-z]{1,3})…/.exec(before); if (nm) name = nm[1] || nm[2];
    const prev = L[i - 1] || '';
    if (!name) { const pm = /^([A-Za-z]{1,3})\s?(\.{2,}|…)$/.exec(prev); if (pm) name = pm[1]; }
    if (day == null || day < 1 || day > 31) { const pd = /^0?(\d{1,2})$/.exec(prev); day = pd ? Number(pd[1]) : null; }
    const of = parseOf(l.slice(kind.index)) || [null, null];
    let due = null;
    if (day && mon != null) { const y = hdr ? (mon < hdr.m - 6 ? hdr.y + 1 : mon > hdr.m + 6 ? hdr.y - 1 : hdr.y) : null; due = y ? `${y}-${pad(mon + 1)}-${pad(day)}` : inferYear(day, mon, todayISO); }
    out.push({ provider: 'deferit', merchant: isFee ? 'Deferit monthly fee' : name.trim(), truncated: !isFee, instalment_no: of[0], instalments_total: of[1], due_date: due, amount: a, is_fee: isFee });
  });
  return out;
}

// A cut-off shop name ("R…") is matched to a shop already in the saved list with the same amount (instalments of one purchase are equal)
export function resolveTruncated(row, existing) {
  if (!row.truncated || !row.merchant) return row;
  const p = shopKey(row.merchant);
  const pick = (pre) => [...new Set(existing.filter(e => Math.abs(Number(e.amount) - Number(row.amount)) < 0.005 && shopKey(e.merchant).startsWith(pre)).map(e => e.merchant))];
  let cands = pick(p);
  if (!cands.length && p.length > 1) cands = pick(p.slice(-1));   // a stray icon read as a letter in front of the real initial
  return cands.length === 1 ? { ...row, merchant: cands[0], truncated: false } : row;
}

// Which provider's "Upcoming payments" page is this (lines of text read from a picture-only PDF)? null if neither.
export function detectBnplPdf(pages) {
  const t = pages.flat().join('\n');
  const n = (re) => (t.match(re) || []).length;
  if (/deferit/i.test(t) && n(/Instalment|Monthly\s*fee/gi) >= 2) return 'deferit';
  if (n(/\bpay\s*\$\s?[\d,]+/gi) >= 3 && n(/\b[1-4]\s*(?:of|0f|ot)\s*4/gi) >= 3) return 'afterpay';
  return null;
}
export function parseBnplPdf(provider, pages, todayISO) {
  const lines = pages.flat();
  return provider === 'deferit' ? parseDeferitText(lines, todayISO) : parseAfterpayText(lines);
}

// ---- Text copied from the Deferit "Upcoming payments" page (Ctrl+A, Ctrl+C) ----
export function parseDeferitPaste(text, todayISO) {
  const L = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  let hdr = null; const out = [];
  for (let i = 0; i < L.length; i++) {
    const h = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})$/i.exec(L[i]);
    if (h) { hdr = { m: MONTH_NAMES.indexOf(h[1].toLowerCase()), y: Number(h[2]) }; continue; }
    if (!/^[A-Za-z]{3}$/.test(L[i]) || monthIdx(L[i]) < 0 || !/^\d{1,2}$/.test(L[i + 1] || '')) continue;
    const mon = monthIdx(L[i]), day = Number(L[i + 1]);
    // the rest of this entry runs until the next month/day pair
    let j = i + 2; const seg = [];
    while (j < L.length && !(/^[A-Za-z]{3}$/.test(L[j]) && monthIdx(L[j]) >= 0 && /^\d{1,2}$/.test(L[j + 1] || ''))) seg.push(L[j++]);
    const name = seg[0] || '', kind = seg.find(x => /^(Instalment|Monthly\s*fee)/i.test(x)) || '';
    const am = seg.map(x => /^\$\s?([\d,]+\.\d{2})$/.exec(x)).find(Boolean);
    if (!kind || !am) continue;
    const isFee = /fee/i.test(kind), of = parseOf(kind) || [null, null];
    const y = hdr ? (mon < hdr.m - 6 ? hdr.y + 1 : mon > hdr.m + 6 ? hdr.y - 1 : hdr.y) : null;
    out.push({ provider: 'deferit', merchant: isFee ? 'Deferit monthly fee' : cleanMerchant(name), instalment_no: of[0], instalments_total: of[1], is_fee: isFee,
      due_date: y ? `${y}-${pad(mon + 1)}-${pad(day)}` : inferYear(day, mon, todayISO), amount: Number(am[1].replace(/,/g, '')) });
  }
  return out;
}
// Text copied from the Afterpay "Upcoming payments" page: merchant, "2 of 4", "Tue, 1 Dec 2026", "8 days", "$37.91"
export function parseAfterpayPaste(text) {
  const L = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean), out = [];
  for (let i = 1; i < L.length; i++) {
    const of = /^(\d)\s+of\s+(\d)$/i.exec(L[i]); if (!of) continue;
    const name = L[i - 1];
    let date = null, amount = null;
    for (let j = i + 1; j < Math.min(L.length, i + 8) && (date == null || amount == null); j++) {
      if (/^\d\s+of\s+\d$/i.test(L[j])) break;
      if (date == null) { const d = parseLongDate(L[j]); if (d) { date = d; continue; } }
      const a = /^\$\s?([\d,]+\.\d{2})$/.exec(L[j]); if (a && date) amount = Number(a[1].replace(/,/g, ''));
    }
    if (!date || amount == null) continue;
    out.push({ provider: 'afterpay', merchant: cleanMerchant(name), instalment_no: Number(of[1]), instalments_total: Number(of[2]), due_date: date, amount });
  }
  return out;
}
export function detectBnplPaste(text) {
  if (/Instalment\s+\d+\s+of\s+\d+/i.test(text) && /deferit/i.test(text)) return 'deferit';
  if (/^\d\s+of\s+\d$/im.test(text) && /afterpay|Pay now|Due in/i.test(text)) return 'afterpay';
  return null;
}
export function parseBnplPaste(provider, text, todayISO) { return provider === 'deferit' ? parseDeferitPaste(text, todayISO) : parseAfterpayPaste(text); }
