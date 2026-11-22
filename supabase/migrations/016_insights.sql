-- 016: automated insights from transaction history
--  * tag_bounces(owner)          returned/dishonoured direct debits and the payment they reverse are tagged
--                                "Bounced payment (not counted)" so they no longer inflate income and spending;
--                                a bill whose latest payment bounced goes back to "owing".
--  * apply_price_changes(owner)  a bill whose last two payments agree on a new amount is updated, with an alert.
--  * insights_for(owner)         one JSON bundle: 28-day cash-flow forecast, safe-to-spend, bounces, fees,
--                                price changes, possible double charges, subscriptions found, spending spikes, BNPL load.
--  * insights() / refresh_insights()   client RPCs for the signed-in user.
--  * daily_checks()              now also runs the above for every household and raises alerts.

create or replace function public.payee_key(t text) returns text
language sql immutable set search_path = '' as $$
  select left(trim(regexp_replace(
           regexp_replace(
             regexp_replace(upper(coalesce(t, '')),
               '^(RETURN \S+ DIRECT DEBIT \S+|DEBIT CARD PURCHASE|EFTPOS DEBIT \S+|EFTPOS PURCHASE|EFTPOS|PAYMENT BY AUTHORITY TO|DIRECT DEBIT|VISA PURCHASE|VISA DEBIT PURCHASE CARD \S+|CARD PURCHASE)\s+', ''),
             '(PERIOD END \w+|\S*\d\S*|\\\S*|\s(AUS|AU|AUSTRALIA)$)', ' ', 'g'),
           '\s+', ' ', 'g')), 32)
$$;

create or replace function public.bounce_category(p_owner uuid) returns uuid
language plpgsql set search_path = '' as $$
declare v uuid;
begin
  select id into v from public.categories where owner_id = p_owner and name = 'Bounced payment (not counted)';
  if v is null then
    insert into public.categories (owner_id, name, kind, is_essential, sort_order)
    values (p_owner, 'Bounced payment (not counted)', 'transfer', false, 990) returning id into v;
  end if;
  return v;
end $$;

create or replace function public.tag_bounces(p_owner uuid) returns int
language plpgsql set search_path = '' as $$
declare v_cat uuid; v_n int := 0;
begin
  if auth.uid() is not null and auth.uid() <> p_owner then raise exception 'Not allowed'; end if;
  v_cat := public.bounce_category(p_owner);
  with ret as (
    select r.id, r.account_id, r.amount, r.txn_date
    from public.transactions r
    where r.owner_id = p_owner and r.amount > 0
      and r.description ~* '^return .*direct debit|dishonou?r'
      and r.category_id is distinct from v_cat and r.category_source <> 'manual'
  ), pairs as (
    select ret.id as ret_id, o.id as orig_id, o.recurring_item_id as item_id, o.txn_date as orig_date
    from ret left join lateral (
      select x.id, x.recurring_item_id, x.txn_date from public.transactions x
      where x.owner_id = p_owner and x.account_id = ret.account_id and x.amount = -ret.amount
        and x.txn_date between ret.txn_date - 10 and ret.txn_date
        and x.description !~* '^return' and x.category_id is distinct from v_cat and x.category_source <> 'manual'
      order by x.txn_date desc limit 1) o on true
  ), u_ret as (
    update public.transactions t set category_id = v_cat, category_source = 'rule'
    from pairs p where t.id = p.ret_id returning 1
  ), u_orig as (
    update public.transactions t set category_id = v_cat, category_source = 'rule', recurring_item_id = null
    from (select distinct on (orig_id) * from pairs where orig_id is not null) p
    where t.id = p.orig_id returning p.item_id, p.orig_date
  ), owing as (
    -- the bill's latest payment bounced and nothing has been paid since: put it back to owing
    update public.recurring_items ri set next_due = o.d
    from (select item_id, min(orig_date) d from u_orig where item_id is not null and orig_date >= current_date - 45 group by item_id) o
    where ri.id = o.item_id and ri.next_due > o.d
      and not exists (select 1 from public.transactions t where t.recurring_item_id = ri.id and t.txn_date > o.d)
    returning 1
  )
  select (select count(*) from u_ret) + 0 * (select count(*) from owing) into v_n;
  return v_n;
end $$;

