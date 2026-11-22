-- Tax-time settings per financial year (e.g. fy = '2026-27') and manual extra expenses
create table public.tax_years (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  fy text not null check (fy ~ '^\d{4}-\d{2}$'),
  floor_pct numeric(5,2) check (floor_pct between 0 and 100),
  area_private numeric(8,2), area_shared numeric(8,2), area_total numeric(8,2),
  rented_from date, rented_to date,
  my_share_pct numeric(5,2) not null default 50 check (my_share_pct between 0 and 100),
  included_categories uuid[] not null default '{}',
  included_loan_accounts uuid[] not null default '{}',
  notes text,
  updated_at timestamptz not null default now(),
  primary key (owner_id, fy)
);
create table public.tax_extras (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  fy text not null,
  entry_date date,
  description text not null,
  amount numeric(12,2) not null check (amount >= 0),
  kind text not null default 'expense' check (kind in ('expense','income')),
  apportion boolean not null default true,
  created_at timestamptz not null default now()
);
create index on public.tax_extras (owner_id, fy);
-- RLS: own rows only (select/insert/update/delete), same pattern as 001.
-- trigger trg_tax_years_touch -> touch_updated_at()
