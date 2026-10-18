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

drop policy if exists finance_teacher_payroll_trainer_read on public.finance_teacher_payroll;
create policy finance_teacher_payroll_trainer_read on public.finance_teacher_payroll
for select to authenticated using (
  exists (
    select 1 from public.formateurs f
    where f.id = finance_teacher_payroll.teacher_id
      and f.centre_id = finance_teacher_payroll.centre_id
      and f.profile_id = auth.uid()
  )
);

drop policy if exists finance_teacher_rates_trainer_read on public.finance_teacher_rates;
create policy finance_teacher_rates_trainer_read on public.finance_teacher_rates
for select to authenticated using (
  exists (
    select 1 from public.formateurs f
    where f.id = finance_teacher_rates.teacher_id
      and f.centre_id = finance_teacher_rates.centre_id
      and f.profile_id = auth.uid()
  )
);

drop policy if exists finance_teacher_payroll_adjustments_trainer_read on public.finance_teacher_payroll_adjustments;
create policy finance_teacher_payroll_adjustments_trainer_read on public.finance_teacher_payroll_adjustments
for select to authenticated using (
  status = 'paid'
  and exists (
    select 1 from public.formateurs f
    where f.id = finance_teacher_payroll_adjustments.teacher_id
      and f.centre_id = finance_teacher_payroll_adjustments.centre_id
      and f.profile_id = auth.uid()
  )
);

create policy finance_audit_log_director_read on public.finance_audit_log
for select to authenticated using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.centre_id = finance_audit_log.centre_id
      and lower(p.role) in ('director', 'directeur')
  )
);

revoke insert on public.finance_audit_log from authenticated;

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
  p_amount numeric,
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
  if p_amount is null or abs(p_amount - v_amount) > 0.001 then
    raise exception 'Le montant saisi ne correspond plus au net à payer. Rechargez la rémunération avant de confirmer.';
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
  if p_payment_method = 'cash' and v_account_type <> 'cash' then
    raise exception 'Pour un paiement en espèces, sélectionnez une caisse.';
  end if;
  if p_payment_method in ('bank_transfer','card','cheque') and v_account_type <> 'bank' then
    raise exception 'Pour ce mode de paiement, sélectionnez un compte bancaire.';
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
      payment_reference = nullif(trim(coalesce(p_payment_reference, '')), ''),
      payment_reversed_at = null,
      payment_reversal_reason = null,
      payment_reversed_by = null
  where id = p_payroll_id
    and centre_id = v_centre_id
    and status = 'approved';

  if not found then
    raise exception 'La rémunération a changé de statut pendant le paiement.';
  end if;
end;
$$;

revoke all on function public.finance_pay_teacher_payroll(uuid, uuid, numeric, timestamptz, text, text) from public;
grant execute on function public.finance_pay_teacher_payroll(uuid, uuid, numeric, timestamptz, text, text) to authenticated;
revoke all on function public.finance_reverse_teacher_payroll_payment(uuid, text) from public;
grant execute on function public.finance_reverse_teacher_payroll_payment(uuid, text) to authenticated;

alter table public.finance_teacher_rates
  add column if not exists allow_advance_deduction boolean not null default false;

create unique index if not exists finance_teacher_rates_teacher_effective_uq
  on public.finance_teacher_rates (centre_id, teacher_id, effective_from);

alter table public.finance_teacher_advances
  add column if not exists account_id uuid references public.finance_accounts(id) on delete set null,
  add column if not exists payment_method text,
  add column if not exists payment_reference text;

-- Keep a traceable reversal when a payroll payment was recorded by mistake.
alter table public.finance_teacher_payroll
  add column if not exists payment_reversed_at timestamptz,
  add column if not exists payment_reversal_reason text,
  add column if not exists payment_reversed_by uuid references auth.users(id) on delete set null,
  add column if not exists session_breakdown jsonb not null default '[]'::jsonb;

create or replace function public.finance_capture_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_centre_id uuid;
  v_entity_id text;
  v_reason text;
