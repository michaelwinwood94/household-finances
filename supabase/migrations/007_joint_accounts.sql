-- Joint / shared bank accounts (e.g. the CommBank account shared with ex-partner)
alter table public.accounts add column if not exists is_joint boolean not null default false;
alter table public.accounts add column if not exists my_share_pct numeric(5,2) not null default 100
  check (my_share_pct between 0 and 100);

create or replace view public.v_account_balances with (security_invoker = true) as
select a.id, a.owner_id, a.name, a.institution, a.account_type, a.nickname_last4, a.is_active,
       a.opening_balance + coalesce(sum(t.amount) filter (where t.txn_date >= a.opening_date), 0) as calculated_balance,
       (select t2.bank_balance from public.transactions t2
         where t2.account_id = a.id and t2.bank_balance is not null
         order by t2.txn_date desc, t2.created_at desc limit 1) as last_statement_balance,
       max(t.txn_date) as last_transaction_date,
       count(t.id) as transaction_count,
       a.is_joint,
       a.my_share_pct
from public.accounts a
left join public.transactions t on t.account_id = a.id
group by a.id;
