// Latitude loan statement reader — made-up account and amounts, same layout as the real PDF.
import assert from 'node:assert/strict';
import { isLatitudeStatement, parseLatitudeStatement } from '../app/csv.js';

let y = 800;
const line = (...cells) => { y -= 14; return cells.map(([str, x]) => ({ str, x, y })); };
const row = (d, desc, cr, db) => line([d, 40], [desc, 110], [cr, 360], [db, 440]);
const page0 = [
  ...line(['Account Number: LAI-00012345', 400]),
  ...line(['Latitude Fixed Rate Personal Loan Statement', 40]),
  ...line(['Statement date: 24-11-2026', 40]),
  ...line(['Closing Balance as at 24-11-2026', 40], ['$9,000.00', 400]),
  ...line(['Minimum Monthly Payment: $250.00', 40]),
  ...line(['Next Payment Due Date: 27-11-2026', 40]),
  ...line(['Current Interest Rate: 13.00% p.a.', 40]),
  ...line(['Amount overdue*: $100.50', 40]),
];
y = 800;
const page1 = [
  ...line(['Date', 40], ['Transaction Description', 110], ['Credit', 360], ['Debit', 440], ['Balance', 500]),
  ...line(['26-05-2023', 40], ['Opening Balance', 110], ['$9,500.00', 500]),
  ...row('27-05-2023', 'Interest Charged', '$0.00', '$100.00'),
  ...row('02-06-2023', 'Loan repayment BPAY', '$200.00', '$0.00'),
  ...row('27-04-2024', 'Interest Rate changed from 8.58% to', '$0.00', '$0.00'),
  ...line(['30-04-2024', 40], ['14.99%', 110]),
  ...line(['BPAY Payment Handling Fee', 110], ['$0.00', 360], ['$1.95', 440]),
  ...row('30-04-2024', 'Loan repayment BPAY', '$150.00', '$0.00'),
  ...row('05-07-2024', 'Late Payment Fee', '$0.00', '$45.00'),
  ...row('02-07-2026', 'Fee Waived', '$30.00', '$0.00'),
  ...line(['Latitude Personal Finance Pty Ltd (ABN 00 000 000 000)', 110]),
  ...line(['Page 2 of 5', 400]),
  ...line(['24-11-2026', 40], ['Closing Balance', 110], ['$9,000.00', 500]),
];
const pages = [page0, page1];

assert.ok(isLatitudeStatement([[...page0, { str: 'Transaction Description', x: 1, y: 1 }], page1]));
assert.ok(!isLatitudeStatement([[{ str: 'Account activity', x: 0, y: 0 }]]));
const r = parseLatitudeStatement(pages);
assert.equal(r.format, 'latitude-pdf');
assert.equal(r.rows.length, 6);
assert.deepEqual(r.rows.map(x => x.amount), [-100, 200, -1.95, 150, -45, 30]);
assert.deepEqual(r.rows.map(x => x.date), ['2023-05-27', '2023-06-02', '2024-04-30', '2024-04-30', '2024-07-05', '2026-07-02']);
assert.equal(r.rows[2].description, 'BPAY Payment Handling Fee');
// balance: opening + credits - debits must land on the closing balance
assert.equal(r.account.balance, -9000);
const sum = r.rows.reduce((s, x) => s + x.amount, 0);
assert.equal(Math.round((r.account.balance - sum) * 100) / 100, -9233.05); // implied opening (owed)
assert.equal(r.account.last4, '2345');
assert.deepEqual(r.statement, { closing: 9000, overdue: 100.5, minPayment: 250, rate: 13, due: '2026-11-27', date: '2026-11-24' });
// not a Latitude file
assert.ok(parseLatitudeStatement([[{ str: 'hello', x: 0, y: 0 }]]).error);
console.log('latitude tests passed');