begin
  v_centre_id := coalesce((to_jsonb(new)->>'centre_id')::uuid, (to_jsonb(old)->>'centre_id')::uuid);
  v_entity_id := coalesce(to_jsonb(new)->>'id', to_jsonb(old)->>'id');
  v_reason := coalesce(
    to_jsonb(new)->>'payment_reversal_reason',
    to_jsonb(new)->>'cancellation_reason',
    to_jsonb(new)->>'reason',
    to_jsonb(old)->>'reason',
    to_jsonb(new)->>'notes',
    to_jsonb(old)->>'notes'
  );
  insert into public.finance_audit_log (
    centre_id, entity_table, entity_id, operation, old_value, new_value, reason, actor_id
  ) values (
    v_centre_id, tg_table_name, v_entity_id, tg_op,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end,
    v_reason, auth.uid()
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.finance_reverse_teacher_payroll_payment(
  p_payroll_id uuid,
  p_reason text
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
  v_status text;
  v_movement_id uuid;
  v_account_id uuid;
  v_amount numeric(12,2);
begin
  select p.centre_id, lower(p.role)
    into v_profile_centre_id, v_role
  from public.profiles p where p.id = auth.uid();

  if auth.uid() is null or v_role not in ('director','directeur') or v_profile_centre_id is null then
    raise exception 'Accès refusé : directeur du centre requis.';
  end if;
  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'Un motif détaillé est obligatoire pour annuler le paiement.';
  end if;

  select pr.centre_id, pr.teacher_id, pr.status
    into v_centre_id, v_teacher_id, v_status
  from public.finance_teacher_payroll pr
  where pr.id = p_payroll_id
  for update;

  if not found or v_centre_id <> v_profile_centre_id then
    raise exception 'Rémunération introuvable pour ce centre.';
  end if;
  if v_status <> 'paid' then
    raise exception 'Seul un paiement enregistré peut être annulé.';
  end if;

  select m.id, m.account_id, m.amount
    into v_movement_id, v_account_id, v_amount
  from public.finance_account_movements m
  where m.centre_id = v_centre_id
    and m.source_type = 'teacher_payroll'
    and m.source_id = p_payroll_id
    and m.movement_type = 'outflow'
    and not exists (
      select 1 from public.finance_account_movements rev
      where rev.centre_id = m.centre_id
        and rev.source_type = 'teacher_payroll_reversal'
        and rev.source_id = m.id
        and rev.movement_type = 'inflow'
    )
  order by m.movement_date desc, m.created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Aucun décaissement actif trouvé pour cette rémunération.';
  end if;

  insert into public.finance_account_movements (
    centre_id, account_id, movement_type, amount, movement_date,
    description, source_type, source_id, created_by
  ) values (
    v_centre_id, v_account_id, 'inflow', v_amount, now(),
    'Annulation paiement rémunération formateur ' || v_teacher_id || ' : ' || trim(p_reason),
    'teacher_payroll_reversal', v_movement_id, auth.uid()
  );

  update public.finance_teacher_payroll
  set status = 'approved',
      payment_reversed_at = now(),
      payment_reversal_reason = trim(p_reason),
      payment_reversed_by = auth.uid()
  where id = p_payroll_id and centre_id = v_centre_id and status = 'paid';

  if not found then
    raise exception 'La rémunération a changé de statut pendant l’annulation.';
  end if;
end;
$$;

-- Snapshot the planned session duration at first submission so later timetable edits do not rewrite payroll history.
alter table public.seances_realisees
  add column if not exists planned_minutes integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'seances_realisees_planned_minutes_check') then
    alter table public.seances_realisees
      add constraint seances_realisees_planned_minutes_check
      check (planned_minutes is null or planned_minutes >= 0);
  end if;
end $$;

create or replace function public.finance_snapshot_planned_session_duration()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_minutes integer;
begin
  if tg_op = 'INSERT' or new.cours_id is distinct from old.cours_id or new.date is distinct from old.date then
    select greatest(0, round(extract(epoch from (c.fin - c.debut)) / 60)::integer)
      into v_minutes
    from public.cours c
    where c.id = new.cours_id and c.centre_id = new.centre_id;
    if not found or v_minutes is null or v_minutes <= 0 then
      raise exception 'Durée planifiée introuvable pour cette séance.';
    end if;
    new.planned_minutes := v_minutes;
  end if;
  return new;
end;
$$;

drop trigger if exists seances_realisees_snapshot_duration on public.seances_realisees;
create trigger seances_realisees_snapshot_duration
before insert or update on public.seances_realisees
for each row execute function public.finance_snapshot_planned_session_duration();

-- Session completion workflow: trainers submit; only the director validates.
alter table public.seances_realisees
  add column if not exists validation_status text not null default 'approved',
  add column if not exists submitted_by uuid references auth.users(id) on delete set null,
  add column if not exists submitted_at timestamptz not null default now(),
  add column if not exists validated_by uuid references auth.users(id) on delete set null,
  add column if not exists validated_at timestamptz,
  add column if not exists rejection_reason text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'seances_realisees_validation_status_check') then
    alter table public.seances_realisees
      add constraint seances_realisees_validation_status_check
      check (validation_status in ('pending','approved','rejected'));
  end if;
