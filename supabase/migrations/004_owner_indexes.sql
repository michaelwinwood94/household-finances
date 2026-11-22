-- Speed up the per-user security checks (RLS filters every query by owner_id)
create index if not exists accounts_owner_idx on public.accounts (owner_id);
create index if not exists category_rules_owner_idx on public.category_rules (owner_id, priority);
create index if not exists debt_contacts_owner_idx on public.debt_contacts (owner_id, follow_up_date);
create index if not exists debts_owner_idx on public.debts (owner_id);
create index if not exists goals_owner_idx on public.goals (owner_id);
create index if not exists import_batches_owner_idx on public.import_batches (owner_id, created_at desc);
create index if not exists recurring_items_owner_idx on public.recurring_items (owner_id, next_due);
create index if not exists shared_ledger_owner_idx on public.shared_ledger (owner_id, entry_date desc);