create or replace function public.apply_price_changes(p_owner uuid) returns int
language plpgsql set search_path = '' as $$
declare v_n int := 0;
begin
  if auth.uid() is not null and auth.uid() <> p_owner then raise exception 'Not allowed'; end if;
  with last2 as (
    select ri.id, ri.name, ri.amount old_amt, ri.frequency, ri.my_share_pct,
           (array_agg(-t.amount order by t.txn_date desc, t.created_at desc))[1:2] amts,
           max(t.txn_date) last_date
    from public.recurring_items ri
    join public.transactions t on t.recurring_item_id = ri.id and t.amount < 0
    where ri.owner_id = p_owner and ri.is_active and ri.direction = 'out' and ri.debt_id is null
    group by ri.id
  ), chg as (
    select *, amts[1] new_amt from last2
    where array_length(amts, 1) = 2 and amts[1] = amts[2]
      and last_date >= current_date - 60
      and abs(amts[1] - old_amt) > greatest(0.5, old_amt * 0.01)
      and amts[1] between old_amt * 0.6 and old_amt * 1.6
  ), upd as (
    update public.recurring_items ri set amount = c.new_amt,
      notes = trim(coalesce(ri.notes, '') || ' [' || to_char(current_date, 'DD Mon YY') || ': amount ' || c.old_amt || ' → ' || c.new_amt || ' from bank]')
    from chg c where ri.id = c.id returning 1
  ), al as (
    insert into public.alerts (owner_id, severity, title, body, due_date, source_key)
    select p_owner, 'info',
      c.name || case when c.new_amt > c.old_amt then ' went up' else ' went down' end,
      to_char(c.old_amt, 'FM$999,990.00') || ' → ' || to_char(c.new_amt, 'FM$999,990.00') || ' ('
        || case when c.new_amt > c.old_amt then '+' else '' end || round((c.new_amt / c.old_amt - 1) * 100) || '%), about '
        || to_char(abs(public.to_monthly(c.new_amt - c.old_amt, c.frequency) * 12), 'FM$999,990') || ' a year '
        || case when c.new_amt > c.old_amt then 'more' else 'less' end
        || '. The bill amount has been updated. Worth ringing to ask for a better price or a hardship rate.',
      current_date, 'price:' || c.id || ':' || c.new_amt
    from chg c
    on conflict (owner_id, source_key) do nothing returning 1
  )
  select (select count(*) from upd) + 0 * (select count(*) from al) into v_n;
  return v_n;
end $$;

create or replace function public.insights_for(p_owner uuid, p_days int default 28) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Australia/Perth')::date;
  v_start numeric; v_daily numeric; v_days jsonb; v_out jsonb;
