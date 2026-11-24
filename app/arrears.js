// A bill that is past its due date is "in arrears" once bank data has been imported for a day AFTER the due date and it still has not been matched
// as paid (a matched payment moves the due date on). If the data only runs up to the due date, it is just "overdue, not yet confirmed".
// Pure functions, no database access (tested in tests/arrears.test.mjs).

// latest transaction date per account, plus the latest overall
export function dataThrough(txns) {
  const byAccount = {}; let any = '';
  for (const t of txns) { if (!t.txn_date) continue; if (t.txn_date > any) any = t.txn_date; if (!byAccount[t.account_id] || t.txn_date > byAccount[t.account_id]) byAccount[t.account_id] = t.txn_date; }
  return { byAccount, any };
}

// split overdue bills into confirmed (imported data runs past the due date) and unconfirmed
export function classifyOverdue(items, through, todayISO) {
  const confirmed = [], unconfirmed = [];
  for (const i of items) {
    if (i.direction !== 'out' || i.is_active === false || !(i.next_due < todayISO)) continue;
    const upTo = (i.account_id && through.byAccount[i.account_id]) || through.any;
    (upTo && upTo > i.next_due ? confirmed : unconfirmed).push(i);
  }
  return { confirmed, unconfirmed };
}
