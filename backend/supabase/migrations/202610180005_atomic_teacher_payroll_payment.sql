-- SchoolPlans finance v5: atomic teacher payroll payment and strict director-only audit access.
-- Apply after 202610180004_payroll_business_rules.sql.

-- Remove legacy policies first: PostgreSQL combines permissive policies with OR,
-- so leaving an old admin-write policy would defeat the director-only rule.
do $$
declare
  t text;
  existing_policy record;
begin
  foreach t in array array[
    'finance_student_charges','finance_payments','finance_expenses',
    'finance_accounts','finance_account_movements','finance_teacher_payroll',
    'finance_teacher_advances','finance_teacher_advance_repayments',
    'finance_teacher_rates','finance_teacher_payroll_adjustments'
  ] loop
    for existing_policy in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy %I on public.%I', existing_policy.policyname, t);
    end loop;

    execute format(
      'create policy %I on public.%I for all to authenticated using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.centre_id = %I.centre_id and lower(p.role) in (''director'', ''directeur''))) with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.centre_id = %I.centre_id and lower(p.role) in (''director'', ''directeur'')))',
      t || '_director_all', t, t, t
    );
    execute format(
      'create policy %I on public.%I for select to authenticated using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.centre_id = %I.centre_id and lower(p.role) = ''admin''))',
      t || '_admin_read', t, t
    );
  end loop;

  for existing_policy in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'finance_audit_log'
  loop
    execute format('drop policy %I on public.finance_audit_log', existing_policy.policyname);
  end loop;
end $$;

create policy finance_audit_log_director_read on public.finance_audit_log
for select to authenticated using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.centre_id = finance_audit_log.centre_id
      and lower(p.role) in ('director', 'directeur')
  )
);

create policy finance_audit_log_director_insert on public.finance_audit_log
for insert to authenticated with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.centre_id = finance_audit_log.centre_id
      and lower(p.role) in ('director', 'directeur')
  )
);

-- Pay a validated payroll and create its cash/bank outflow in one transaction.
-- If any validation fails, both the payroll status and the movement remain unchanged.
create or replace function public.finance_pay_teacher_payroll(
  p_payroll_id uuid,
  p_account_id uuid,
  p_paid_at timestamptz,
  p_payment_method text,
  p_payment_reference text default null
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_centre_id uuid;
  v_profile_centre_id uuid;
  v_role text;
  v_teacher_id bigint;
  v_amount numeric(12,2);
  v_status text;
  v_account_type text;
  v_account_name text;
  v_balance numeric(12,2);
begin
  select p.centre_id, lower(p.role)
    into v_profile_centre_id, v_role
  from public.profiles p
  where p.id = auth.uid();

  if auth.uid() is null or v_role not in ('director', 'directeur') or v_profile_centre_id is null then
    raise exception 'Accès refusé : directeur du centre requis.';
  end if;

  if p_payment_method is null or p_payment_method not in ('cash','bank_transfer','card','cheque','other') then
    raise exception 'Mode de paiement invalide.';
  end if;

  select pr.centre_id, pr.teacher_id, pr.amount_due, pr.status
    into v_centre_id, v_teacher_id, v_amount, v_status
  from public.finance_teacher_payroll pr
  where pr.id = p_payroll_id
  for update;

  if not found or v_centre_id <> v_profile_centre_id then
    raise exception 'Rémunération introuvable pour ce centre.';
  end if;
  if v_status <> 'approved' then
    raise exception 'Seule une rémunération validée peut être payée.';
  end if;
  if v_amount <= 0 then
    raise exception 'Le montant à payer doit être supérieur à zéro.';
  end if;

  select a.account_type, a.name
    into v_account_type, v_account_name
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
      when m.movement_type in ('inflow','transfer_in','adjustment') then m.amount
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
    raise exception 'Solde insuffisant sur « % » : disponible % DH, nécessaire % DH.',
      v_account_name, v_balance, v_amount;
  end if;

  insert into public.finance_account_movements (
    centre_id, account_id, movement_type, amount, movement_date,
    description, source_type, source_id, created_by
  ) values (
    v_centre_id, p_account_id, 'outflow', v_amount,
    coalesce(p_paid_at, now()),
    'Rémunération formateur : ' || v_teacher_id || ' (' || p_payment_method || ')',
    'teacher_payroll', p_payroll_id, auth.uid()
  );

  update public.finance_teacher_payroll
  set status = 'paid',
      paid_at = coalesce(p_paid_at, now()),
      payment_method = p_payment_method,
      payment_reference = nullif(trim(coalesce(p_payment_reference, '')), '')
  where id = p_payroll_id
    and centre_id = v_centre_id
    and status = 'approved';

  if not found then
    raise exception 'La rémunération a changé de statut pendant le paiement.';
  end if;
end;
$$;

revoke all on function public.finance_pay_teacher_payroll(uuid, uuid, timestamptz, text, text) from public;
grant execute on function public.finance_pay_teacher_payroll(uuid, uuid, timestamptz, text, text) to authenticated;
