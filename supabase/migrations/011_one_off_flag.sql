-- Mark a transaction as a one-off (categorised by hand, no rule) and speed up the "To sort" list
alter table public.transactions add column if not exists is_one_off boolean not null default false;
create index if not exists transactions_uncat_idx on public.transactions (owner_id) where category_id is null;
