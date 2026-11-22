import { parseBankCsv, parseMoney, parseDate, splitAccounts } from '../app/csv.js';
import assert from 'node:assert/strict';

const westpac = `Bank Account,Date,Narrative,Debit Amount,Credit Amount,Balance,Categories,Serial
732123123456,20/11/2026,"WOOLWORTHS 4321 BUNBURY      AU",85.40,,729.20,POS,
732123123456,13/11/2026,DEPOSIT CENTRELINK CRN 123,,800.00,"1,814.60",DEP,
732123123456,12/11/2026,"BPAY SYNERGY, PERTH",150.00,,1014.60,PAYMENT,
`;
let r = parseBankCsv(westpac);
assert.equal(r.format, 'westpac');
assert.equal(r.rows.length, 3);
assert.deepEqual(r.rows[0], { date:'2026-11-20', description:'WOOLWORTHS 4321 BUNBURY AU', amount:-85.4, balance:729.2, acct:'732123123456' });
assert.equal(r.rows[1].amount, 800); assert.equal(r.rows[1].balance, 1814.6);
assert.equal(r.rows[2].description, 'BPAY SYNERGY, PERTH');

const cba = `"20/11/2026","-85.40","WOOLWORTHS 4321 BUNBURY AU","+729.20"
"13/11/2026","+800.00","Direct Credit 012345 CENTRELINK","+1814.60"
"bad","x","y","z"
`;
r = parseBankCsv(cba);
assert.equal(r.format, 'commbank');
assert.equal(r.rows.length, 2); assert.equal(r.skipped.length, 1);
assert.equal(r.rows[0].amount, -85.4); assert.equal(r.rows[1].amount, 800); assert.equal(r.rows[1].balance, 1814.6);

const generic = `Date,Description,Amount\n2026-11-01,Thing,-5.5\n`;
r = parseBankCsv(generic); assert.equal(r.format,'generic'); assert.equal(r.rows[0].amount,-5.5);

r = parseBankCsv('hello,world\nfoo,bar'); assert.equal(r.format,'unknown'); assert.ok(r.error);

assert.equal(parseMoney('$1,234.50 DR'), -1234.5);
assert.equal(parseMoney('(20.00)'), -20);
assert.equal(parseDate('31/02/2026'), null);
assert.equal(parseDate('5/1/26'), '2026-01-05');
assert.equal(parseDate('20 Nov 2026'), '2026-11-20');
// multi-account Westpac export splits into one part per account
const multi = `Bank Account,Date,Narrative,Debit Amount,Credit Amount,Balance,Categories,Serial
111111111234,02/11/2026,A,10.00,,90.00,X,
222222225678,02/11/2026,B,,5.00,105.00,X,
111111111234,01/11/2026,C,,100.00,100.00,X,
`;
const parts = splitAccounts(parseBankCsv(multi));
assert.equal(parts.length, 2);
assert.equal(parts[0].account.last4, '1234'); assert.equal(parts[0].rows.length, 2); assert.ok(!('acct' in parts[0].rows[0]));
assert.equal(parts[1].account.last4, '5678'); assert.equal(parts[1].rows[0].amount, 5);
assert.equal(splitAccounts(parseBankCsv(generic)).length, 1);
console.log('All CSV tests passed');
