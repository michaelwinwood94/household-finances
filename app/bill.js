// Reads a bill (text lines from a PDF or a photo) into: biller, amount due, due date, billing period,
// BPAY biller code, the last 4 of the reference, and a guessed category and frequency.
// Everything is a suggestion: the person checks it in a form before anything is saved.
import { parseDate } from './csv.js?v=202611241030';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

// well-known Australian billers -> [display name, category, statement text]
const KNOWN = [
  [/synergy/i, 'Synergy', 'Power', 'SYNERGY'], [/alinta/i, 'Alinta Energy', 'Power', 'ALINTA'], [/\bagl\b/i, 'AGL', 'Power', 'AGL'],
  [/origin energy/i, 'Origin Energy', 'Power', 'ORIGIN'], [/energyaustralia/i, 'EnergyAustralia', 'Power', 'ENERGYAUSTRALIA'],
  [/horizon power/i, 'Horizon Power', 'Power', 'HORIZON POWER'], [/kleenheat/i, 'Kleenheat', 'Power', 'KLEENHEAT'],
  [/water corporation|watercorporation/i, 'Water Corporation', 'Water', 'WATER CORP'], [/aqwest/i, 'Aqwest', 'Water', 'AQWEST'],
  [/shire of ([a-z]+)/i, null, 'Rates', null], [/city of ([a-z]+)/i, null, 'Rates', null], [/town of ([a-z]+)/i, null, 'Rates', null],
  [/telstra/i, 'Telstra', 'Phone & internet', 'TELSTRA'], [/optus/i, 'Optus', 'Phone & internet', 'OPTUS'], [/vodafone/i, 'Vodafone', 'Phone & internet', 'VODAFONE'],
  [/tangerine/i, 'Tangerine', 'Phone & internet', 'TANGERINE'], [/aussie broadband/i, 'Aussie Broadband', 'Phone & internet', 'AUSSIE BROADBAND'],
  [/iinet/i, 'iiNet', 'Phone & internet', 'IINET'], [/belong/i, 'Belong', 'Phone & internet', 'BELONG'], [/amaysim/i, 'amaysim', 'Phone & internet', 'AMAYSIM'],
  [/\bnrma\b/i, 'NRMA Insurance', 'Insurance', 'NRMA'], [/\brac\b/i, 'RAC', 'Insurance', 'RAC'], [/\baami\b/i, 'AAMI', 'Insurance', 'AAMI'],
  [/budget direct/i, 'Budget Direct', 'Insurance', 'BUDGET DIRECT'], [/\bhbf\b/i, 'HBF', 'Insurance', 'HBF'], [/medibank/i, 'Medibank', 'Insurance', 'MEDIBANK'],
  [/\bbupa\b/i, 'Bupa', 'Insurance', 'BUPA'], [/\bali group\b/i, 'ALI Group', 'Insurance', 'ALI GROUP'], [/department of transport/i, 'Department of Transport', 'Car costs', 'TRANSPORT'],
];

const AMOUNT_LABELS = [
  /total\s+(amount\s+)?(now\s+)?(due|payable|owing)/i, /amount\s+(now\s+)?(due|payable|owing)/i, /please\s+pay/i, /balance\s+(due|owing)/i,
  /total\s+to\s+pay/i, /pay\s+this\s+amount/i, /\bto\s+pay\b/i, /\bdue\s+amount/i, /new\s+charges/i, /total\s+(charges|this\s+bill)/i,
];
const DUE_LABELS = [/due\s+date/i, /pay\s+by/i, /payment\s+due/i, /due\s+(by|on)/i, /please\s+pay\s+by/i, /pay\s+before/i, /\bdue\b/i];

const money = s => { const m = String(s).replace(/,/g, '').match(/-?\$?\s?(\d+\.\d{2})\b/); return m ? Number(m[1]) : null; };
const allMoney = s => [...String(s).replace(/,/g, '').matchAll(/\$\s?(\d+\.\d{2})\b/g)].map(m => Number(m[1]));

export function findDates(s) {
  const out = []; const t = String(s);
  for (const m of t.matchAll(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g)) { const d = parseDate(m[0]); if (d) out.push({ d, i: m.index }); }
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?[\s\-]+([A-Za-z]{3,9})\.?[\s\-,]+(\d{2,4})\b/g)) {
    const mo = MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith('sept') ? 4 : 3)]; if (!mo) continue;
    let y = +m[3]; if (y < 100) y += 2000; const d = parseDate(`${y}-${mo}-${m[1]}`); if (d) out.push({ d, i: m.index });
  }
  for (const m of t.matchAll(/\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/g)) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, 3)]; if (!mo) continue; const d = parseDate(`${m[3]}-${mo}-${m[2]}`); if (d) out.push({ d, i: m.index });
  }
  return out.sort((a, b) => a.i - b.i).map(x => x.d);
}

