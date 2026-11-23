// Westpac "Account activity" printed to a picture-only PDF, read by text recognition — made-up loan account.
import assert from 'node:assert/strict';
import { parseWestpacOcr } from '../app/csv.js';

const page1 = [
  '11/23/26, 9:59 PM Sample Home Loan - Account activity - Westpac Online Banking',
  'Account activity',
  'Sample Home Account details',
  'Loan Statements',
  '000-111 222333 Account settings',
  '-$10,000.00',
  'Available $30.00',
  'Date ¥ Description Debit Credit Balance 1',
  '6 Nov 2026 INTEREST -$50.00 -$10,000.00',
  '2 Nov 2026 DEPOSIT ONLINE TFR Westpac Cho $400.00 -$9,950.00',
  '12 Oct 2026 WITHDRAWAL MOBILE 123 TFR Westpac Cho -$90.00 -$10,350.00',
  '6 Oct 2026 INTEREST. -$55.00 -$10,260.00',
  '6 Sep 2026 INTEREST -$5.00 -$10,205.00',   // misread amount: balances say 6 Oct to 6 Sep moved 55 → see below
  '6 Aug 2026 INTEREST -$10,100.00',          // amount hidden by the chat box
  '1 Jul 2026 DEPOSIT ONLINE TFR Westpac Cho $300.00 -$10,050.00',
  'Need help? Chat with us x',
];
const page2 = [
  '1 Jun 2026 INTEREST -$50,00 -$10,350,00',
  'Display more (Showing 100 of 102) Save as PDF_',
];
const r = parseWestpacOcr([page1, page2]);
assert.equal(r.format, 'westpac-pdf-scan');
assert.equal(r.account.name, 'Sample Home Loan');
assert.equal(r.account.last4, '2333');
assert.equal(r.account.balance, -10000);
assert.equal(r.rows.length, 8);
assert.equal(r.rows[0].amount, -50); assert.equal(r.rows[0].date, '2026-11-06');
assert.equal(r.rows[1].amount, 400);
assert.equal(r.rows[3].description, 'INTEREST');
// the amount hidden under the chat box (6 Aug) comes from the running balance: -10100 - -10050 = -50
assert.equal(r.rows[5].amount, -50);
// a misread amount is corrected from the running balance: 6 Sep, -10205 - -10100 = -105
assert.equal(r.rows[4].amount, -105);
assert.ok(r.notes.some(n => /Showing 100 of 102|only showed 100 of 102/.test(n)));
assert.ok(r.notes.some(n => /hidden amount/.test(n)) && r.notes.some(n => /misread/.test(n)));
assert.ok(parseWestpacOcr([['hello']]).error);
console.log('westpac scan tests passed');
