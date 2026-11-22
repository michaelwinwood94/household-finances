-- Room-by-room floor areas for the ATO floor-area method: [{name, m2, use: boarders|shared|owners|excluded, note}]
alter table public.tax_years add column if not exists rooms jsonb not null default '[]'::jsonb;
