-- SchoolPlans payroll business rules v4
-- Review the deployed schema before applying. This migration is additive and does not delete financial history.

-- Individual teacher tariff history with effective dates.
create table if not exists public.finance_teacher_rates (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  teacher_id bigint not null,
  compensation_mode text not null check (compensation_mode in ('hourly','session','monthly')),
  hourly_rate numeric(12,2) not null default 0 check (hourly_rate >= 0),
  session_rate numeric(12,2) not null default 0 check (session_rate >= 0),
  monthly_salary numeric(12,2) not null default 0 check (monthly_salary >= 0),
  effective_from date not null,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (centre_id, id),
  foreign key (centre_id, teacher_id) references public.formateurs(centre_id, id) on delete restrict
);

create index if not exists finance_teacher_rates_lookup_idx
  on public.finance_teacher_rates (centre_id, teacher_id, effective_from desc);

-- Track how an already-paid or already-closed period is corrected without editing the original payroll.
create table if not exists public.finance_teacher_payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  teacher_id bigint not null,
  source_payroll_id uuid,
  source_session_id text,
  adjustment_type text not null check (adjustment_type in ('late_session','exceptional_payment','correction','reversal')),
  amount numeric(12,2) not null,
  reason text not null check (length(trim(reason)) > 0),
  status text not null default 'pending' check (status in ('pending','approved','paid','cancelled')),
  payment_method text check (payment_method in ('cash','bank_transfer','card','cheque','other')),
  payment_reference text,
  paid_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (centre_id, id),
  foreign key (centre_id, teacher_id) references public.formateurs(centre_id, id) on delete restrict,
  foreign key (centre_id, source_payroll_id) references public.finance_teacher_payroll(centre_id, id) on delete restrict
);

create index if not exists finance_payroll_adjustments_teacher_status_idx
  on public.finance_teacher_payroll_adjustments (centre_id, teacher_id, status, created_at desc);

-- Record the payment metadata and motivated cancellation on payroll records.
alter table public.finance_teacher_payroll
  add column if not exists payment_method text,
  add column if not exists payment_reference text,
  add column if not exists payment_receipt_url text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users(id) on delete set null,
  add column if not exists cancellation_reason text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'finance_teacher_payroll_payment_method_check') then
    alter table public.finance_teacher_payroll
      add constraint finance_teacher_payroll_payment_method_check
      check (payment_method is null or payment_method in ('cash','bank_transfer','card','cheque','other'));
  end if;
end $$;

-- Structured audit log. The reason is taken from cancellation_reason / notes where available;
-- a future UI action can supply a more specific reason for each operation.
create table if not exists public.finance_audit_log (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  entity_table text not null,
  entity_id text not null,
  operation text not null check (operation in ('INSERT','UPDATE','DELETE')),
  old_value jsonb,
  new_value jsonb,
  reason text,
  actor_id uuid references auth.users(id) on delete set null,
  occurred_at timestamptz not null default now()
);

create index if not exists finance_audit_log_entity_idx
  on public.finance_audit_log (centre_id, entity_table, entity_id, occurred_at desc);

create or replace function public.finance_capture_audit()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_centre_id uuid;
  v_entity_id text;
  v_reason text;
begin
  v_centre_id := coalesce((to_jsonb(new)->>'centre_id')::uuid, (to_jsonb(old)->>'centre_id')::uuid);
  v_entity_id := coalesce(to_jsonb(new)->>'id', to_jsonb(old)->>'id');
  v_reason := coalesce(to_jsonb(new)->>'cancellation_reason', to_jsonb(new)->>'notes', to_jsonb(old)->>'notes');
  insert into public.finance_audit_log (
    centre_id, entity_table, entity_id, operation, old_value, new_value, reason, actor_id
  ) values (
    v_centre_id, tg_table_name, v_entity_id, tg_op,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end,
    v_reason, auth.uid()
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists finance_teacher_payroll_audit on public.finance_teacher_payroll;
create trigger finance_teacher_payroll_audit
after insert or update or delete on public.finance_teacher_payroll
for each row execute function public.finance_capture_audit();

drop trigger if exists finance_teacher_advances_audit on public.finance_teacher_advances;
create trigger finance_teacher_advances_audit
after insert or update or delete on public.finance_teacher_advances
for each row execute function public.finance_capture_audit();

drop trigger if exists finance_teacher_advance_repayments_audit on public.finance_teacher_advance_repayments;
create trigger finance_teacher_advance_repayments_audit
after insert or update or delete on public.finance_teacher_advance_repayments
for each row execute function public.finance_capture_audit();

drop trigger if exists finance_teacher_rates_audit on public.finance_teacher_rates;
create trigger finance_teacher_rates_audit
after insert or update or delete on public.finance_teacher_rates
for each row execute function public.finance_capture_audit();

drop trigger if exists finance_teacher_payroll_adjustments_audit on public.finance_teacher_payroll_adjustments;
create trigger finance_teacher_payroll_adjustments_audit
after insert or update or delete on public.finance_teacher_payroll_adjustments
for each row execute function public.finance_capture_audit();

alter table public.finance_teacher_rates enable row level security;
alter table public.finance_teacher_payroll_adjustments enable row level security;
alter table public.finance_audit_log enable row level security;

-- Administrators are read-only. Only a director of the same centre may write financial data.
do $$
declare
  t text;
begin
  foreach t in array array[
    'finance_student_charges','finance_payments','finance_expenses',
    'finance_accounts','finance_account_movements','finance_teacher_payroll',
    'finance_teacher_advances','finance_teacher_advance_repayments',
    'finance_teacher_rates','finance_teacher_payroll_adjustments'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_centre_admin_all', t);
    execute format('drop policy if exists %I on public.%I', t || '_director_all', t);
    execute format('drop policy if exists %I on public.%I', t || '_admin_read', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.centre_id = %I.centre_id and lower(p.role) in (''director'', ''directeur''))) with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.centre_id = %I.centre_id and lower(p.role) in (''director'', ''directeur'')))',
      t || '_director_all', t, t, t
    );
    execute format(
      'create policy %I on public.%I for select to authenticated using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.centre_id = %I.centre_id and lower(p.role) = ''admin''))',
      t || '_admin_read', t, t
    );
  end loop;
end $$;

drop policy if exists finance_audit_log_director_read on public.finance_audit_log;
create policy finance_audit_log_director_read on public.finance_audit_log
for select to authenticated using (
  exists (select 1 from public.profiles p
    where p.id = auth.uid() and p.centre_id = finance_audit_log.centre_id
      and lower(p.role) in ('director','directeur','admin'))
);

drop policy if exists finance_audit_log_director_insert on public.finance_audit_log;
create policy finance_audit_log_director_insert on public.finance_audit_log
for insert to authenticated with check (
  exists (select 1 from public.profiles p
    where p.id = auth.uid() and p.centre_id = finance_audit_log.centre_id
      and lower(p.role) in ('director','directeur'))
);

grant select, insert, update on public.finance_teacher_rates to authenticated;
grant select, insert, update on public.finance_teacher_payroll_adjustments to authenticated;
grant select on public.finance_audit_log to authenticated;
revoke delete on public.finance_teacher_rates from authenticated;
revoke delete on public.finance_teacher_payroll_adjustments from authenticated;
revoke update, delete on public.finance_audit_log from authenticated;
