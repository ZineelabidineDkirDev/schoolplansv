-- SchoolPlans Finance v1
-- Apply in Supabase SQL Editor after reviewing the target project's schema.
-- Financial records are isolated by centre_id and visible only to centre admins/directors.
-- Amounts are stored as numeric, not floating point.
-- Student and teacher IDs match the existing bigint primary keys.

create unique index if not exists etudiants_centre_id_id_finance_uq on public.etudiants (centre_id, id);
create unique index if not exists formateurs_centre_id_id_finance_uq on public.formateurs (centre_id, id);

create table if not exists public.finance_student_charges (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  student_id bigint not null,
  label text not null,
  amount_due numeric(12,2) not null check (amount_due >= 0),
  due_date date,
  status text not null default 'open' check (status in ('open','partial','paid','cancelled')),
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (centre_id, id),
  foreign key (centre_id, student_id) references public.etudiants(centre_id, id) on delete restrict
);

create table if not exists public.finance_payments (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  charge_id uuid not null,
  amount numeric(12,2) not null check (amount > 0),
  payment_method text not null check (payment_method in ('cash','bank_transfer','card','cheque','other')),
  receipt_number text not null,
  paid_at timestamptz not null default now(),
  reference text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (centre_id, receipt_number),
  foreign key (centre_id, charge_id) references public.finance_student_charges(centre_id, id) on delete restrict
);

create table if not exists public.finance_expenses (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  label text not null,
  category text not null,
  supplier text,
  amount numeric(12,2) not null check (amount > 0),
  expense_date date not null default current_date,
  due_date date,
  status text not null default 'pending' check (status in ('pending','approved','paid','rejected')),
  payment_method text check (payment_method in ('cash','bank_transfer','card','cheque','other')),
  receipt_url text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.finance_accounts (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  name text not null,
  account_type text not null check (account_type in ('cash','bank')),
  opening_balance numeric(12,2) not null default 0,
  currency text not null default 'MAD' check (currency = 'MAD'),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (centre_id, name),
  unique (centre_id, id)
);

create table if not exists public.finance_account_movements (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  account_id uuid not null,
  movement_type text not null check (movement_type in ('inflow','outflow','transfer_in','transfer_out','adjustment')),
  amount numeric(12,2) not null check (amount > 0),
  movement_date timestamptz not null default now(),
  description text not null,
  source_type text,
  source_id uuid,
  transfer_group_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (centre_id, account_id) references public.finance_accounts(centre_id, id) on delete restrict
);

create table if not exists public.finance_teacher_payroll (
  id uuid primary key default gen_random_uuid(),
  centre_id uuid not null references public.centres(id) on delete cascade,
  teacher_id bigint not null,
  period_start date not null,
  period_end date not null,
  hours numeric(10,2) not null default 0 check (hours >= 0),
  hourly_rate numeric(12,2) not null default 0 check (hourly_rate >= 0),
  amount_due numeric(12,2) not null check (amount_due >= 0),
  status text not null default 'draft' check (status in ('draft','approved','paid','cancelled')),
  approved_by uuid references auth.users(id) on delete set null,
  paid_at timestamptz,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (period_end >= period_start),
  foreign key (centre_id, teacher_id) references public.formateurs(centre_id, id) on delete restrict
);

create index if not exists finance_student_charges_centre_student_idx on public.finance_student_charges (centre_id, student_id);
create index if not exists finance_student_charges_centre_due_idx on public.finance_student_charges (centre_id, due_date);
create index if not exists finance_payments_centre_paid_idx on public.finance_payments (centre_id, paid_at);
create index if not exists finance_expenses_centre_date_idx on public.finance_expenses (centre_id, expense_date);
create index if not exists finance_movements_centre_date_idx on public.finance_account_movements (centre_id, movement_date);
create index if not exists finance_payroll_centre_period_idx on public.finance_teacher_payroll (centre_id, period_start, period_end);

alter table public.finance_student_charges enable row level security;
alter table public.finance_payments enable row level security;
alter table public.finance_expenses enable row level security;
alter table public.finance_accounts enable row level security;
alter table public.finance_account_movements enable row level security;
alter table public.finance_teacher_payroll enable row level security;

-- Fail closed: only an authenticated admin/director attached to the same centre.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'finance_student_charges',
    'finance_payments',
    'finance_expenses',
    'finance_accounts',
    'finance_account_movements',
    'finance_teacher_payroll'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', table_name || '_centre_admin_all', table_name);
    execute format(
      'create policy %I on public.%I for all to authenticated using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.centre_id = %I.centre_id and p.role in (''admin'', ''director''))) with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.centre_id = %I.centre_id and p.role in (''admin'', ''director'')))',
      table_name || '_centre_admin_all',
      table_name,
      table_name,
      table_name
    );
  end loop;
end $$;

grant select, insert, update on public.finance_student_charges to authenticated;
grant select, insert, update on public.finance_payments to authenticated;
grant select, insert, update on public.finance_expenses to authenticated;
grant select, insert, update on public.finance_accounts to authenticated;
grant select, insert, update on public.finance_account_movements to authenticated;
grant select, insert, update on public.finance_teacher_payroll to authenticated;

-- Financial transactions are cancelled/reversed, not silently deleted.
revoke delete on public.finance_student_charges from authenticated;
revoke delete on public.finance_payments from authenticated;
revoke delete on public.finance_expenses from authenticated;
revoke delete on public.finance_accounts from authenticated;
revoke delete on public.finance_account_movements from authenticated;
revoke delete on public.finance_teacher_payroll from authenticated;
