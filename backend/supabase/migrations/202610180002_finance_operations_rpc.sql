-- Atomic financial operations: an expense payment and a transfer either complete fully or roll back.
-- Run this migration in the Supabase SQL Editor after 202610180001_school_finance.sql.

create or replace function public.finance_pay_expense(p_expense_id uuid, p_account_id uuid)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_centre_id uuid;
  v_profile_centre_id uuid;
  v_role text;
  v_amount numeric(12,2);
  v_status text;
  v_account_type text;
  v_balance numeric(12,2);
  v_label text;
begin
  select p.centre_id, p.role into v_profile_centre_id, v_role
  from public.profiles p
  where p.id = auth.uid();

  if auth.uid() is null or coalesce(v_role, '') not in ('admin', 'director') or v_profile_centre_id is null then
    raise exception 'Accès refusé : directeur ou administrateur du centre requis.';
  end if;

  select e.centre_id, e.amount, e.status, e.label
    into v_centre_id, v_amount, v_status, v_label
  from public.finance_expenses e
  where e.id = p_expense_id
  for update;

  if not found or v_centre_id <> v_profile_centre_id then
    raise exception 'Dépense introuvable pour ce centre.';
  end if;
  if v_status not in ('pending', 'approved') then
    raise exception 'Cette dépense a déjà été traitée ou ne peut pas être payée.';
  end if;

  select a.account_type into v_account_type
  from public.finance_accounts a
  where a.id = p_account_id
    and a.centre_id = v_centre_id
    and a.active = true
  for update;

  if not found then
    raise exception 'Caisse ou compte bancaire introuvable ou inactif.';
  end if;

  select a.opening_balance + coalesce(sum(
           case
             when m.movement_type in ('inflow', 'transfer_in', 'adjustment') then m.amount
             else -m.amount
           end
         ), 0)
    into v_balance
  from public.finance_accounts a
  left join public.finance_account_movements m
    on m.account_id = a.id and m.centre_id = a.centre_id
  where a.id = p_account_id and a.centre_id = v_centre_id
  group by a.id, a.opening_balance;
  if v_balance < v_amount then
    raise exception 'Solde insuffisant pour payer cette dépense.';
  end if;

  insert into public.finance_account_movements (
    centre_id, account_id, movement_type, amount, movement_date,
    description, source_type, source_id, created_by
  ) values (
    v_centre_id, p_account_id, 'outflow', v_amount, now(),
    'Paiement dépense : ' || v_label, 'expense', p_expense_id, auth.uid()
  );

  update public.finance_expenses
  set status = 'paid',
      payment_method = case when v_account_type = 'cash' then 'cash' else 'bank_transfer' end,
      paid_at = now()
  where id = p_expense_id and centre_id = v_centre_id;
end;
$$;

create or replace function public.finance_transfer_accounts(
  p_source_account_id uuid,
  p_destination_account_id uuid,
  p_amount numeric,
  p_movement_date timestamptz default now()
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_centre_id uuid;
  v_profile_centre_id uuid;
  v_role text;
  v_source_balance numeric(12,2);
  v_source_name text;
  v_destination_name text;
  v_transfer_group_id uuid := gen_random_uuid();
begin
  select p.centre_id, p.role into v_profile_centre_id, v_role
  from public.profiles p
  where p.id = auth.uid();

  if auth.uid() is null or coalesce(v_role, '') not in ('admin', 'director') or v_profile_centre_id is null then
    raise exception 'Accès refusé : directeur ou administrateur du centre requis.';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Le montant du transfert doit être supérieur à zéro.';
  end if;
  if p_source_account_id = p_destination_account_id then
    raise exception 'Les comptes source et destinataire doivent être différents.';
  end if;

  -- Lock both account rows in a stable order to reduce concurrent transfer deadlocks.
  perform 1
  from public.finance_accounts a
  where a.id in (p_source_account_id, p_destination_account_id)
    and a.centre_id = v_profile_centre_id
    and a.active = true
  order by a.id
  for update;

  if (select count(*) from public.finance_accounts a
      where a.id in (p_source_account_id, p_destination_account_id)
        and a.centre_id = v_profile_centre_id and a.active = true) <> 2 then
    raise exception 'Les deux comptes doivent être actifs et appartenir au centre connecté.';
  end if;

  select a.name,
         a.opening_balance + coalesce(sum(
           case
             when m.movement_type in ('inflow', 'transfer_in', 'adjustment') then m.amount
             else -m.amount
           end
         ), 0)
    into v_source_name, v_source_balance
  from public.finance_accounts a
  left join public.finance_account_movements m
    on m.account_id = a.id and m.centre_id = a.centre_id
  where a.id = p_source_account_id and a.centre_id = v_profile_centre_id
  group by a.id, a.name, a.opening_balance;

  select a.name into v_destination_name
  from public.finance_accounts a
  where a.id = p_destination_account_id and a.centre_id = v_profile_centre_id;

  if v_source_balance < p_amount then
    raise exception 'Solde insuffisant sur le compte source.';
  end if;

  insert into public.finance_account_movements (
    centre_id, account_id, movement_type, amount, movement_date,
    description, transfer_group_id, source_type, created_by
  ) values
    (v_profile_centre_id, p_source_account_id, 'transfer_out', p_amount, coalesce(p_movement_date, now()),
     'Transfert vers ' || v_destination_name, v_transfer_group_id, 'transfer', auth.uid()),
    (v_profile_centre_id, p_destination_account_id, 'transfer_in', p_amount, coalesce(p_movement_date, now()),
     'Transfert depuis ' || v_source_name, v_transfer_group_id, 'transfer', auth.uid());

  return v_transfer_group_id;
end;
$$;

revoke all on function public.finance_pay_expense(uuid, uuid) from public;
revoke all on function public.finance_transfer_accounts(uuid, uuid, numeric, timestamptz) from public;
grant execute on function public.finance_pay_expense(uuid, uuid) to authenticated;
grant execute on function public.finance_transfer_accounts(uuid, uuid, numeric, timestamptz) to authenticated;
