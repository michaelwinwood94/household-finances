import assert from 'node:assert/strict';
import { parseAfterpayText, parseDeferitText, detectBnplPdf, resolveTruncated, isKnown } from '../app/bnpl.js';

// Afterpay: made-up lines in the shapes the text recognition produces
const ap = [
  '= afterpay TB', '$100.00 $200.00 $300.00', '15 days 30 days 60 days',
  'Km', '< art Pay $37.91', '2 of 4* Tue, 1 Dec 2026',
  '@@ ACMEFOODS PTYLTD pay $10.00', 'WE x 0f4+ Tue, 1 Dec 2026 “',
  '@m WIDGETCO pay $1438', 'WE ob ot4+ Tue, 1 Dec 2026 “we',
  'wow BigW Pay $25.31', '2 of 4 Tue, 1 Dec 2026',
  '@@ Sample Academy $22.88', 'WE 3 0f4+ Tue, 15 Dec 2026',
];
const r = parseAfterpayText(ap);
assert.equal(r.length, 5);
assert.deepEqual(r.map(x => x.amount), [37.91, 10, 14.38, 25.31, 22.88]);
assert.equal(r[0].merchant, 'Kmart');
assert.equal(r[3].merchant, 'BigW');
assert.equal(r[4].due_date, '2026-12-15');
assert.equal(r[0].instalment_no, 2);
assert.equal(detectBnplPdf([ap]), 'afterpay');

// Deferit
const df = ['deferit', 'December 2026', 'DEC', '01 oO... Instalment 4 of 4 $36.81 [--]', 'DEC', '01 d.... Monthly fee $9.99', 'DEC', '15 R... Instalment 3 of 4 $45.24 Pay (+)'];
const d = parseDeferitText(df, '2026-11-23');
assert.equal(d.length, 3);
assert.equal(d[0].due_date, '2026-12-01'); assert.equal(d[0].amount, 36.81);
assert.ok(d[1].is_fee);
assert.equal(d[2].due_date, '2026-12-15'); assert.equal(d[2].instalment_no, 3);
assert.equal(detectBnplPdf([df]), 'deferit');
const ex = [{ merchant: 'Optus', amount: 36.81, due_date: '2026-12-01' }, { merchant: 'Rural Water', amount: 45.24, due_date: '2026-12-15' }];
assert.equal(resolveTruncated(d[0], ex).merchant, 'Optus');
assert.equal(resolveTruncated(d[2], ex).merchant, 'Rural Water');
assert.ok(isKnown({ merchant: 'IGA Uduc Road', amount: 9.08, due_date: '2026-12-01' }, [{ merchant: 'IGA Uduc Road', amount: 9.06, due_date: '2026-12-01' }]));
assert.equal(detectBnplPdf([['Westpac', 'balance $1.00']]), null);
console.log('bnpl-pdf ok');
