// Made-up bills (no real customer data). Run: node tests/bill.test.mjs
import { readFileSync } from 'node:fs';
const { readBill } = await import('../app/bill.js');
const read = f => readBill(readFileSync(new URL(`./bills/${f}`, import.meta.url), 'utf8').split('\n'));
let fails = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fails++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); } };
let r = read('power.txt');
eq('power biller', r.biller, 'Synergy'); eq('power cat', r.category, 'Power'); eq('power amount', r.amount, 298.15); eq('power due', r.due_date, '2026-11-23');
eq('power period', [r.period_start, r.period_end], ['2026-09-01', '2026-10-31']); eq('power ref', r.ref_last4, '3210'); eq('power biller code', r.biller_code, '41111'); eq('power freq', r.frequency, 'bimonthly');
r = read('water.txt');
eq('water biller', r.biller, 'Water Corporation'); eq('water amount', r.amount, 186.72); eq('water due', r.due_date, '2026-12-29');
eq('water freq', r.frequency, 'quarterly'); eq('water period', [r.period_start, r.period_end], ['2026-09-01', '2026-11-30']); eq('water ref', r.ref_last4, '6789');
r = read('phone.txt');
eq('phone biller', r.biller, 'Harbour Mobile'); eq('phone amount', r.amount, 130); eq('phone due', r.due_date, '2026-11-28');
eq('phone freq', r.frequency, 'monthly'); eq('phone overdue', r.overdue, true); eq('phone ref', r.ref_last4, '0012');
console.log(fails ? `${fails} bill test(s) failed` : 'All bill tests passed');
process.exit(fails ? 1 : 0);
