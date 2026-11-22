-- Replace the broad "FEE" rule (it matched "COFFEE") with specific bank-fee wording
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
      ('ATM ','out','Cash out',false,50),
      ('ACCOUNT FEE','out','Bank fees',false,60),
      ('MONTHLY FEE','out','Bank fees',false,60),
      ('DISHONOUR','out','Bank fees',false,60),
      ('OVERDRAWN','out','Bank fees',false,60)
    ) as r(txt, dir, cat, shared, pri)
    join public.categories c on c.owner_id = v_owner and c.name = r.cat;
  end if;
end $$;