end $$;

alter table public.seances_realisees alter column submitted_by set default auth.uid();

alter table public.seances_realisees enable row level security;

-- Drop legacy policies first so a permissive older policy cannot allow trainers to validate themselves.
do $$
declare
  existing_policy record;
begin
  for existing_policy in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'seances_realisees'
      and cmd <> 'SELECT'
  loop
    execute format('drop policy %I on public.seances_realisees', existing_policy.policyname);
  end loop;
end $$;

drop policy if exists seances_realisees_director_all on public.seances_realisees;
drop policy if exists seances_realisees_admin_read on public.seances_realisees;
drop policy if exists seances_realisees_trainer_read on public.seances_realisees;
drop policy if exists seances_realisees_trainer_insert on public.seances_realisees;
drop policy if exists seances_realisees_trainer_resubmit on public.seances_realisees;

-- Existing SELECT policies (for example, students viewing their own timetable) are preserved.

create policy seances_realisees_director_all on public.seances_realisees
for all to authenticated
using (
  exists (select 1 from public.profiles p
    where p.id = auth.uid() and p.centre_id = seances_realisees.centre_id
      and lower(p.role) in ('director','directeur'))
)
with check (
  exists (select 1 from public.profiles p
    where p.id = auth.uid() and p.centre_id = seances_realisees.centre_id
      and lower(p.role) in ('director','directeur'))
);

create policy seances_realisees_admin_read on public.seances_realisees
for select to authenticated
using (
  exists (select 1 from public.profiles p
    where p.id = auth.uid() and p.centre_id = seances_realisees.centre_id
      and lower(p.role) = 'admin')
);

create policy seances_realisees_trainer_read on public.seances_realisees
for select to authenticated
using (
  exists (
    select 1 from public.cours c
    join public.formateurs f on f.id = c.formateur_id and f.centre_id = c.centre_id
    where c.id = seances_realisees.cours_id
      and c.centre_id = seances_realisees.centre_id
      and f.profile_id = auth.uid()
  )
);

create policy seances_realisees_trainer_insert on public.seances_realisees
for insert to authenticated
with check (
  validation_status = 'pending'
  and submitted_by = auth.uid()
  and validated_by is null
  and validated_at is null
  and rejection_reason is null
  and exists (
    select 1 from public.cours c
    join public.formateurs f on f.id = c.formateur_id and f.centre_id = c.centre_id
    where c.id = seances_realisees.cours_id
      and c.centre_id = seances_realisees.centre_id
      and f.profile_id = auth.uid()
  )
);

create policy seances_realisees_trainer_resubmit on public.seances_realisees
for update to authenticated
using (
  validation_status in ('pending','rejected')
  and submitted_by = auth.uid()
  and exists (
    select 1 from public.cours c
    join public.formateurs f on f.id = c.formateur_id and f.centre_id = c.centre_id
    where c.id = seances_realisees.cours_id
      and c.centre_id = seances_realisees.centre_id
      and f.profile_id = auth.uid()
  )
)
with check (
  validation_status = 'pending'
  and submitted_by = auth.uid()
  and validated_by is null
  and validated_at is null
  and rejection_reason is null
  and exists (
    select 1 from public.cours c
    join public.formateurs f on f.id = c.formateur_id and f.centre_id = c.centre_id
    where c.id = seances_realisees.cours_id
      and c.centre_id = seances_realisees.centre_id
      and f.profile_id = auth.uid()
  )
);