// value on the same line after the label, else on the next line or two
function after(lines, i, re, pick) {
  const rest = lines[i].slice(lines[i].search(re));
  const same = pick(rest.replace(re, ''));
  if (same != null && (!Array.isArray(same) || same.length)) return same;
  for (let k = 1; k <= 2 && i + k < lines.length; k++) { const v = pick(lines[i + k]); if (v != null && (!Array.isArray(v) || v.length)) return v; }
  return null;
}

export function readBill(rawLines) {
  const lines = rawLines.map(l => String(l).replace(/\s+/g, ' ').trim()).filter(Boolean);
  const text = lines.join('\n');
  const r = { biller: null, category: null, match_text: null, amount: null, due_date: null, period_start: null, period_end: null,
    biller_code: null, ref_last4: null, frequency: null, overdue: false, notes: [] };

  // biller
  for (const [re, name, cat, match] of KNOWN) {
    const m = text.match(re); if (!m) continue;
    if (!name) { const place = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(); r.biller = `${m[0].split(' ')[0][0].toUpperCase()}${m[0].split(' ')[0].slice(1).toLowerCase()} of ${place}`; r.match_text = r.biller.toUpperCase(); }
    else { r.biller = name; r.match_text = match; }
    r.category = cat; break;
  }
  if (!r.biller) {
    const co = lines.slice(0, 15).find(l => /\b(pty\.?\s*ltd|limited|ltd|council|corporation)\b/i.test(l) && l.length < 60);
    const first = co || lines.find(l => /[a-z]{3}/i.test(l) && !/tax invoice|invoice|bill|statement|page \d/i.test(l) && l.length < 40);
    if (first) { r.biller = first.replace(/\b(pty\.?\s*ltd|ltd|limited)\b\.?/i, '').replace(/abn.*$/i, '').trim(); r.match_text = r.biller.toUpperCase().split(' ').slice(0, 2).join(' '); }
  }

  // amount due: labelled amounts in label priority order
  for (const re of AMOUNT_LABELS) {
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i]) || /previous|last bill|paid|received|credit|discount|concession|gst|incl/i.test(lines[i].replace(re, ''))) continue;
      const v = after(lines, i, re, s => money(s)); if (v != null && v > 0) { r.amount = v; break; }
    }
    if (r.amount != null) break;
  }
  if (r.amount == null) { const all = allMoney(text); if (all.length) { r.amount = Math.max(...all); r.notes.push('Amount due not labelled clearly — used the largest amount on the bill.'); } }

  // due date
  for (const re of DUE_LABELS) {
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i]) || /period|issued|date of issue|invoice date|bill date|from|meter/i.test(lines[i].replace(re, '').slice(0, 12))) continue;
      const v = after(lines, i, re, s => findDates(s)[0] ?? null); if (v) { r.due_date = v; break; }
    }
    if (r.due_date) break;
  }

  // billing / supply period
  for (let i = 0; i < lines.length; i++) {
    if (!/(billing|supply|service|bill|usage)\s+period|period\s+(from|of)|for the period|charges\s+from/i.test(lines[i])) continue;
    const ds = findDates(lines[i] + ' ' + (lines[i + 1] || ''));
    if (ds.length >= 2) { [r.period_start, r.period_end] = ds; break; }
  }
  if (r.period_start && r.period_end) {
    const days = Math.round((new Date(r.period_end) - new Date(r.period_start)) / 864e5) + 1;
    r.frequency = days <= 9 ? 'weekly' : days <= 18 ? 'fortnightly' : days <= 40 ? 'monthly' : days <= 70 ? 'bimonthly' : days <= 100 ? 'quarterly' : days > 300 ? 'yearly' : 'quarterly';
  }
  if (!r.frequency) r.frequency = r.category === 'Rates' ? 'yearly' : r.category === 'Water' || /quarter/i.test(text) ? 'quarterly' : 'monthly';

  // BPAY: biller code is public; the customer reference is kept to its last 4 digits only
  const bc = text.match(/biller\s*code[:\s]*([0-9]{3,7})/i); if (bc) r.biller_code = bc[1];
  const num = '[:\\s#]*([0-9][0-9 \\-]{3,24}[0-9])';
  for (const lbl of ['biller\\s*code[:\\s]*\\d{3,7}\\s*\\bref(?:erence)?', 'customer\\s+reference(?:\\s+(?:no\\.?|number))?', '\\bref(?:erence)?(?:\\s*(?:no\\.?|number))?', 'account\\s+(?:no\\.?|number)']) {
    const m = text.match(new RegExp(lbl + num, 'i')); if (m) { r.ref_last4 = m[1].replace(/\D/g, '').slice(-4); break; }
  }

  if (/overdue|arrears|unpaid\s+balance|past\s+due|final\s+notice|reminder\s+notice/i.test(text)) { r.overdue = true; r.notes.push('The bill mentions an overdue or unpaid amount.'); }
  if (r.amount == null) r.notes.push('No amount found — type it in.');
  if (!r.due_date) r.notes.push('No due date found — type it in.');
  return r;
}
