-- Household Finances — Stage 1 logic: categorising, CSV import, starter data, dashboard views

-- ---------- Pick a category for a transaction using the user's rules ----------
create or replace function public.match_rule(p_owner uuid, p_description text, p_amount numeric)
returns table (category_id uuid, mark_shared boolean)
language sql stable set search_path = '' as $$
  select r.category_id, r.mark_shared
  from public.category_rules r
  where r.owner_id = p_owner and r.is_active
    and (r.direction = 'any' or (r.direction = 'in' and p_amount > 0) or (r.direction = 'out' and p_amount < 0))
    and case r.match_type
          when 'contains'    then upper(p_description) like '%' || upper(r.match_text) || '%'
          when 'starts_with' then upper(p_description) like upper(r.match_text) || '%'
          when 'exact'       then upper(trim(p_description)) = upper(trim(r.match_text))
        end
  order by r.priority, length(r.match_text) desc
  limit 1
$$;

-- ---------- Import rows parsed from a bank CSV ----------
-- p_rows: [{"date":"2026-11-20","description":"...","amount":-12.50,"balance":1234.56}, ...]
-- Runs as the calling user, so RLS still applies.
create or replace function public.import_transactions(
  p_account_id uuid, p_rows jsonb, p_filename text default null, p_format text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_batch uuid;
  v_received int := coalesce(jsonb_array_length(p_rows), 0);
  v_inserted int := 0;
  v_shared int := 0;
  v_bills int := 0;
  v_default_share numeric;
begin
  if v_owner is null then raise exception 'Not logged in'; end if;
  if not exists (select 1 from public.accounts where id = p_account_id and owner_id = v_owner) then
    raise exception 'Account not found';
  end if;

  select coalesce((select default_my_share_pct from public.settings where owner_id = v_owner), 50)
    into v_default_share;

  insert into public.import_batches (owner_id, account_id, filename, bank_format, rows_received)
  values (v_owner, p_account_id, p_filename, p_format, v_received)
  returning id into v_batch;

  with src as (
    select (r->>'date')::date as d,
           regexp_replace(trim(r->>'description'), '\s+', ' ', 'g') as descr,
           round((r->>'amount')::numeric, 2) as amt,
           nullif(r->>'balance','')::numeric as bal,
           ord
    from jsonb_array_elements(p_rows) with ordinality as x(r, ord)
    where r->>'date' is not null and r->>'amount' is not null
  ), keyed as (
    select s.*,
           -- occurrence number lets two identical same-day purchases both be kept,
           -- while re-importing an overlapping statement skips ones already loaded
           row_number() over (partition by d, amt, upper(descr) order by ord) as occ
    from src s
  ), ins as (
    insert into public.transactions
      (owner_id, account_id, txn_date, description, amount, bank_balance,
       category_id, category_source, is_shared, import_batch_id, dedupe_key)
    select v_owner, p_account_id, k.d, k.descr, k.amt, k.bal,
           m.category_id,
           case when m.category_id is null then 'none' else 'rule' end,
           coalesce(m.mark_shared, false),
           v_batch,
           md5(p_account_id::text || '|' || k.d || '|' || k.amt || '|' || upper(k.descr) || '|' || k.occ)
    from keyed k
    left join lateral public.match_rule(v_owner, k.descr, k.amt) m on true
    on conflict (owner_id, dedupe_key) do nothing
    returning id, txn_date, description, amount, is_shared
  ), shared as (
    insert into public.shared_ledger (owner_id, entry_date, description, total_amount, paid_by, my_share_pct, transaction_id)
    select v_owner, i.txn_date, i.description, abs(i.amount), 'me', v_default_share, i.id
    from ins i where i.is_shared and i.amount < 0
    returning 1
  )
  select (select count(*) from ins), (select count(*) from shared) into v_inserted, v_shared;

  -- Link new transactions to known bills/income and roll the due date forward
  with candidates as (
    select t.id as txn_id, ri.id as item_id, t.txn_date,
           row_number() over (partition by t.id order by length(ri.match_text) desc) as rn
    from public.transactions t
    join public.recurring_items ri
      on ri.owner_id = v_owner and ri.is_active and ri.match_text is not null and ri.match_text <> ''
     and upper(t.description) like '%' || upper(ri.match_text) || '%'
     and ((ri.direction = 'in' and t.amount > 0) or (ri.direction = 'out' and t.amount < 0))
    where t.import_batch_id = v_batch and t.recurring_item_id is null
  ), linked as (
    update public.transactions t set recurring_item_id = c.item_id
    from candidates c where c.rn = 1 and t.id = c.txn_id
    returning c.item_id, c.txn_date
  ), latest as (
    select item_id, max(txn_date) as paid_on from linked group by item_id
  ), rolled as (
    update public.recurring_items ri
    set next_due = public.next_occurrence(ri.next_due, ri.frequency)
    from latest l
    where ri.id = l.item_id and ri.frequency <> 'once' and l.paid_on >= ri.next_due - 7
    returning 1
  )
  select count(*) from linked into v_bills;

  update public.import_batches
  set rows_inserted = v_inserted, rows_duplicate = v_received - v_inserted
  where id = v_batch;

  return jsonb_build_object('batch_id', v_batch, 'received', v_received, 'inserted', v_inserted,
                            'duplicates', v_received - v_inserted, 'shared_added', v_shared,
                            'linked_to_bills', v_bills);
end $$;

-- Re-run rules over transactions that were never categorised by hand
create or replace function public.recategorise_uncategorised()
returns int language plpgsql security invoker set search_path = '' as $$
declare n int;
begin
  update public.transactions t
  set category_id = m.category_id, category_source = 'rule'
  from public.transactions t2
  cross join lateral public.match_rule(t2.owner_id, t2.description, t2.amount) m
  where t.id = t2.id and t.owner_id = auth.uid() and t.category_source <> 'manual'
    and m.category_id is not null and t.category_id is distinct from m.category_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- Starter categories and rules (safe to run more than once) ----------
create or replace function public.seed_defaults()
returns void language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Not logged in'; end if;

  insert into public.settings (owner_id) values (v_owner) on conflict do nothing;

  insert into public.categories (owner_id, name, kind, is_essential, sort_order) values
    (v_owner,'Centrelink','income',false,10),
    (v_owner,'Work income','income',false,11),
    (v_owner,'Other income','income',false,12),
    (v_owner,'Mortgage','expense',true,20),
    (v_owner,'Power','expense',true,21),
    (v_owner,'Water','expense',true,22),
    (v_owner,'Rates','expense',true,23),
    (v_owner,'Insurance','expense',true,24),
    (v_owner,'Groceries','expense',true,25),
    (v_owner,'Phone & internet','expense',true,26),
    (v_owner,'Fuel','expense',true,27),
    (v_owner,'Car loan','expense',true,28),
    (v_owner,'Car costs','expense',true,29),
    (v_owner,'Medical & pharmacy','expense',true,30),
    (v_owner,'Debt repayments','expense',true,31),
    (v_owner,'Afterpay / BNPL','expense',false,40),
    (v_owner,'Subscriptions','expense',false,41),
    (v_owner,'Takeaway & eating out','expense',false,42),
    (v_owner,'Shopping','expense',false,43),
    (v_owner,'Bank fees','expense',false,44),
    (v_owner,'Cash out','expense',false,45),
    (v_owner,'Other spending','expense',false,49),
    (v_owner,'Transfer between my accounts','transfer',false,90)
  on conflict (owner_id, name) do nothing;

  -- Only add starter rules the first time
  if not exists (select 1 from public.category_rules where owner_id = v_owner) then
    insert into public.category_rules (owner_id, match_text, direction, category_id, mark_shared, priority)
    select v_owner, r.txt, r.dir, c.id, r.shared, r.pri
    from (values
      ('CENTRELINK','in','Centrelink',false,10),
      ('SERVICES AUSTRALIA','in','Centrelink',false,10),
      ('SYNERGY','out','Power',true,20),
      ('WATER CORP','out','Water',true,20),
      ('AFTERPAY','out','Afterpay / BNPL',false,30),
      ('ZIP PAY','out','Afterpay / BNPL',false,30),
      ('WOOLWORTHS','out','Groceries',false,40),
      ('COLES','out','Groceries',false,40),
      ('ALDI','out','Groceries',false,40),
      ('IGA','out','Groceries',false,45),
      ('TELSTRA','out','Phone & internet',false,40),
      ('OPTUS','out','Phone & internet',false,40),
      ('VODAFONE','out','Phone & internet',false,40),
      ('NETFLIX','out','Subscriptions',false,40),
      ('SPOTIFY','out','Subscriptions',false,40),
      ('XBOX','out','Subscriptions',false,40),
      ('CALTEX','out','Fuel',false,40),
      ('AMPOL','out','Fuel',false,40),
      ('PUMA ENERGY','out','Fuel',false,40),
      ('SHELL','out','Fuel',false,45),
      ('CHEMIST','out','Medical & pharmacy',false,40),
      ('PHARMACY','out','Medical & pharmacy',false,40),
      ('MCDONALDS','out','Takeaway & eating out',false,40),
      ('UBER EATS','out','Takeaway & eating out',false,40),
      ('MENULOG','out','Takeaway & eating out',false,40),
      ('ATM','out','Cash out',false,50),
      ('FEE','out','Bank fees',false,60)
    ) as r(txt, dir, cat, shared, pri)
    join public.categories c on c.owner_id = v_owner and c.name = r.cat;
  end if;
end $$;

-- ---------- Upcoming bills and income (expands weekly/fortnightly repeats) ----------
create or replace function public.upcoming_items(p_days int default 35)
returns table (item_id uuid, name text, direction text, due_date date, amount numeric,
               my_amount numeric, is_shared boolean, category_name text, debt_id uuid, overdue boolean)
language sql stable security invoker set search_path = '' as $$
  with recursive occ as (
    select ri.id, ri.next_due as d, ri.frequency, 1 as n
    from public.recurring_items ri
    where ri.owner_id = (select auth.uid()) and ri.is_active
    union all
    select o.id, public.next_occurrence(o.d, o.frequency), o.frequency, o.n + 1
    from occ o
    where o.frequency <> 'once' and o.n < 60
      and public.next_occurrence(o.d, o.frequency) <= current_date + p_days
  )
  select ri.id, ri.name, ri.direction, o.d, ri.amount,
         round(ri.amount * ri.my_share_pct / 100, 2), ri.is_shared, c.name, ri.debt_id,
         o.d < current_date
  from occ o
  join public.recurring_items ri on ri.id = o.id
  left join public.categories c on c.id = ri.category_id
  where o.d <= current_date + p_days
  order by o.d, ri.direction desc, ri.amount desc
$$;

-- ---------- Dashboard views (security_invoker = each user only sees their own rows) ----------
create or replace view public.v_account_balances with (security_invoker = true) as
select a.id, a.owner_id, a.name, a.institution, a.account_type, a.nickname_last4, a.is_active,
       a.opening_balance + coalesce(sum(t.amount) filter (where t.txn_date >= a.opening_date), 0) as calculated_balance,
       (select t2.bank_balance from public.transactions t2
         where t2.account_id = a.id and t2.bank_balance is not null
         order by t2.txn_date desc, t2.created_at desc limit 1) as last_statement_balance,
       max(t.txn_date) as last_transaction_date,
       count(t.id) as transaction_count
from public.accounts a
left join public.transactions t on t.account_id = a.id
group by a.id;

create or replace view public.v_monthly_cashflow with (security_invoker = true) as
select t.owner_id,
       date_trunc('month', t.txn_date)::date as month,
       sum(t.amount) filter (where t.amount > 0 and coalesce(c.kind,'') <> 'transfer') as money_in,
       -sum(t.amount) filter (where t.amount < 0 and coalesce(c.kind,'') <> 'transfer') as money_out,
       sum(t.amount) filter (where coalesce(c.kind,'') <> 'transfer') as net
from public.transactions t
left join public.categories c on c.id = t.category_id
group by t.owner_id, date_trunc('month', t.txn_date);

create or replace view public.v_category_spend_month with (security_invoker = true) as
select t.owner_id,
       date_trunc('month', t.txn_date)::date as month,
       coalesce(c.name, 'Uncategorised') as category,
       c.is_essential,
       c.monthly_budget,
       -sum(t.amount) as spent
from public.transactions t
left join public.categories c on c.id = t.category_id
where t.amount < 0 and coalesce(c.kind,'expense') <> 'transfer'
group by t.owner_id, date_trunc('month', t.txn_date), c.name, c.is_essential, c.monthly_budget;

create or replace view public.v_debt_summary with (security_invoker = true) as
select d.owner_id,
       count(*) filter (where d.status = 'active') as active_debts,
       coalesce(sum(d.current_balance * d.my_share_pct / 100) filter (where d.status = 'active'), 0) as my_total_owed,
       coalesce(sum(d.arrears_amount * d.my_share_pct / 100) filter (where d.status = 'active'), 0) as my_total_arrears,
       coalesce(sum(public.to_monthly(coalesce(d.min_payment,0), coalesce(d.payment_frequency,'monthly')) * d.my_share_pct / 100)
                filter (where d.status = 'active'), 0) as my_monthly_minimums,
       count(*) filter (where d.status = 'active' and d.hardship_status = 'approved') as on_hardship,
       count(*) filter (where d.status = 'active' and d.hardship_status = 'to_request') as hardship_to_request
from public.debts d
group by d.owner_id;

-- Positive = ex-partner owes me; negative = I owe ex-partner
create or replace view public.v_shared_balance with (security_invoker = true) as
select s.owner_id,
       round(coalesce(sum(case
         when s.entry_type = 'expense' and s.paid_by = 'me'      then  s.total_amount * (100 - s.my_share_pct) / 100
         when s.entry_type = 'expense' and s.paid_by = 'partner' then -s.total_amount * s.my_share_pct / 100
         when s.entry_type = 'settlement' and s.paid_by = 'me'      then  s.total_amount
         when s.entry_type = 'settlement' and s.paid_by = 'partner' then -s.total_amount
       end), 0), 2) as balance,
       count(*) as entries,
       max(s.entry_date) as last_entry
from public.shared_ledger s
group by s.owner_id;

create or replace view public.v_monthly_commitments with (security_invoker = true) as
select ri.owner_id,
       round(coalesce(sum(public.to_monthly(ri.amount * ri.my_share_pct / 100, ri.frequency)) filter (where ri.direction = 'in'), 0), 2) as monthly_in,
       round(coalesce(sum(public.to_monthly(ri.amount * ri.my_share_pct / 100, ri.frequency)) filter (where ri.direction = 'out'), 0), 2) as monthly_out
from public.recurring_items ri
where ri.is_active
group by ri.owner_id;

grant execute on function public.import_transactions(uuid, jsonb, text, text) to authenticated;
grant execute on function public.seed_defaults() to authenticated;
grant execute on function public.recategorise_uncategorised() to authenticated;
grant execute on function public.upcoming_items(int) to authenticated;
revoke execute on function public.import_transactions(uuid, jsonb, text, text) from anon, public;
revoke execute on function public.seed_defaults() from anon, public;
revoke execute on function public.recategorise_uncategorised() from anon, public;
revoke execute on function public.upcoming_items(int) from anon, public;
revoke execute on function public.match_rule(uuid, text, numeric) from anon, public;
grant execute on function public.match_rule(uuid, text, numeric) to authenticated;