grant select, insert, update on public.seances_realisees to authenticated;
revoke delete on public.seances_realisees from authenticated;

create or replace function public.finance_capture_session_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row jsonb;
  v_old jsonb;
  v_new jsonb;
  v_centre_id uuid;
  v_entity_id text;
  v_reason text;
begin
  v_old := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end;
  v_new := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end;
  v_row := coalesce(v_new, v_old);
  v_centre_id := (v_row->>'centre_id')::uuid;
  v_entity_id := coalesce(v_row->>'cours_id','') || '|' || coalesce(v_row->>'date','');
  v_reason := coalesce(v_new->>'rejection_reason', v_old->>'rejection_reason');

  insert into public.finance_audit_log (
    centre_id, entity_table, entity_id, operation, old_value, new_value, reason, actor_id
  ) values (
    v_centre_id, 'seances_realisees', v_entity_id, tg_op, v_old, v_new, v_reason, auth.uid()
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists seances_realisees_finance_audit on public.seances_realisees;
create trigger seances_realisees_finance_audit
after insert or update on public.seances_realisees
for each row execute function public.finance_capture_session_audit();


-- Pay an approved exceptional/correction adjustment and record the treasury outflow atomically.
create or replace function public.finance_pay_teacher_adjustment(
  p_adjustment_id uuid,
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
  from public.profiles p where p.id = auth.uid();

  if auth.uid() is null or v_role not in ('director','directeur') or v_profile_centre_id is null then
    raise exception 'Accès refusé : directeur du centre requis.';
  end if;
  if p_payment_method is null or p_payment_method not in ('cash','bank_transfer','card','cheque','other') then
    raise exception 'Mode de paiement invalide.';
  end if;

  select a.centre_id, a.teacher_id, a.amount, a.status
    into v_centre_id, v_teacher_id, v_amount, v_status
  from public.finance_teacher_payroll_adjustments a
  where a.id = p_adjustment_id
  for update;

  if not found or v_centre_id <> v_profile_centre_id then
    raise exception 'Ajustement introuvable pour ce centre.';
  end if;
  if v_status <> 'approved' then
    raise exception 'Seul un ajustement validé peut être payé.';
  end if;
  if v_amount <= 0 then
    raise exception 'Le montant de l’ajustement doit être positif.';
  end if;

  select a.account_type, a.name
    into v_account_type, v_account_name
  from public.finance_accounts a
  where a.id = p_account_id and a.centre_id = v_centre_id and a.active = true
  for update;
  if not found then raise exception 'Caisse ou compte bancaire introuvable ou inactif.'; end if;
  if p_payment_method = 'cash' and v_account_type <> 'cash' then
    raise exception 'Pour un paiement en espèces, sélectionnez une caisse.';
  end if;
  if p_payment_method in ('bank_transfer','card','cheque') and v_account_type <> 'bank' then
    raise exception 'Pour ce mode de paiement, sélectionnez un compte bancaire.';
  end if;

  select a.opening_balance + coalesce(sum(
    case when m.movement_type in ('inflow','transfer_in','adjustment') then m.amount else -m.amount end
  ),0)
    into v_balance
  from public.finance_accounts a
  left join public.finance_account_movements m
    on m.account_id = a.id and m.centre_id = a.centre_id
  where a.id = p_account_id and a.centre_id = v_centre_id
  group by a.id, a.opening_balance;

  if v_balance < v_amount then
    raise exception 'Solde insuffisant sur « % » : disponible % DH, nécessaire % DH.', v_account_name, v_balance, v_amount;
  end if;

  insert into public.finance_account_movements (
    centre_id, account_id, movement_type, amount, movement_date,
    description, source_type, source_id, created_by
  ) values (
    v_centre_id, p_account_id, 'outflow', v_amount, coalesce(p_paid_at, now()),
    'Ajustement rémunération formateur ' || v_teacher_id || ' — ' || p_adjustment_id,
    'teacher_payroll_adjustment', p_adjustment_id, auth.uid()
  );

  update public.finance_teacher_payroll_adjustments
  set status = 'paid',
      paid_at = coalesce(p_paid_at, now()),
      payment_method = p_payment_method,
      payment_reference = nullif(trim(coalesce(p_payment_reference, '')), '')
  where id = p_adjustment_id and centre_id = v_centre_id and status = 'approved';
  if not found then raise exception 'L’ajustement a changé de statut pendant le paiement.'; end if;
end;
$$;

revoke all on function public.finance_pay_teacher_adjustment(uuid, uuid, timestamptz, text, text) from public;
grant execute on function public.finance_pay_teacher_adjustment(uuid, uuid, timestamptz, text, text) to authenticated;


-- Record a trainer advance and its treasury outflow atomically.
create or replace function public.finance_create_teacher_advance(
  p_teacher_id bigint,
  p_amount numeric,
  p_advance_date date,
  p_notes text,
  p_account_id uuid,
  p_payment_method text,
  p_payment_reference text default null
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
  v_account_type text;
  v_account_name text;
  v_balance numeric(12,2);
  v_advance_id uuid;
begin
  select p.centre_id, lower(p.role)
    into v_profile_centre_id, v_role
  from public.profiles p where p.id = auth.uid();

  if auth.uid() is null or v_role not in ('director','directeur') or v_profile_centre_id is null then
    raise exception 'Accès refusé : directeur du centre requis.';
  end if;
  if p_amount is null or p_amount <= 0 or p_advance_date is null then
    raise exception 'Saisissez un montant positif et une date valide.';
  end if;
  if p_payment_method is null or p_payment_method not in ('cash','bank_transfer','card','cheque','other') then
    raise exception 'Mode de paiement invalide.';
  end if;
  if not exists (select 1 from public.formateurs f where f.id = p_teacher_id and f.centre_id = v_profile_centre_id) then
    raise exception 'Formateur introuvable pour ce centre.';
  end if;

  select a.account_type, a.name
    into v_account_type, v_account_name
  from public.finance_accounts a
  where a.id = p_account_id and a.centre_id = v_profile_centre_id and a.active = true
  for update;
  if not found then raise exception 'Caisse ou compte bancaire introuvable ou inactif.'; end if;
  if p_payment_method = 'cash' and v_account_type <> 'cash' then
    raise exception 'Pour une avance en espèces, sélectionnez une caisse.';
  end if;
  if p_payment_method in ('bank_transfer','card','cheque') and v_account_type <> 'bank' then
    raise exception 'Pour ce mode de paiement, sélectionnez un compte bancaire.';
  end if;

  select a.opening_balance + coalesce(sum(
    case when m.movement_type in ('inflow','transfer_in','adjustment') then m.amount else -m.amount end
  ),0)
    into v_balance
  from public.finance_accounts a
  left join public.finance_account_movements m
    on m.account_id = a.id and m.centre_id = a.centre_id
  where a.id = p_account_id and a.centre_id = v_profile_centre_id
  group by a.id, a.opening_balance;
  if v_balance < p_amount then
    raise exception 'Solde insuffisant sur « % » : disponible % DH, nécessaire % DH.', v_account_name, v_balance, p_amount;
  end if;

  insert into public.finance_teacher_advances (
    centre_id, teacher_id, amount, advance_date, notes, status, created_by,
    account_id, payment_method, payment_reference
  ) values (
    v_profile_centre_id, p_teacher_id, round(p_amount,2), p_advance_date,
    nullif(trim(coalesce(p_notes,'')),''), 'active', auth.uid(),
    p_account_id, p_payment_method, nullif(trim(coalesce(p_payment_reference,'')),'')
  ) returning id into v_advance_id;

  insert into public.finance_account_movements (
    centre_id, account_id, movement_type, amount, movement_date,
    description, source_type, source_id, created_by
  ) values (
    v_profile_centre_id, p_account_id, 'outflow', round(p_amount,2), p_advance_date,
    'Avance formateur ' || p_teacher_id || ' — avance ' || v_advance_id,
    'teacher_advance', v_advance_id, auth.uid()
  );
  return v_advance_id;
end;
$$;

revoke all on function public.finance_create_teacher_advance(bigint, numeric, date, text, uuid, text, text) from public;
grant execute on function public.finance_create_teacher_advance(bigint, numeric, date, text, uuid, text, text) to authenticated;
