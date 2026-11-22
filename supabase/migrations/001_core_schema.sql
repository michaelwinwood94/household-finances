-- Household Finances — Stage 1 core schema
-- Every table is owned by the logged-in user (owner_id = auth.uid()) and locked with RLS.

create extension if not exists pgcrypto;

-- ---------- Helper: frequency maths ----------
create type public.frequency as enum ('once','weekly','fortnightly','monthly','quarterly','yearly');

create or replace function public.to_monthly(amount numeric, freq public.frequency)
returns numeric language sql immutable set search_path = '' as $$
  select case freq
    when 'weekly'      then amount * 52 / 12
    when 'fortnightly' then amount * 26 / 12
    when 'monthly'     then amount
    when 'quarterly'   then amount / 3
    when 'yearly'      then amount / 12
    else 0 end
$$;

create or replace function public.next_occurrence(d date, freq public.frequency)
returns date language sql immutable set search_path = '' as $$
  select case freq
    when 'weekly'      then d + 7
    when 'fortnightly' then d + 14
    when 'monthly'     then (d + interval '1 month')::date
    when 'quarterly'   then (d + interval '3 months')::date
    when 'yearly'      then (d + interval '1 year')::date
    else null end
$$;

-- ---------- Settings (one row per user) ----------
create table public.settings (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  display_name text,
  partner_label text not null default 'Ex-partner',
  default_my_share_pct numeric(5,2) not null default 50 check (default_my_share_pct between 0 and 100),
  pay_frequency public.frequency not null default 'fortnightly',
  next_pay_date date,
  buffer_target numeric(12,2) not null default 1000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Accounts ----------
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  institution text not null default 'Other' check (institution in ('Westpac','CommBank','Other')),
  account_type text not null default 'transaction'
    check (account_type in ('transaction','savings','offset','credit_card','loan','mortgage','cash','other')),
  nickname_last4 text check (nickname_last4 ~ '^[0-9]{0,4}$'),  -- last 4 digits only, never full numbers
  opening_balance numeric(12,2) not null default 0,
  opening_date date not null default current_date,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- Categories ----------
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('income','expense','transfer')),
  is_essential boolean not null default false,
  monthly_budget numeric(12,2),
  colour text,
  sort_order int not null default 100,
  unique (owner_id, name)
);

-- ---------- Categorising rules ----------
create table public.category_rules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  match_text text not null,
  match_type text not null default 'contains' check (match_type in ('contains','starts_with','exact')),
  direction text not null default 'any' check (direction in ('any','in','out')),
  category_id uuid not null references public.categories(id) on delete cascade,
  mark_shared boolean not null default false,
  priority int not null default 100,   -- lower number wins
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- Import batches ----------
create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  filename text,
  bank_format text,
  rows_received int not null default 0,
  rows_inserted int not null default 0,
  rows_duplicate int not null default 0,
  created_at timestamptz not null default now()
);

-- ---------- Debts ----------
create table public.debts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  creditor text not null,
  debt_type text not null default 'other'
    check (debt_type in ('mortgage','car_loan','personal_loan','credit_card','bnpl','utility','tax','fine','court','centrelink','family','other')),
  original_balance numeric(12,2),
  current_balance numeric(12,2) not null default 0,
  balance_as_at date not null default current_date,
  interest_rate_pct numeric(6,3),
  min_payment numeric(12,2),
  payment_frequency public.frequency default 'monthly',
  arrears_amount numeric(12,2) not null default 0,
  priority int not null default 3 check (priority between 1 and 5),  -- 1 = most urgent (housing, power)
  hardship_status text not null default 'none'
    check (hardship_status in ('none','to_request','requested','approved','declined','expired')),
  hardship_until date,
  status text not null default 'active' check (status in ('active','paid_off','closed','disputed')),
  is_shared boolean not null default false,
  my_share_pct numeric(5,2) not null default 100 check (my_share_pct between 0 and 100),
  reference_note text,  -- e.g. "account ending 4417" — never full numbers
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Creditor contact log ----------
create table public.debt_contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  debt_id uuid not null references public.debts(id) on delete cascade,
  contact_date date not null default current_date,
  method text not null default 'phone' check (method in ('phone','email','letter','online','in_person','counsellor')),
  spoke_to text,
  reference_number text,
  summary text not null,
  agreed text,
  follow_up_date date,
  follow_up_done boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- Recurring items (bills + income) ----------
