// Payslip reader: turns the text of a payslip (from a PDF or a photo) into payslip fields.
// Works on labels, not on one employer's layout: it looks for words like "Gross", "PAYG", "Net pay",
// "Super", "Pay date" and takes the numbers on the same line. Everything it fills is shown for checking.
import { parseDate } from './csv.js?v=202611240400';

const MONEY = /\(?-?\$?\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})\)?|\(?-?\$?\s?\d+\.\d{2}\)?/g;
const toNum = s => { const neg = /^\(|-/.test(s.trim()); const n = Number(s.replace(/[^\d.]/g, '')); return neg ? -n : n; };
const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
const DATE = new RegExp(`(\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s+(?:${MONTHS})[a-z]*\\.?\\s+\\d{4})`, 'gi');
const normDate = s => parseDate(s.replace(/\./g, '').replace(/\bsept\b/i, 'Sep').replace(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/, (m, d, mo, y) => `${d} ${mo[0].toUpperCase()}${mo.slice(1, 3).toLowerCase()} ${y}`));

// Ordered: more specific labels first. `kind`: summary lines use [this pay, YTD]; earnings lines may hold hours/rate first.
const FIELDS = [
  { k: 'salary_sacrifice', kind: 'summary', re: /salary\s*sacrifice|sal\.?\s*sac|pre[-\s]?tax\s+(?:super|deduction)/i },
  { k: 'net_pay', kind: 'summary', re: /\bnet\s*(?:pay|wages?|amount|payment|income)?\b|take[-\s]?home|amount\s+(?:paid|banked|deposited)|bank(?:ed)?\s+deposit|total\s+paid/i },
  { k: 'gross_pay', kind: 'summary', re: /\bgross\b|total\s+(?:earnings|wages|pay(?!e))|taxable\s+(?:gross|earnings|income)/i },
  { k: 'tax_withheld', kind: 'summary', re: /\bpayg\b|tax\s+withheld|withholding|income\s+tax|\btax\b/i },
  { k: 'super_employer', kind: 'summary', re: /super(?:annuation)?(?:\s+guarantee|\s+contribution|\s+sg)?|\bsgc?\b|employer\s+contrib/i },
  { k: 'overtime_pay', kind: 'earning', re: /overtime|\bo\/t\b|time\s*(?:and|&)\s*a\s*half|double\s*time|\bt1\.5\b|\bdt\b/i },
  { k: 'leave_pay', kind: 'earning', re: /(?:annual|sick|personal|carer'?s?|long\s+service)\s+leave\s+(?:taken|paid|payment)|leave\s+loading|(?:annual|personal|sick)\s+leave(?!.*(?:balance|accru|available|owing))/i },
  { k: 'ordinary_pay', kind: 'earning', re: /ordinary|base\s+(?:pay|rate|hours|wage)|normal\s+(?:hours|time)|regular\s+(?:hours|pay)|\bwages?\b|\bsalary\b(?!\s*sac)/i },
  { k: 'allowances', kind: 'earning', re: /allowance/i },
  { k: 'bonus', kind: 'earning', re: /bonus|commission|incentive/i },
  { k: 'other_deductions', kind: 'summary', re: /union|child\s+support|deduction(?!s?\s*(?:total|before))|garnish/i },
];
const BALANCE = [
  { k: 'annual_leave_hours', re: /annual\s+leave.*(?:balance|accru|available|owing)|(?:balance|accru|available).*annual\s+leave/i },
  { k: 'sick_leave_hours', re: /(?:personal|sick|carer).*(?:balance|accru|available|owing)|(?:balance|accru|available).*(?:personal|sick)/i },
];
const SKIP = /\brate\b.*\bper\b|abn|tfn|bsb|account\s*(?:no|number)|phone|fax|email|award|classification/i;

/** lines: array of text lines. Returns { fields, found: Set<field>, notes: [] } */
export function readPayslip(lines) {
  const fields = {}, found = new Set(), notes = [];
  const text = lines.map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const ytdCol = text.some(l => /\bytd\b|year\s*to\s*date/i.test(l));

  // employer: a line with Pty Ltd / Ltd / Trust, or after "Employer"
  for (const l of text.slice(0, 15)) {
    const m = l.match(/^employer(?:'?s)?(?:\s+name)?\s*[:\-]\s*(.+)/i);
    if (m && !/employee|super|\$\s?\d|\d\.\d{2}/i.test(m[1])) { fields.employer = m[1].replace(/\s*ABN.*$/i, '').trim(); found.add('employer'); break; }
  }
  if (!fields.employer) {
    const l = text.slice(0, 15).find(x => /\b(pty\.?\s*ltd|ltd|limited|trust|inc\.?|group|services|co\.?)\b/i.test(x) && !/super|fund|bank/i.test(x));
    if (l) { fields.employer = l.replace(/\s*ABN.*$/i, '').replace(/\s+\d.*$/, '').trim(); found.add('employer'); }
  }

  // dates
  for (const l of text) {
    const dates = [...l.matchAll(DATE)].map(m => normDate(m[0])).filter(Boolean);
    if (!dates.length) continue;
    if (!fields.pay_date && /pay(?:ment)?\s*date|date\s*paid|paid\s*on|pay\s*day|payment\s*on|deposit(?:ed)?\s*on/i.test(l)) { fields.pay_date = dates.at(-1); found.add('pay_date'); }
    if (!fields.period_start && /period|pay\s*(?:from|cycle)|from\b.*\bto\b|week\s*ending|fortnight\s*ending/i.test(l)) {
      if (dates.length >= 2) { fields.period_start = dates[0]; fields.period_end = dates[1]; found.add('period_start'); found.add('period_end'); }
      else if (/ending|end/i.test(l)) { fields.period_end = dates[0]; found.add('period_end'); }
      else if (/start|from|begin/i.test(l)) { fields.period_start = dates[0]; found.add('period_start'); }
    }
    if (!fields.period_end && /period\s*(?:end|to)|to\s*date/i.test(l) && dates.length === 1) { fields.period_end = dates[0]; found.add('period_end'); }
  }
  if (!fields.pay_date && fields.period_end) { fields.pay_date = fields.period_end; notes.push('Pay date not found — used the end of the pay period.'); }

  // money lines
  const earnTotals = {};
  for (const raw of text) {
    if (SKIP.test(raw)) continue;
    // balances (hours) first
    const bal = BALANCE.find(b => b.re.test(raw));
    if (bal) {
      const nums = [...raw.matchAll(/(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours)?/gi)].map(m => Number(m[1])).filter(n => n < 3000);
      if (nums.length && fields[bal.k] == null) { fields[bal.k] = nums.at(-1); found.add(bal.k); }
      continue;
    }
    const f = FIELDS.find(x => x.re.test(raw));
    if (!f) continue;
    const label = raw.match(f.re);
    // "20 x $28.50" or "38.00 hrs @ $30.00" — hours before a rate
    if (f.k === 'ordinary_pay' && fields.hours == null) {
      const hm = raw.match(/(\d+(?:\.\d+)?)\s*(?:hrs?|hours)?\s*(?:x|@)\s*\$?\d/i);
      if (hm && Number(hm[1]) <= 200) { fields.hours = Number(hm[1]); found.add('hours'); }
    }
    // drop multipliers and percentages ("1.5x", "x2", "(12%)") so they aren't mistaken for hours or amounts
    const after = raw.slice(label.index + label[0].length).replace(/\b\d+(?:\.\d+)?\s*x\b|\bx\s*\d+(?:\.\d+)?\b|\(?\d+(?:\.\d+)?\s*%\)?/gi, ' ');
    const amounts = [...after.matchAll(MONEY)].map(m => Math.abs(toNum(m[0])));
    if (!amounts.length) continue;
    if (f.kind === 'earning') {
      // typical: [hours] [rate] amount [ytd]  — hours have no cents or are like 38.00
      const allNums = [...after.matchAll(/\d{1,3}(?:,\d{3})*(?:\.\d+)?/g)].map(m => Number(m[0].replace(/,/g, '')));
      let amount;
      if (allNums.length >= 3) {   // hours, rate, amount[, YTD]
        amount = ytdCol && allNums.length >= 4 ? allNums.at(-2) : allNums.at(-1);
        if (f.k === 'ordinary_pay' && fields.hours == null && allNums[0] <= 200) { fields.hours = allNums[0]; found.add('hours'); }
      }
      else if (amounts.length >= 2 && ytdCol) amount = amounts[0];
      else amount = amounts.at(-1);
      earnTotals[f.k] = (earnTotals[f.k] || 0) + amount;
      continue;
    }
    if (fields[f.k] != null) continue;   // first summary line wins
    fields[f.k] = amounts[0]; found.add(f.k);
    if (amounts.length >= 2 && ytdCol) {
      const ytdK = { gross_pay: 'ytd_gross', tax_withheld: 'ytd_tax', super_employer: 'ytd_super' }[f.k];
      if (ytdK && amounts.at(-1) >= amounts[0]) { fields[ytdK] = amounts.at(-1); found.add(ytdK); }
    }
  }
  for (const [k, v] of Object.entries(earnTotals)) { fields[k] = Math.round(v * 100) / 100; found.add(k); }
  if (!fields.hours) {
    const h = text.find(l => /total\s+hours|hours\s+worked/i.test(l));
    const n = h && h.match(/(\d+(?:\.\d+)?)/); if (n) { fields.hours = Number(n[1]); found.add('hours'); }
  }

  // fill gaps and sanity-check
  const parts = ['ordinary_pay', 'overtime_pay', 'allowances', 'bonus', 'leave_pay'].reduce((t, k) => t + (fields[k] || 0), 0);
  if (fields.gross_pay == null && parts) { fields.gross_pay = Math.round(parts * 100) / 100; notes.push('Gross pay worked out by adding the earnings lines.'); }
  const ded = (fields.tax_withheld || 0) + (fields.salary_sacrifice || 0) + (fields.other_deductions || 0);
  if (fields.net_pay == null && fields.gross_pay != null && fields.tax_withheld != null) { fields.net_pay = Math.round((fields.gross_pay - ded) * 100) / 100; notes.push('Net pay worked out from gross minus tax and deductions.'); }
  if (fields.gross_pay != null && fields.net_pay != null && fields.net_pay > fields.gross_pay) {
    [fields.gross_pay, fields.net_pay] = [fields.net_pay, fields.gross_pay]; notes.push('Gross and net looked swapped — check them.');
  }
  if (fields.tax_withheld != null && fields.gross_pay && fields.tax_withheld > fields.gross_pay * 0.6) { notes.push('Tax looks too high for this pay — it may be a year-to-date figure.'); found.delete('tax_withheld'); }
  if (fields.super_employer != null && fields.gross_pay && fields.super_employer > fields.gross_pay * 0.4) { notes.push('Super looks too high — it may be a year-to-date figure.'); found.delete('super_employer'); }
  if (!found.size) notes.push('Nothing could be read from this file. Try a clearer photo, or enter the payslip by hand.');
  return { fields, found, notes };
}

/** Split OCR or PDF text into lines */
export const toLines = text => text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
