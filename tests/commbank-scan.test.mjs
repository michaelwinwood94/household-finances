// CommBank NetBank page printed to a picture-only PDF, read by text recognition — made-up account and transactions.
import assert from 'node:assert/strict';
import { parseCommbankOcr, parseScannedPdf } from '../app/csv.js';

const p1 = [
  '11/23/26, 10:05 PM Account overview - NetBank',
  'Smart Access -~',
  'BSB 000-000 Acc Number 1234 5678 Copy',
  'Available Pending Balance',
  '$100.00 $0.00 $100.00',
  'Transactions Q',
  'Mon 23 Nov 2026 Amount',
  ': . . . +$50.00',
  '‘Se Direct Credit 001 Example Benefits 123 abcd',
  'Balance $100.00',
  'Sat 21 Nov 2026 Amount',
  '-$20.00',
  "@ Example Burgers (Town) $",
  'Balance $50.00',
  'Fri 20 Nov 2026 Amount',
  'amazon Example Book -$10.00',
  'Balance $70.00',
  'Thu 19 Nov 2026 Amount',
  '© Afterpay “$5.00',                       // a minus read as a quote mark
  'Balance $80.00',
  '-$15.50',
  'Fr Afterpay $',
  'Balance -$5.50',                          // overdrawn
  'https://netbank.web.commbank.com.au/banking/accounts/x/overview 1/2',
];
const p2 = [
  '11/23/26, 10:05 PM Account overview - NetBank',
  '+$40.00',
  'ia) Fast Transfer from Someone To PayID Phone Credit to Account',
  'Balance -$65.50',
  'Wed 18 Nov 2026 Amount',
  '-$25.00',
  'EXAMPLE SHOP Balance -$25.50',            // wrapped description with the balance on the same line
  '@ Example Cafe $',                        // hidden amount below: worked out from balances
  'Balance -$10.50',
  '-$1.00',
  'Older Shop',
  'Balance -$25.00',
  'Load more transactions',
  'https://netbank.web.commbank.com.au/banking/accounts/x/overview 2/2',
];
const r = parseScannedPdf([p1, p2]);
assert.equal(r.format, 'commbank-pdf-scan');
assert.equal(r.account.name, 'Smart Access');
assert.equal(r.account.last4, '5678');
assert.equal(r.account.balance, 100);
assert.equal(r.rows[0].amount, 50);   assert.equal(r.rows[0].date, '2026-11-23'); assert.equal(r.rows[0].description, 'Direct Credit 001 Example Benefits 123 abcd');
assert.equal(r.rows[1].amount, -20);  assert.equal(r.rows[1].description, "Example Burgers (Town)");
assert.equal(r.rows[2].amount, -10);  assert.equal(r.rows[2].description, 'amazon Example Book');
assert.equal(r.rows[3].amount, -5);   assert.equal(r.rows[3].description, 'Afterpay');
assert.equal(r.rows[4].amount, -15.5); assert.equal(r.rows[4].balance, -5.5);
assert.equal(r.rows[5].amount, 40);   assert.equal(r.rows[5].date, '2026-11-19');
assert.equal(r.rows[6].amount, -25);
assert.ok(r.rows[6].description.includes('EXAMPLE SHOP'));
assert.equal(r.rows[7].amount, 14.5);   // hidden amount: -10.50 - (-25.00)
assert.ok(r.notes.some(n => /Load more/.test(n)));
assert.ok(r.notes.some(n => /unreadable amount/.test(n)));
assert.ok(parseCommbankOcr([['hello']]).error);
// a read amount is kept when the balances disagree (a row may be missing); the spot is reported
const gap = parseCommbankOcr([[
  'Account overview - NetBank', 'BSB 000-000 Acc Number 1234 5678', 'Balance',
  'Mon 02 Nov 2026 Amount', '-$10.00', 'Shop A', 'Balance $100.00',
  'Sun 01 Nov 2026 Amount', '-$5.00', 'Shop B', 'Balance $200.00']]);
assert.equal(gap.rows[0].amount, -10);
assert.ok(gap.notes.some(n => /doesn’t add up near 02\/11\/2026/.test(n)));
console.log('commbank scan tests passed');
