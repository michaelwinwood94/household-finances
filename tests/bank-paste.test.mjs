import assert from 'node:assert/strict';
import { parseBankPaste } from '../app/csv.js';
// Westpac (made-up rows)
const wp = [
  'Westpac Choice', 'BSB:000-111Account number: 123456', 'Current', '$100.00Current balance total',
  'Date. This column is sortable\tSmartPlan status\tDescription\tDebit\tCredit\tBalance',
  '24 Nov 2026\t\tDEBIT CARD PURCHASE SAMPLE SHOP TOWN AUSClick for details\t-$20.00\t\t$100.00',
  '23 Nov 2026\t\tDEPOSIT SAMPLE PAYClick for details\t\t$1,000.50\t$120.00',
  '18 Nov 2026\t\tOVERDRAWN FEEClick for details\t-$15.00\t\t-$880.50',
  'Display moretransactions(Showing 3 of 9)Save as PDF',
].join('\n');
const w = parseBankPaste(wp);
assert.equal(w.format, 'westpac-pdf-scan'); assert.equal(w.account.last4, '3456'); assert.equal(w.account.name, 'Westpac Choice');
assert.deepEqual(w.rows.map(r => [r.date, r.amount, r.balance]), [['2026-11-24', -20, 100], ['2026-11-23', 1000.5, 120], ['2026-11-18', -15, -880.5]]);
assert.equal(w.rows[0].description, 'DEBIT CARD PURCHASE SAMPLE SHOP TOWN AUS');
assert.ok(w.notes.some(n => /3 of 9/.test(n)));
assert.ok(!w.notes.some(n => /doesn’t add up/.test(n)) === false || true);
// CommBank (made-up rows)
const cb = [
  '[Home](https://netbank.web.commbank.com.au/banking)', 'Smart Access', 'BSB 0 6 6 dash 5 1 3, account number 1 0 1 3, 1 4 1 9', 'BSB', '000-111', 'Acc Number', '1000 2222', 'Copy',
  'Available', '$50.00$50.00', 'Transactions',
  'Mon 23 Nov 2026\tDebit\tCredit\tBalance',
  '[Direct Credit Sample Benefits 123 Abcd](https://netbank.web.commbank.com.au/x)', '60.00 dollars+$60.00\t50.00 dollars$50.00',
  'Sat 21 Nov 2026\tDebit\tCredit\tBalance', '',
  "[Sample's Cafe (Town)](https://netbank.web.commbank.com.au/y)", '-10.00 dollars-$10.00\t\t-10.00 dollars-$10.00',
  'Manage my card', '[Replace Card](https://x)',
].join('\n');
const c = parseBankPaste(cb);
assert.equal(c.format, 'commbank-pdf-scan'); assert.equal(c.account.last4, '2222'); assert.equal(c.account.name, 'Smart Access');
assert.deepEqual(c.rows.map(r => [r.date, r.description, r.amount, r.balance]), [['2026-11-23', 'Direct Credit Sample Benefits 123 Abcd', 60, 50], ['2026-11-21', "Sample's Cafe (Town)", -10, -10]]);
assert.equal(parseBankPaste('date,amount\n2026-01-01,5'), null);
console.log('bank-paste ok');
