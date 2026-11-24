import assert from 'node:assert/strict';
import { dataThrough, classifyOverdue } from '../app/arrears.js';

const txns = [{ account_id: 'a1', txn_date: '2026-11-20' }, { account_id: 'a1', txn_date: '2026-11-23' }, { account_id: 'a2', txn_date: '2026-11-08' }];
const through = dataThrough(txns);
assert.equal(through.any, '2026-11-23'); assert.equal(through.byAccount.a1, '2026-11-23'); assert.equal(through.byAccount.a2, '2026-11-08');

const items = [
  { name: 'Loan', direction: 'out', next_due: '2026-11-06', account_id: 'a1' },        // data runs past due date, still unpaid -> confirmed
  { name: 'Phone', direction: 'out', next_due: '2026-11-10', account_id: 'a2' },        // that account's data stops before the due date -> unconfirmed
  { name: 'Sub', direction: 'out', next_due: '2026-11-23', account_id: 'a1' },          // data only runs up to the due date -> unconfirmed
  { name: 'NoAcct', direction: 'out', next_due: '2026-11-22' },                         // no account: uses latest data overall -> confirmed
  { name: 'Future', direction: 'out', next_due: '2026-11-30', account_id: 'a1' },       // not overdue
  { name: 'Wages', direction: 'in', next_due: '2026-11-01', account_id: 'a1' },         // income ignored
  { name: 'Off', direction: 'out', next_due: '2026-11-01', account_id: 'a1', is_active: false },
];
const r = classifyOverdue(items, through, '2026-11-24');
assert.deepEqual(r.confirmed.map(i => i.name), ['Loan', 'NoAcct']);
assert.deepEqual(r.unconfirmed.map(i => i.name), ['Phone', 'Sub']);
assert.deepEqual(classifyOverdue(items, { byAccount: {}, any: '' }, '2026-11-24').confirmed, []);
console.log('arrears tests passed');