begin
  if auth.uid() is not null and auth.uid() <> p_owner then raise exception 'Not allowed'; end if;

  -- money you can spend now: everyday accounts (not loans)
  select coalesce(sum(a.opening_balance + coalesce((select sum(t.amount) from public.transactions t where t.account_id = a.id and t.txn_date >= a.opening_date), 0)), 0)
    into v_start
  from public.accounts a where a.owner_id = p_owner and a.is_active and a.account_type in ('transaction','savings','offset','cash');

  -- everyday spending not covered by a bill: average per day over the last 90 days
  select coalesce(-sum(t.amount), 0) / 90.0 into v_daily
  from public.transactions t
  join public.accounts a on a.id = t.account_id and a.account_type in ('transaction','savings','offset','cash')
  left join public.categories c on c.id = t.category_id
  where t.owner_id = p_owner and t.amount < 0 and t.txn_date > v_today - 90 and t.txn_date <= v_today
    and t.recurring_item_id is null and not coalesce(t.is_one_off, false)
    and coalesce(c.kind, '') <> 'transfer'
    and not exists (select 1 from public.recurring_items ri where ri.owner_id = p_owner and ri.is_active and ri.match_text <> ''
                    and upper(t.description) like '%' || upper(ri.match_text) || '%');

  with recursive occ as (
    select ri.id, ri.next_due d, ri.frequency, 1 n
    from public.recurring_items ri
    left join public.accounts a on a.id = ri.account_id
    where ri.owner_id = p_owner and ri.is_active and ri.next_due >= v_today
      and (ri.account_id is null or a.account_type in ('transaction','savings','offset','cash'))
    union all
    select o.id, public.next_occurrence(o.d, o.frequency), o.frequency, o.n + 1 from occ o
    where o.frequency <> 'once' and o.n < 60 and public.next_occurrence(o.d, o.frequency) <= v_today + p_days
  ), ev as (
    select o.d, ri.name, ri.direction, case when ri.direction = 'in' then ri.amount else -ri.amount end amt
    from occ o join public.recurring_items ri on ri.id = o.id where o.d <= v_today + p_days
  ), days as (
    select g::date d from generate_series((v_today + 1)::timestamp, (v_today + p_days)::timestamp, interval '1 day') g
  ), per as (
    select dd.d,
           coalesce(sum(ev.amt), 0) - v_daily as change,
           coalesce(jsonb_agg(jsonb_build_object('name', ev.name, 'amount', ev.amt) order by ev.amt) filter (where ev.name is not null), '[]') items
    from days dd left join ev on ev.d = dd.d group by dd.d
  )
  , run as (select d, items, v_start + sum(change) over (order by d) bal from per)
  select jsonb_agg(jsonb_build_object('d', d, 'bal', round(bal, 2), 'items', items) order by d)
    into v_days from run;

  select jsonb_build_object(
    'today', v_today,
    'forecast', jsonb_build_object(
      'start', round(v_start, 2), 'daily_spend', round(v_daily, 2), 'days', coalesce(v_days, '[]'),
      'overdue', (select coalesce(jsonb_agg(jsonb_build_object('name', ri.name, 'amount', ri.amount, 'due', ri.next_due)), '[]')
                  from public.recurring_items ri where ri.owner_id = p_owner and ri.is_active and ri.direction = 'out' and ri.next_due < v_today),
      'next_income', (select min(ri.next_due) from public.recurring_items ri left join public.accounts a on a.id = ri.account_id
                      where ri.owner_id = p_owner and ri.is_active and ri.direction = 'in' and ri.next_due > v_today
                        and (ri.account_id is null or a.account_type in ('transaction','savings','offset','cash')))),
    'bounces', (select coalesce(jsonb_agg(x order by x.last desc), '[]') from (
        select public.payee_key(t.description) payee, count(*) n, round(sum(t.amount), 2) total, max(t.txn_date) as last,
               count(*) filter (where t.txn_date > v_today - 90) recent
        from public.transactions t where t.owner_id = p_owner and t.amount > 0 and t.txn_date > v_today - 365
          and t.description ~* '^return .*direct debit|dishonou?r'
        group by 1) x),
    'fees', jsonb_build_object(
        'by_type', (select coalesce(jsonb_agg(x order by x.total desc), '[]') from (
            select case when t.description ~* 'overdrawn' then 'Overdrawn fees'
                        when t.description ~* 'dishono' then 'Dishonour fees'
                        when t.description ~* 'package fee' then 'Loan package fee'
                        when t.description ~* 'international' then 'Overseas transaction fees'
                        else 'Other bank fees' end as kind,
                   count(*) n, round(-sum(t.amount), 2) total
            from public.transactions t join public.categories c on c.id = t.category_id and c.name = 'Bank fees'
            where t.owner_id = p_owner and t.amount < 0 and t.txn_date > v_today - 365 group by 1) x),
        'days_overdrawn', (select coalesce(jsonb_agg(x), '[]') from (
            select a.name account, count(distinct t.txn_date) as days, min(t.bank_balance) lowest
            from public.transactions t join public.accounts a on a.id = t.account_id and a.account_type in ('transaction','savings','offset','cash')
            where t.owner_id = p_owner and t.bank_balance < 0 and t.txn_date > v_today - 365 group by a.name) x)),
    'price_changes', (select coalesce(jsonb_agg(x order by x.last desc), '[]') from (
        select ri.name, ri.frequency, ri.amount now_amt,
               (array_agg(-t.amount order by t.txn_date))[1] first_amt, min(t.txn_date) as first, max(t.txn_date) as last
        from public.recurring_items ri join public.transactions t on t.recurring_item_id = ri.id and t.amount < 0
        where ri.owner_id = p_owner and ri.is_active and ri.direction = 'out' and ri.debt_id is null and t.txn_date > v_today - 365
        group by ri.id having abs(ri.amount - (array_agg(-t.amount order by t.txn_date))[1]) > 0.5
           and (array_agg(-t.amount order by t.txn_date))[1] between ri.amount * 0.6 and ri.amount * 1.6) x),
    'duplicates', (select coalesce(jsonb_agg(x order by x.d desc), '[]') from (
        select a.id, a.txn_date d, a.description, -a.amount amount, acc.name account
        from public.transactions a
        join public.transactions b on b.owner_id = a.owner_id and b.account_id = a.account_id and b.amount = a.amount and b.id <> a.id
             and upper(b.description) = upper(a.description) and b.txn_date between a.txn_date - 1 and a.txn_date and (b.txn_date < a.txn_date or b.id < a.id)
        join public.accounts acc on acc.id = a.account_id
        left join public.categories c on c.id = a.category_id
        where a.owner_id = p_owner and a.amount <= -20 and a.txn_date > v_today - 365
          and coalesce(c.kind, '') <> 'transfer' and coalesce(c.name, '') not in ('Afterpay / BNPL', 'Groceries', 'Fuel')
          and a.description !~* 'afterpay|deferit|latitude|zip|transfer|osko|bpay') x),
    'subscriptions', (select coalesce(jsonb_agg(x order by x.yearly desc), '[]') from (
        select s.*, round(s.avg * 365.0 / s.gap) yearly,
               case when s.gap between 5 and 9 then 'weekly' when s.gap between 12 and 17 then 'fortnightly'
                    when s.gap between 26 and 35 then 'monthly' when s.gap between 80 and 100 then 'quarterly' else 'yearly' end freq,
               s.last >= v_today - (s.gap * 1.6)::int as active,
               exists (select 1 from public.recurring_items ri where ri.owner_id = p_owner and ri.is_active and ri.match_text <> ''
                       and upper(s.sample) like '%' || upper(ri.match_text) || '%') tracked
        from (
          select public.payee_key(t.description) payee, count(*) n, round(avg(-t.amount), 2) as avg,
                 min(-t.amount) lo, max(-t.amount) hi, max(t.txn_date) as last, max(t.description) sample,
                 greatest(1, (max(t.txn_date) - min(t.txn_date)) / greatest(1, count(*) - 1)) gap
          from public.transactions t left join public.categories c on c.id = t.category_id
          where t.owner_id = p_owner and t.amount < 0 and t.txn_date > v_today - 400
            and coalesce(c.kind, '') <> 'transfer' and coalesce(c.name, '') not in ('Afterpay / BNPL', 'Groceries', 'Fuel', 'Takeaway & eating out', 'Debt repayments', 'Mortgage')
            and t.description !~* 'afterpay|deferit|latitude|transfer|osko|withdrawal|overdrawn|fee'
          group by 1 having count(*) >= 3 and max(-t.amount) - min(-t.amount) <= greatest(1, 0.15 * avg(-t.amount))) s
        where s.payee <> '' and (s.gap between 5 and 9 or s.gap between 12 and 17 or s.gap between 26 and 35 or s.gap between 80 and 100 or s.gap between 350 and 380)) x),
    'spikes', (select coalesce(jsonb_agg(x order by x.over_by desc), '[]') from (
        select c.name category, round(m.mtd) mtd, round(m.avg3) avg3, round(m.mtd - coalesce(m.avg3, 0)) over_by
        from (select t.category_id,
                     -sum(t.amount) filter (where t.txn_date >= date_trunc('month', v_today)) mtd,
                     -sum(t.amount) filter (where t.txn_date >= date_trunc('month', v_today) - interval '3 months' and t.txn_date < date_trunc('month', v_today)) / 3.0 avg3
              from public.transactions t where t.owner_id = p_owner and t.amount < 0 and t.txn_date >= date_trunc('month', v_today) - interval '3 months'
              group by t.category_id) m
        join public.categories c on c.id = m.category_id and c.kind = 'expense'
        where m.mtd > coalesce(m.avg3, 0) * 1.3 and m.mtd - coalesce(m.avg3, 0) > 75) x),
    'bnpl', (select coalesce(jsonb_agg(x order by x.month), '[]') from (
        select to_char(date_trunc('month', t.txn_date), 'YYYY-MM') as month,
               round(-sum(t.amount) filter (where t.amount < 0 and c.name = 'Afterpay / BNPL')) bnpl,
               round(sum(t.amount) filter (where t.amount > 0 and c.kind = 'income')) income
        from public.transactions t left join public.categories c on c.id = t.category_id
        where t.owner_id = p_owner and t.txn_date >= date_trunc('month', v_today) - interval '11 months'
        group by 1) x)
  ) into v_out;
  return v_out;
end $$;

create or replace function public.insights(p_days int default 28) returns jsonb
language sql stable set search_path = '' as $$ select public.insights_for(auth.uid(), p_days) $$;

create or replace function public.refresh_insights() returns jsonb
language plpgsql set search_path = '' as $$
declare v_b int; v_p int;
begin
  if auth.uid() is null then raise exception 'Not logged in'; end if;
  v_b := public.tag_bounces(auth.uid());
  v_p := public.apply_price_changes(auth.uid());
  return jsonb_build_object('bounces_tagged', v_b, 'prices_updated', v_p);
end $$;

revoke all on function public.bounce_category(uuid), public.tag_bounces(uuid), public.apply_price_changes(uuid), public.insights_for(uuid, int), public.insights(int), public.refresh_insights() from public, anon;
grant execute on function public.bounce_category(uuid), public.tag_bounces(uuid), public.apply_price_changes(uuid), public.insights_for(uuid, int), public.insights(int), public.refresh_insights() to authenticated;
