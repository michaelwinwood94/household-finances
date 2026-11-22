# Household Finances — Stage 1

A personal finance assistant: bank imports, auto-categorising, bills and income calendar,
debt register with creditor contact log, shared costs with ex-partner, and a dashboard.

- **Database:** Supabase project `household-finances` (Sydney) — already set up and tested.
- **App:** plain HTML/JS in `app/` — no build step. Works on phone and desktop.
- **Security:** every table has row level security; each login only ever sees its own rows.
  The key in `app/config.js` is the *publishable* key and is safe to be public.
  Never store full card, bank account or ID numbers anywhere in the app.

## What's in Stage 1

| Screen | What it does |
|---|---|
| Dashboard | Money in accounts, this month in/out, regular monthly gap, total debt and arrears, shared balance, next 3 weeks of bills/income, spending vs budget, creditor follow-ups due |
| Transactions | Filter by month / account / search; change category; tick "shared"; **Make rule** to auto-categorise similar transactions forever |
| Import | Upload Westpac or CommBank CSV → preview → import. Duplicates skipped automatically. Matches bills (marks paid, moves due date on). **Undo** any import |
| Bills & income | Recurring bills and income (weekly / fortnightly / monthly …), shared %, next 5 weeks cash view |
| Debts | Every debt with arrears, minimums, priority (1 = housing/power), hardship status; **Log** button keeps a record of every creditor call |
| Shared costs | Who paid what, your share %, settlements, running "who owes whom" |
| Setup | Settings, bank accounts, categories and budgets, auto-categorising rules |

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
1. **Setup → Bank accounts:** add each Westpac and CommBank account. Set *Start date* to the
   first day of the statement you'll import and *Balance at start date* to the balance on that day.
2. **Import:** export each account as CSV from online banking and import it.
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
- Every screen rendered in a headless browser at desktop and phone size with no script errors.
- **Not yet tested with your real bank exports** — if an import shows "not recognised", send Claude
  the first two lines of the CSV (with amounts changed if you like).

## Coming next
- **Stage 2:** goals screen (buffer → catch-up → pay-down), budget editor, debt payoff view.
- **Stage 3:** automation — nightly checks that create dashboard alerts (bill due in 3 days,
  missed payment, budget overspend, follow-up due), phone notifications.
- **Stage 4:** cash-flow forecast to next payday; optional live bank feeds (Consumer Data Right provider).

## Database changes
All schema changes are in `supabase/migrations/` in the order they were applied.
