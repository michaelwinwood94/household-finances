# Household Finances — Stage 1

A personal finance assistant: bank imports, auto-categorising, bills and income calendar,
debt register with creditor contact log, shared costs with ex-partner, and a dashboard.

- **Database:** Supabase project `household-finances` (Sydney) — already set up and tested.
- **App:** plain HTML/JS in `app/` — no build step. Works on phone and desktop.
- **Security:** every table has row level security; each login only ever sees its own rows.
  The key in `app/config.js` is the *publishable* key and is safe to be public.
  Never store full card, bank account or ID numbers anywhere in the app.

## Screens

| Screen | What it's for |
|---|---|
| **Home** | Alerts, four key numbers, what's coming up in the next 14 days (with **Paid** buttons), where the money went (this month / last month / 3-month average), and a 12-month money in vs out chart |
| **Insights** | 4-week balance forecast (bills + income + usual daily spending) with lowest point and safe-to-spend before next pay; bounced payments; bank fees and days overdrawn; subscriptions & repeat charges with **Add as bill**; bills that changed price; categories higher than usual; Afterpay/BNPL vs income; possible double charges |
| **Budget** | Household / Michael / Taslyn: regular income against bills and debt repayments, what's left each month, and average everyday spending. **Budget by category**: set a monthly limit per category and see this month's spending against it |
| **Goals** | 1 · Buffer (cash on hand against a target you set) · 2 · Catch up on overdue amounts (clear-by date and the fortnightly amount needed) · 3 · Pay-down order (overdue first, then highest interest, then smallest balance; time to clear at the entered repayment) |
| **Bills** | Regular payments including loan repayments: per-month totals, the due list with a time-range dropdown (1 week to 6 months, remembered), the full list |
| **Income** | Regular money coming in: per-month totals, expected list with the same time-range dropdown, the full list |
| **Debts** | Who you owe (chart), repayments, overdue amounts, hardship status, and a call log per creditor |
| **Transactions** | Every transaction; filter by months (tick several), account, category, search; totals follow the filter; one-off flag |
| **To sort** | Uncategorised transactions grouped by payee; **One-off** or **Make rule**; **+ New category…** from any category list |
| Payslips | Per person: **Scan payslip** (PDF or photo — read in the browser, every value checked before saving) or type one in; each payslip (earnings, tax, deductions, take-home, employer super, leave, YTD). Live check that it adds up and that super is at least 12%; totals by financial year, monthly chart, CSV, and 'Set up as regular income' |
| Tax | Per person (Michael or Taslyn) and financial year: board received, claimable share of house costs (ATO floor-area × time method), net rental income, Centrelink board-income estimate, CSV for a tax agent, print |
| **Report** | Statement of Financial Position for hardship calls and financial counsellors: quick answers panel (income, living costs, what's left for debts, shortfall, what you could offer, total owed), then household, income, living expenses (3-month average, grouped like hardship forms), debts with last contact and reference, assets, summary, and saved answers to the usual questions. Per week / fortnight / month; per person; **Copy as text**, **Print / PDF**, **CSV** |
| Centrelink estimate (Income & Payslips pages) | Per person on JobSeeker: income Centrelink counts (board 70% minus their share of loan interest, wages from the latest payslip, other income), a progress bar against the $150 free area and the $0 cut-off, estimated payment, wages you can earn before it drops, and a 'what if I earn…' slider. Rates live in one table; set up per person on Household → Centrelink. Morning alert if counted income goes over the free area |
| Links | Bank, debt, bill, government and help websites in one place, each tied to an account or debt: **Open**, then **Import CSV** (with how-to notes and how fresh the data is) or **Update balance**. One-tap suggested links; also shown on Import (Open bank) and Debts (Website). Stored with the household's settings; passwords are never stored |
| Debts → Instalments still to pay | Dated instalments for Afterpay (merchant, amount, due date) grouped by week, with a paid tick; the Afterpay balance is the sum of what's unpaid. Bank payments are **auto-matched** (same amount, within 3 days, provider named) and ticked with an Undo. A "What it was spent on" chart groups what is still owing by category; change a shop's category from the list under it. A matched bank payment takes its shop's category (Groceries, Gas…), so Report, Budget and Tax see real spending; the Report takes that amount off the Afterpay/Deferit repayment so it isn't counted twice |
| Report → period (Last month / 2 / 3 / 6 months) | Chooses the full months that living costs, income actually received and the month-by-month table are averaged over (default 3, remembered). The table shows money in, spending and left over per month, an average row, and the current month 'so far' separately (never averaged). Same exclusions as the report: transfers, bounced payments, debt repayments. The covered dates are stated on the page, in Copy as text and in the CSV. No database changes |
| Report → expand a category | A ▸ arrow on each living-expense category opens what is in it: the shops or payees over the report range (grouped by name, with item counts and the same per-month figure), including Afterpay/Deferit shopping by shop (each purchase counted once at its full price, spread over its 6 weeks of instalments, not as repayments), and bank payments to Afterpay/Deferit that sit in a category. Largest 12 shown, the rest rolled up. Open/closed state is kept while you tick boxes or change the range; not printed |
| Report → hardship-form lines | Living expenses follow the standard hardship forms: Rent & home upkeep, Council rates, Electricity, Gas, Water, Food & groceries, Clothing, Medical & health, Insurance, Car running costs, Travel & transport, Phone & internet, School & children, Entertainment (Gaming, Subscriptions, Apple / app purchases), Other (Bank fees, Cash out, Shopping…). Lines with nothing in them are hidden. Summary uses the form wording: total income, total living expenses, income less living expenses (before repayments), less current repayments being made, shortfall/surplus (screen, Copy as text, CSV, print). New categories Clothing and Entertainment (migration 032) |
| Display → frosted glass (phone and desktop) | Cards, tiles, alerts, the floating bottom bar, More sheet, search and dialogs are translucent glass over a soft fixed gradient (CSS `backdrop-filter`, no images). Glass inside glass stays flat, long-list rows stay near-solid, and it falls back to solid surfaces where blur isn't supported, when the device asks for reduced transparency, and in print/PDF. More menu is grouped (Money / Records / Tools). Home has one primary action whose label follows what matters most: overdue bills, then transactions to sort, then Import. Money figures use tabular numerals; tile labels are small caps |
| Quick actions (+ button, or press +) | A round **+** button (bottom right, above the bar on phone) opens a glass sheet: New bill, New income, Import files, Paste page text, Sort transactions, Log a creditor call, Open the Report, Search. On desktop each has a key (N, E, I, P, S, C, R, /). Esc closes. Hidden when signed out and in print |
| Home → collapsible cards | *Where the money went* and *Money in vs money out* are collapsed by default with a one-line summary (this month's in/out); open or closed is remembered per device. *Coming up* stays open |
| Overdue loans in the due lists | A debt with an overdue amount (arrears) but no overdue bill against it shows as an overdue row ("… — overdue amount") at the top of Bills → Due in the next… and Home → Coming up, and counts in the Overdue tiles. It has no Paid button; clear it by entering the new overdue amount on Debts (or by importing the loan statement) |
| Report → Share link | **Share link** on the Report makes a frozen, view-only copy (as the Report stands, for the selected person/period/frequency) behind a long random secret and gives a link like `…/app/share.html#<secret>`. The secret is in the part after `#`, so it is never sent to a server or logged; only its SHA-256 fingerprint is stored (table `report_shares`, owner-only RLS; the public door is `get_shared_report(token)`). Links last 7 days, can be revoked at once from the same dialog (which also lists links with status and view count), and cannot be retrieved after creation. Shared: summary, income, living expenses, month by month, debts, bank balances and assets answers. Not shared: people's names and contacts, reason/asking, call log, account numbers. The viewer needs no sign-in, is read-only, has Print / PDF, and is marked noindex/no-referrer. A switched-off category is disclosed on the page |
| Arrears card (Home and Insights) | Shows how far behind you are: **Recorded arrears** (debts with an overdue amount, with hardship status), **In arrears: unpaid after latest import** (a bill past its due date where bank data has been imported for a later day and it hasn't been matched as paid; counted in the total) and **Overdue, not yet confirmed** (no import covers the day after the due date; not counted until you import or mark Paid). Computed on the fly, nothing stored, so it clears itself when a payment is matched. In the Report, a debt's overdue amount is the larger of the recorded arrears and its confirmed unpaid repayments. Follows the person switch (shares). Hidden when nothing is overdue |
| Report accuracy | Own-account transfers are matched automatically (equal debit and credit in different accounts within 3 days, both unsorted or marked transfer) and left out; refunds reduce the category they came from instead of counting as income; bills paid every 2+ months (rates, insurance, rego) are spread evenly by their recurring-item amount; single purchases of $300+ that are not regular costs are listed separately and left out of the ongoing figures (one click to include them) |
| Report → Afterpay/Deferit shopping in living costs | Each purchase still being paid off is counted once, at its full price, under its shop category (Groceries, Gas…): instalments are grouped into purchases (purchase date = due date − (n−1)×14 days) and the price is spread over the 6-week pay-in-4 window. The same amount is taken off that provider's repayment in Debts and paid/matched instalments are skipped (their bank payment already carries the category), so nothing is counted twice. Rows without "x of 4" fall back to unpaid ÷ months until the last due date |
| Report → tick boxes on living-expense categories | Untick a category (or a whole group) to see the impact: income left, offer, shortfall, month-by-month, copy and CSV all recalculate without it. A banner says what is switched off, with one button to switch everything back on. What-if only: not saved, and the print version leaves unticked lines out |
| Import files → scanned CommBank NetBank page (PDF) | A NetBank 'Account overview' page saved as a picture-only PDF is read by in-browser text recognition (date headings, +/− amounts, balances; overdrawn balances and minus signs read as quote marks are handled). A read amount is kept; only an unreadable one is worked out from the running balance, and where balances don't add up the preview names the dates to check (a row can be lost at a page break). Rows already on file are matched by amount within 3 days (NetBank dates some credits a day earlier than the CSV) and keep their stored date and wording, so nothing is added twice. The existing CommBank account without a number is used and given its last 4 digits. Click 'Load more transactions' before saving to PDF (`tests/commbank-scan.test.mjs`) |
| Import files → scanned Westpac Account activity PDF | A Westpac Account activity page saved as a PDF from the browser (picture only, no text) is read page by page by in-browser text recognition. Every amount is checked against the running balance: hidden amounts (e.g. under the 'Chat with us' box) are filled in and misread amounts corrected, and the preview says how many. Where the same date and amount are already on file, the stored wording is kept so nothing is added twice. Westpac shows 100 rows at a time: click 'Display more' before saving to PDF (`tests/westpac-scan.test.mjs`) |
| Import files → Latitude loan statement (PDF) | Same button as Westpac/CommBank. The loan statement's transactions are read (interest −, fees −, repayments/waivers +; rate-change notes ignored), the account is created as a loan showing last 4 digits only, and the Latitude debt is updated from the statement: balance, overdue, minimum, rate. The debt is linked to the account so its balance follows future statements. Rules file interest, fees and waivers as 'Loan interest (not counted)' and loan-side repayments as account transfers, because the real payment is counted from the bank account (`tests/latitude.test.mjs`) |
| Import → Scan Afterpay / Deferit (also on Debts → Instalments) | Pick one or several phone screenshots of the portal's upcoming payments list. Each shop, amount, due date and 'x of y' is read in the browser (free OCR, two screen regions so values stay with their row), shops get their remembered category (new shops: choose once, it is remembered), and you check every row before saving. Rows already in the list are skipped; ticks and matches are left alone; the debt balance is recalculated and matching runs. Deferit months are worked out from the order of the list; Deferit's monthly fee is listed but unticked. Reads phone-width screenshots; the last row is lost if the portal's footer bar covers it (`tests/bnpl.test.mjs`) |
| Import → Paste page text | The most reliable route: on the Westpac Account activity, CommBank NetBank, Afterpay or Deferit page press Ctrl+A, Ctrl+C, paste into the box on Import and press Read. No OCR — exact text. The page is recognised automatically: bank pages go through the normal import (account matching, duplicates skipped, pending CommBank rows skipped, running-balance check), Afterpay/Deferit open the check-each-row dialog. Westpac shows 100 rows at a time — click Display more first (`tests/bank-paste.test.mjs`, `tests/bnpl-pdf.test.mjs`) |
| Import → Afterpay / Deferit PDFs | A website "Upcoming payments" page saved as a picture-only PDF (Print to PDF) goes through the same **Import files** button (or the Scan button). It is read by free in-browser OCR, recognised as Afterpay or Deferit, and opens the same check-each-row dialog. Deferit's cut-off shop names ("R…") are filled in from instalments already saved with the same amount; known rows are skipped (amount within 2c, as OCR can misread a digit) (`tests/bnpl-pdf.test.mjs`) |
| Household | The people in the household (one login, any number of people): name, who they are, email, phone, notes. New accounts start with one person and a welcome form. The top switch shows Household or any one person; every bill, debt, account and tax year has a **Who pays** split — equal by default, or one person / custom % |
| Import · Shared · Setup | **Scan a bill** (PDF or photo: biller, amount due, due date, billing period, BPAY code; only the last 4 of any reference kept; check it, then update the matching bill or add a new one) · statement import (CSV/PDF, multi-account), shared-cost ledger, settings/accounts/categories/rules |

## Put it on your phone
Open the app address in Safari (iPhone) or Chrome (Android), then **Share → Add to Home Screen** (iPhone) or menu → **Install app** (Android). It opens full screen like any app. The ⬇ Install button in the top bar shows the steps.

## First-time setup (about 15 minutes)

### 1. Tell Supabase where the app lives
Supabase dashboard → project **household-finances** → **Authentication → URL Configuration**:
- **Site URL:** the web address where you host the app (step 3), e.g. `https://michaelwinwood94.github.io/household-finances/app/`
- Add the same address under **Redirect URLs**.

Until hosting is set up you can skip email confirmation instead:
**Authentication → Sign In / Providers → Email → turn off "Confirm email"** (fine for a single-user app).

### 2. Put the code on GitHub
1. On github.com create a new repository called `household-finances` (no README).
2. Upload the contents of this folder (or let Claude push it once the repo exists).

### 3. Host the app
**Option A — GitHub Pages (simplest, needs a public repo).** The code holds no personal data,
so a public repo is OK. Repo → Settings → Pages → Source: *Deploy from a branch* →
branch `main`, folder `/ (root)`. The app will be at `https://<you>.github.io/household-finances/app/`.

**Option B — keep the repo private.** Connect it to Cloudflare Pages or Netlify (both free),
publish directory `app`.

### 4. First login
Open the app → enter email + password → **Create account** → confirm email if asked → sign in.
Starter categories and ~30 auto-categorising rules are added automatically.

### 5. Load your data (in this order)
1. **Import:** choose all your statement files at once (CommBank CSV, Westpac CSV or Account activity PDF).
   New accounts are created automatically with the correct starting balance; rename them in Setup if you like.
   Note: the Westpac app's PDF seems to stop at 100 transactions — for longer history export CSV from Westpac Online Banking.
   Tick **Joint / shared account** for the CommBank account — the dashboard then counts only your share of it.
2. **Setup → Bank accounts:** check the account names and types (home loans are set as *mortgage*) and the share % on joint accounts.
3. **Transactions → Only uncategorised:** set categories; use **Make rule** for anything that repeats.
4. **Bills & income:** add Centrelink, mortgage, Synergy, water, insurance, Afterpay, subscriptions.
   Put the text that appears on your statement in *Text on bank statement* so payments are matched.
5. **Debts:** add every debt. Mark priority 1 for mortgage and power. Set hardship to *to request*
   for the ones you want help with — and take that list to a free financial counsellor
   (National Debt Helpline **1800 007 007**, Mon–Fri).
6. **Shared costs / Settings:** set what to call your ex-partner and your usual share %.

## Testing done
- Database: import, duplicate skipping, rule categorising, bill matching and due-date roll-forward,
  shared-cost creation, all dashboard views — tested with sample data, then removed.
- Security: a second test user could not see or write the first user's data. Supabase security advisor: no issues.
- Payslip reader: `node tests/payslip.test.mjs` (two PDF layouts + an OCR'd photo, all made-up)
- Scanned CommBank page reader: `node tests/commbank-scan.test.mjs` (made-up page text; also run on a real 24-page scan — 236 rows, 231 matched your data within 2 days, the 4 odd ones traced to a row lost at a page break)
- Scanned Westpac page reader: `node tests/westpac-scan.test.mjs` (made-up page text; also run on a real 4-page scan — 100 rows, 0 running-balance breaks)
- Latitude statement reader: `node tests/latitude.test.mjs` (made-up loan statement; checked on a real one — 101 rows, opening balance reconciles to the cent)
- Bill reader: `node tests/bill.test.mjs` (power, water and phone bills, all made-up; also checked on an OCR'd photo)
- CSV parser: `node tests/csv.test.mjs` (Westpac, CommBank, generic, bad files).
- Real statements (22 Nov 2026): CommBank CSV 2,580 rows, Westpac Choice PDF 86 rows, two Rocket Repay home-loan PDFs 100 rows each — all parsed with nothing skipped; PDF results checked against a second PDF reader.
- Every screen rendered in a headless browser at desktop and phone size with no script errors.
- **Not yet tested with your real bank exports** — if an import shows "not recognised", send Claude
  the first two lines of the CSV (with amounts changed if you like).

## Automation (running now)
- **Every import:** transactions sorted by rules; bills/income matched and due dates moved on; loan debts updated from the loan account balance.
- **Every morning at 6am:** alerts on the dashboard for bills due within 3 days, bills not seen paid, income that hasn't arrived, overdrawn accounts, creditor follow-ups and hardship arrangements about to end.
- **Also every morning, and after every import:** bounced direct debits (and the payment they reverse) are set aside so they don't count as income or spending, and the bill goes back to owing; bill amounts update when the bank shows a new price twice in a row; alerts for money likely to run short in the next 14 days, a payment that bounced, a possible double charge, and a category well above its usual month.
- **Afterpay / Deferit matching** (every import, every morning, and when Debts opens): each due instalment is matched to one bank payment and ticked; a payment later bounced un-ticks it. Alerts: instalment not seen paid, payment not in your list, amount differs from the list. Only payments after the debt's `match_from` date are checked for 'not in your list'.
- Bills and income marked "Auto-detected" were found from your transactions — edit or delete any that are wrong.

## Display
Dark mode: ☾/☀ button in the top bar (one tap); **Aa** menu has Light / Dark / Auto. New devices default to Auto (follows the phone).

## Coming next
- **Stage 3 (rest):** phone notifications, budget-overspend alerts, Google Drive drop-folder import.
- **Stage 4:** cash-flow forecast to next payday; optional live bank feeds (Consumer Data Right provider).

## Database changes
All schema changes are in `supabase/migrations/` in the order they were applied.
