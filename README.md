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
| **Budget** | Household / Michael / Taslyn: regular income against bills and debt repayments, what's left each month, and average everyday spending |
| **Bills** | Regular payments including loan repayments: per-month totals, due in the next 5 weeks, the full list |
| **Income** | Regular money coming in: per-month totals, expected in the next 5 weeks, the full list |
| **Debts** | Who you owe (chart), repayments, overdue amounts, hardship status, and a call log per creditor |
| **Transactions** | Every transaction; filter by months (tick several), account, category, search; totals follow the filter; one-off flag |
| **To sort** | Uncategorised transactions grouped by payee; **One-off** or **Make rule**; **+ New category…** from any category list |
| Tax | Per person (Michael or Taslyn) and financial year: board received, claimable share of house costs (ATO floor-area × time method), net rental income, Centrelink board-income estimate, CSV for a tax agent, print |
| Import · Shared · Setup | Statement import (CSV/PDF, multi-account), shared-cost ledger, settings/accounts/categories/rules |

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
- CSV parser: `node tests/csv.test.mjs` (Westpac, CommBank, generic, bad files).
- Real statements (22 Nov 2026): CommBank CSV 2,580 rows, Westpac Choice PDF 86 rows, two Rocket Repay home-loan PDFs 100 rows each — all parsed with nothing skipped; PDF results checked against a second PDF reader.
- Every screen rendered in a headless browser at desktop and phone size with no script errors.
- **Not yet tested with your real bank exports** — if an import shows "not recognised", send Claude
  the first two lines of the CSV (with amounts changed if you like).

## Automation (running now)
- **Every import:** transactions sorted by rules; bills/income matched and due dates moved on; loan debts updated from the loan account balance.
- **Every morning at 6am:** alerts on the dashboard for bills due within 3 days, bills not seen paid, income that hasn't arrived, overdrawn accounts, creditor follow-ups and hardship arrangements about to end.
- Bills and income marked "Auto-detected" were found from your transactions — edit or delete any that are wrong.

## Coming next
- **Stage 2:** goals screen (buffer → catch-up → pay-down), budget editor, debt payoff view.
- **Stage 3 (rest):** phone notifications, budget-overspend alerts, Google Drive drop-folder import.
- **Stage 4:** cash-flow forecast to next payday; optional live bank feeds (Consumer Data Right provider).

## Database changes
All schema changes are in `supabase/migrations/` in the order they were applied.