create table public.recurring_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  direction text not null check (direction in ('in','out')),
  amount numeric(12,2) not null check (amount >= 0),
  frequency public.frequency not null default 'monthly',
  next_due date not null,
  category_id uuid references public.categories(id) on delete set null,
  account_id uuid references public.accounts(id) on delete set null,
  debt_id uuid references public.debts(id) on delete set null,
  match_text text,       -- text to auto-detect when this bill has been paid
  is_shared boolean not null default false,
  my_share_pct numeric(5,2) not null default 100 check (my_share_pct between 0 and 100),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

-- ---------- Transactions ----------
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  txn_date date not null,
  description text not null,
  amount numeric(12,2) not null,       -- positive = money in, negative = money out
  bank_balance numeric(12,2),           -- running balance from the statement, if given
  category_id uuid references public.categories(id) on delete set null,
  category_source text not null default 'none' check (category_source in ('none','rule','manual')),
  recurring_item_id uuid references public.recurring_items(id) on delete set null,
  debt_id uuid references public.debts(id) on delete set null,
  is_shared boolean not null default false,
  import_batch_id uuid references public.import_batches(id) on delete set null,
  dedupe_key text not null,
  notes text,
  created_at timestamptz not null default now(),
  unique (owner_id, dedupe_key)
);
create index on public.transactions (owner_id, txn_date desc);
create index on public.transactions (account_id, txn_date desc);
create index on public.transactions (category_id);
create index on public.transactions (import_batch_id);
create index on public.transactions (recurring_item_id);
create index on public.transactions (debt_id);

-- ---------- Shared costs ledger (with ex-partner) ----------
create table public.shared_ledger (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_date date not null default current_date,
  entry_type text not null default 'expense' check (entry_type in ('expense','settlement')),
  description text not null,
  total_amount numeric(12,2) not null check (total_amount > 0),
  paid_by text not null check (paid_by in ('me','partner')),
  my_share_pct numeric(5,2) not null default 50 check (my_share_pct between 0 and 100),
  transaction_id uuid references public.transactions(id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);
create index on public.shared_ledger (transaction_id);

-- ---------- Goals ----------
create table public.goals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  goal_type text not null default 'save' check (goal_type in ('buffer','catch_up','pay_down','save','spend_limit')),
  target_amount numeric(12,2) not null,
  current_amount numeric(12,2) not null default 0,
  debt_id uuid references public.debts(id) on delete set null,
  account_id uuid references public.accounts(id) on delete set null,
  target_date date,
  priority int not null default 3 check (priority between 1 and 5),
  status text not null default 'active' check (status in ('active','achieved','paused','dropped')),
  notes text,
  created_at timestamptz not null default now()
);

-- ---------- Alerts (filled by automation in Stage 3) ----------
create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  severity text not null default 'info' check (severity in ('info','warning','urgent')),
  title text not null,
  body text,
  due_date date,
  source_key text not null,   -- prevents the same alert being raised twice
  dismissed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (owner_id, source_key)
);

-- FK indexes
create index on public.category_rules (category_id);
create index on public.import_batches (account_id);
create index on public.debt_contacts (debt_id);
create index on public.recurring_items (category_id);
create index on public.recurring_items (account_id);
create index on public.recurring_items (debt_id);
create index on public.goals (debt_id);
create index on public.goals (account_id);

-- ---------- Row level security ----------
do $$
declare t text;
begin
  foreach t in array array['settings','accounts','categories','category_rules','import_batches','debts',
                           'debt_contacts','recurring_items','transactions','shared_ledger','goals','alerts']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "own rows - select" on public.%I for select to authenticated using (owner_id = (select auth.uid()))', t);
    execute format('create policy "own rows - insert" on public.%I for insert to authenticated with check (owner_id = (select auth.uid()))', t);
    execute format('create policy "own rows - update" on public.%I for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()))', t);
    execute format('create policy "own rows - delete" on public.%I for delete to authenticated using (owner_id = (select auth.uid()))', t);
  end loop;
end $$;

-- ---------- updated_at touch ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger trg_settings_touch before update on public.settings for each row execute function public.touch_updated_at();
create trigger trg_debts_touch before update on public.debts for each row execute function public.touch_updated_at();
