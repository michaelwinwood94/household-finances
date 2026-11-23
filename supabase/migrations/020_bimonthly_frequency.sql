-- 020: 'bimonthly' (every 2 months, e.g. Synergy) added to the frequency type; to_monthly() = amount / 2,
-- next_occurrence() = + 2 months.
alter type public.frequency add value if not exists 'bimonthly' after 'monthly';
