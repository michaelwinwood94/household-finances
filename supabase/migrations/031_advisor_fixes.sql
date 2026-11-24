-- advisor fixes: faster RLS check, indexes on foreign keys, trigger-only function not callable via the API
drop policy "own rows" on public.debt_instalments;
create policy "own rows" on public.debt_instalments for all to public using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create index if not exists debt_instalments_category_id_idx on public.debt_instalments (category_id);
create index if not exists debt_instalments_matched_txn_id_idx on public.debt_instalments (matched_txn_id);
create index if not exists debt_instalments_prev_txn_category_id_idx on public.debt_instalments (prev_txn_category_id);
create index if not exists payslips_member_id_idx on public.payslips (member_id);
create index if not exists shop_categories_category_id_idx on public.shop_categories (category_id);
revoke execute on function public.members_changed() from public, anon, authenticated;
