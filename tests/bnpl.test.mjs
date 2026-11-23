// Afterpay / Deferit screenshot reader — made-up shops and amounts, with the kind of noise the text reader produces.
import assert from 'node:assert/strict';
import { parseAfterpay, parseDeferit, parseLongDate, inferYear, cleanMerchant, bestShopKey, mergeRows, isKnown } from '../app/bnpl.js';

const L = (text, y0, y1 = y0 + 40) => ({ text, y0, y1 });
const W = (text, y0, y1 = y0 + 40) => ({ text, y0, y1 });

// dates
assert.equal(parseLongDate('2 of 4° Tue, 1 Dec 2026'), '2026-12-01');
assert.equal(parseLongDate('1of4* Tue, 15Jan 2027'), '2027-01-15');
assert.equal(parseLongDate('nothing here'), null);
assert.equal(inferYear(1, 11, '2026-11-23'), '2026-12-01');
assert.equal(inferYear(5, 0, '2026-11-23'), '2027-01-05');
assert.equal(inferYear(29, 10, '2026-11-23'), '2026-11-29');

// shop names
assert.equal(cleanMerchant('@e HARBOUR FRESH PTY LTD'), 'Harbour Fresh');
assert.equal(cleanMerchant('Sunny Pets Acade...'), 'Sunny Pets Acade');
assert.equal(cleanMerchant('KFC TOWNVILLE'), 'KFC Townville');
assert.equal(cleanMerchant('MEETNICE'), 'Meetnice');
assert.equal(bestShopKey('7 ELEVEN 3091', ['7eleven', 'coles']), '7eleven');
assert.equal(bestShopKey('Sunny Pets Acade...', ['sunnypetsacademy']), 'sunnypetsacademy');
assert.equal(bestShopKey('Unknown Shop', ['coles']), null);

// Afterpay: two text lines per purchase, amount button on the right; one amount mangled, one name with a logo smudge
const apText = [
  L('Sunny Pets Acade...', 100), L('20f 4* Tue, 1 Dec 2026', 160),
  L('ZED Hardware', 300), L('2 of 4° Tue, 1 Dec 2026', 360),
  L('@m GREEN LEAF CAFE', 500), L('1of4* Tue, 8 Dec 2026', 560),
  L('ow iain', 700), L('3 0f 4 Tue, 15 Dec 2026', 760),
];
const apAmts = [W('Pay', 120), W('$22.88', 120), W('Pay', 320), W('$5.50', 320), W('Pay', 520), W('$11.18', 520), W('aeePary.$31.44', 720)];
const ap = parseAfterpay({ text: apText, amounts: apAmts });
assert.equal(ap.length, 4);
assert.deepEqual(ap.map(r => r.amount), [22.88, 5.5, 11.18, 31.44]);
assert.deepEqual(ap.map(r => r.due_date), ['2026-12-01', '2026-12-01', '2026-12-08', '2026-12-15']);
assert.deepEqual(ap.map(r => [r.instalment_no, r.instalments_total]), [[2, 4], [2, 4], [1, 4], [3, 4]]);
assert.equal(ap[0].merchant, 'Sunny Pets Acade');
assert.equal(ap[2].merchant, 'Green Leaf Cafe');

// Deferit: date column + "NAME  $amount" with "Instalment x of y" or "Monthly fee" below
const dfMain = [
  L('Optus $36.81 [++', 100), L('Instalment 4 of 4', 160),
  L('RURAL WATER SE... $45.24 [++', 300), L('Instalment 2 of 4', 360),
  L('deferit $9.99', 500), L('Monthly fee', 560),
  L('TANGERINE TELE... $24.99 [++', 700), L('Instalment 3 of 4', 760),
];
const dfDates = [L('DEC', 90, 120), L('01', 130, 180), L('DEC', 290, 320), L('01', 330, 380), L('DEC', 490, 520), L('01', 530, 580), L('DEC', 690, 720), L('15', 730, 780)];
const df = parseDeferit({ main: dfMain, dates: dfDates }, '2026-11-23');
assert.equal(df.length, 4);
assert.deepEqual(df.map(r => r.amount), [36.81, 45.24, 9.99, 24.99]);
assert.deepEqual(df.map(r => r.due_date), ['2026-12-01', '2026-12-01', '2026-12-01', '2026-12-15']);
assert.deepEqual(df.map(r => [r.instalment_no, r.instalments_total]), [[4, 4], [2, 4], [null, null], [3, 4]]);
assert.equal(df[2].is_fee, true);
assert.equal(df[1].merchant, 'Rural Water Se');

// Deferit with the month label unreadable: months worked out from the day numbers (list is in date order)
const dfNoMonth = parseDeferit({ main: dfMain, dates: dfDates.filter(d => d.text !== 'DEC') }, '2026-11-23');
assert.deepEqual(dfNoMonth.map(r => r.due_date), ['2026-12-01', '2026-12-01', '2026-12-01', '2026-12-15']);
assert.equal(dfNoMonth[0].date_guessed, true);
const rollover = parseDeferit({ main: [L('Shop A $10.00', 100), L('Instalment 1 of 4', 160), L('Shop B $12.00', 300), L('Instalment 1 of 4', 360)], dates: [L('29', 120, 170), L('05', 320, 370)] }, '2026-11-23');
assert.deepEqual(rollover.map(r => r.due_date), ['2026-11-29', '2026-12-05']);

// merging overlapping screenshots and spotting rows already saved
assert.equal(mergeRows([...ap, ...ap]).length, 4);
assert.equal(isKnown(ap[0], [{ merchant: 'Sunny Pets Academy', due_date: '2026-12-01', amount: '22.88' }]), true);
assert.equal(isKnown(ap[0], [{ merchant: 'Sunny Pets Academy', due_date: '2026-12-15', amount: '22.88' }]), false);
assert.equal(isKnown(ap[1], [{ merchant: 'Other', due_date: '2026-12-01', amount: '5.50' }]), false);

console.log('All BNPL screenshot tests passed');
