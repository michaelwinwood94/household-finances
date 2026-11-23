-- 021: settings.report jsonb — saved answers for the financial report (reason for hardship, what you're asking for, assets, costs paid another way)
alter table public.settings add column if not exists report jsonb not null default '{}'::jsonb;
