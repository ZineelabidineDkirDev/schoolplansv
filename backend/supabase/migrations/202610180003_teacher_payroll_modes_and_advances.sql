-- SchoolPlans Finance v3: configurable payroll calculation and advance ledger.
-- Apply after 202610180001_school_finance.sql and 202610180002_finance_operations_rpc.sql.

alter table public.finance_teacher_payroll
  add column if not exists compensation_mode text not null default 'hourly',
  add column if not exists session_count numeric(10,2) not null default 0,
  add column if not exists session_rate numeric(12,2) not null default 0,
  add column if not exists monthly_salary numeric(12,2) not null default 0,
  add column if not exists gross_amount numeric(12,2) not null default 0,
  add column if not exists advance_deduction numeric(12,2) not null default 0;

alter table public.finance_teacher_payroll
  drop constraint if exists finance_teacher_payroll_compensation_mode_check,
  add constraint finance_teacher_payroll_compensation_mode_check
    check (compensation_mode in ('hourly', 'session', 'monthly')),
  drop constraint if exists finance_teacher_payroll_session_count_check,
  add constraint finance_teacher_payroll_session_count_check check (session_count >= 0),
  drop constraint if exists finance_teacher_payroll_session_rate_check,
  add constraint finance_teacher_payroll_session_rate_check check (session_rate >= 0),
  drop constraint if exists finance_teacher_payroll_monthly_salary_check,
  add constraint finance_teacher_payroll_monthly_salary_check check (monthly_salary >= 0),
  drop constraint if exists finance_teacher_payroll_gross_amount_check,
  add constraint finance_teacher_payroll_gross_amount_check check (gross_amount >= 0),
  drop constraint if exists finance_teacher_payroll_advance_deduction_check,
  add constraint finance_teacher_payroll_advance_deduction_check
    check (advance_deduction >= 0 and advance_deduction <= gross_amount),
  drop constraint if exists finance_teacher_payroll_amount_due_check,
  add constraint finance_teacher_payroll_amount_due_check check (amount_due >= 0);

-- Preserve existing payroll values as the gross amount; no historical records are removed.
update public.finance_teacher_payroll
set gross_amount = amount_due,
    advance_deduction = 0
where gross_amount = 0 and amount_due > 0;

create unique index if not exists finance_teacher_payroll_centre_id_id_uq
  on public.finance_teacher_payroll (centre_id, id);

create table if not exists public.finance_teacher_advances (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  teacher_id bigint not null,
  amount numeric(12,2) not null check (amount > 0),
  advance_date date not null default current_date,
  notes text,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (centre_id, id),
  foreign key (centre_id, teacher_id)
    references public.formateurs(centre_id, id) on delete restrict
);

create table if not exists public.finance_teacher_advance_repayments (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  teacher_id bigint not null,
  payroll_id uuid not null,
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'active' check (status in ('active', 'cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (centre_id, payroll_id),
  foreign key (centre_id, teacher_id)
    references public.formateurs(centre_id, id) on delete restrict,
  foreign key (centre_id, payroll_id)
    references public.finance_teacher_payroll(centre_id, id) on delete restrict
);

create index if not exists finance_teacher_advances_centre_teacher_date_idx
  on public.finance_teacher_advances (centre_id, teacher_id, advance_date);
create index if not exists finance_teacher_advance_repayments_centre_teacher_idx
  on public.finance_teacher_advance_repayments (centre_id, teacher_id);

alter table public.finance_teacher_advances enable row level security;
alter table public.finance_teacher_advance_repayments enable row level security;

drop policy if exists finance_teacher_advances_centre_admin_all
  on public.finance_teacher_advances;
create policy finance_teacher_advances_centre_admin_all
  on public.finance_teacher_advances for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.centre_id = finance_teacher_advances.centre_id
      and p.role in ('admin', 'director')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.centre_id = finance_teacher_advances.centre_id
      and p.role in ('admin', 'director')
  ));

drop policy if exists finance_teacher_advance_repayments_centre_admin_all
  on public.finance_teacher_advance_repayments;
create policy finance_teacher_advance_repayments_centre_admin_all
  on public.finance_teacher_advance_repayments for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.centre_id = finance_teacher_advance_repayments.centre_id
      and p.role in ('admin', 'director')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.centre_id = finance_teacher_advance_repayments.centre_id
      and p.role in ('admin', 'director')
  ));

grant select, insert, update on public.finance_teacher_advances to authenticated;
grant select, insert, update on public.finance_teacher_advance_repayments to authenticated;
revoke delete on public.finance_teacher_advances from authenticated;
revoke delete on public.finance_teacher_advance_repayments from authenticated;
