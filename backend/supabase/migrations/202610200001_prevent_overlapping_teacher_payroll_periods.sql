-- Prevent overlapping payroll periods for the same teacher.
-- Apply in Supabase SQL Editor after 202610190001_atomic_teacher_payroll_save.sql.
-- Existing financial records are preserved; overlapping drafts must be corrected manually.
create or replace function public.finance_save_teacher_payroll(
  p_payroll_id uuid,
  p_teacher_id bigint,
  p_period_start date,
  p_period_end date,
  p_compensation_mode text,
  p_hours numeric,
  p_hourly_rate numeric,
  p_session_count numeric,
  p_session_rate numeric,
  p_monthly_salary numeric,
  p_advance_deduction numeric,
  p_notes text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_centre_id uuid;
  v_role text;
  v_payroll_id uuid := coalesce(p_payroll_id, gen_random_uuid());
  v_existing_status text;
  v_gross numeric(12,2);
  v_deduction numeric(12,2);
  v_available numeric(12,2);
  v_hours numeric(10,2);
  v_hourly_rate numeric(12,2);
  v_session_count numeric(10,2);
  v_session_rate numeric(12,2);
  v_monthly_salary numeric(12,2);
begin
  select p.centre_id, p.role
    into v_centre_id, v_role
  from public.profiles p
  where p.id = auth.uid();

  if auth.uid() is null or coalesce(v_role, '') not in ('admin', 'director') or v_centre_id is null then
    raise exception 'Accès refusé : directeur ou administrateur du centre requis.';
  end if;

  if p_teacher_id is null or p_period_start is null or p_period_end is null
     or p_period_end < p_period_start then
    raise exception 'Formateur ou période de rémunération invalide.';
  end if;
  if p_compensation_mode is null or p_compensation_mode not in ('hourly', 'session', 'monthly') then
    raise exception 'Mode de calcul de rémunération invalide.';
  end if;
  if p_hours is null or p_hourly_rate is null or p_session_count is null
     or p_session_rate is null or p_monthly_salary is null or p_advance_deduction is null
     or p_hours < 0 or p_hourly_rate < 0 or p_session_count < 0
     or p_session_rate < 0 or p_monthly_salary < 0 or p_advance_deduction < 0 then
    raise exception 'Les quantités, tarifs et déductions doivent être des nombres positifs ou nuls.';
  end if;

  -- Lock the teacher row so concurrent payroll saves cannot reserve the same advance balance.
  perform 1
  from public.formateurs f
  where f.id = p_teacher_id and f.centre_id = v_centre_id
  for update;

  if not found then
    raise exception 'Formateur introuvable pour ce centre.';
  end if;

  if p_payroll_id is not null then
    select pr.status into v_existing_status
    from public.finance_teacher_payroll pr
    where pr.id = p_payroll_id and pr.centre_id = v_centre_id
    for update;

    if not found then
      raise exception 'Rémunération introuvable pour ce centre.';
    end if;
    if v_existing_status <> 'draft' then
      raise exception 'Seule une rémunération en brouillon peut être modifiée.';
    end if;
  end if;

  -- Reject any date overlap with another active payroll for the same teacher.
  -- The teacher row lock above serializes concurrent save attempts.
  if exists (
    select 1
    from public.finance_teacher_payroll pr
    where pr.centre_id = v_centre_id
      and pr.teacher_id = p_teacher_id
      and pr.id <> v_payroll_id
      and pr.status <> 'cancelled'
      and pr.period_start <= p_period_end
      and p_period_start <= pr.period_end
  ) then
    raise exception
      'Cette période chevauche une rémunération existante. Modifiez le brouillon ou choisissez une période sans chevauchement avant de continuer.';
  end if;

  v_hours := case when p_compensation_mode = 'hourly' then round(p_hours, 2) else 0 end;
  v_hourly_rate := case when p_compensation_mode = 'hourly' then round(p_hourly_rate, 2) else 0 end;
  v_session_count := case when p_compensation_mode = 'session' then round(p_session_count, 2) else 0 end;
  v_session_rate := case when p_compensation_mode = 'session' then round(p_session_rate, 2) else 0 end;
  v_monthly_salary := case when p_compensation_mode = 'monthly' then round(p_monthly_salary, 2) else 0 end;

  v_gross := round(case p_compensation_mode
    when 'hourly' then v_hours * v_hourly_rate
    when 'session' then v_session_count * v_session_rate
    when 'monthly' then v_monthly_salary
  end, 2);
  v_deduction := round(p_advance_deduction, 2);

  if v_deduction > v_gross then
    raise exception 'La déduction d’avance ne peut pas dépasser la rémunération brute.';
  end if;

  select greatest(
    coalesce((select sum(a.amount)
      from public.finance_teacher_advances a
      where a.centre_id = v_centre_id and a.teacher_id = p_teacher_id and a.status = 'active'), 0)
    -
    coalesce((select sum(r.amount)
      from public.finance_teacher_advance_repayments r
      where r.centre_id = v_centre_id and r.teacher_id = p_teacher_id
        and r.status = 'active' and r.payroll_id <> v_payroll_id), 0),
    0
  )
  into v_available;

  if v_deduction > v_available then
    raise exception 'Solde d’avance insuffisant : disponible % DH, déduction demandée % DH.',
      round(v_available, 2), v_deduction;
  end if;

  if p_payroll_id is null then
    insert into public.finance_teacher_payroll (
      id, centre_id, teacher_id, period_start, period_end, hours, hourly_rate,
      compensation_mode, session_count, session_rate, monthly_salary,
      gross_amount, advance_deduction, amount_due, status, notes, created_by
    ) values (
      v_payroll_id, v_centre_id, p_teacher_id, p_period_start, p_period_end,
      v_hours, v_hourly_rate, p_compensation_mode, v_session_count, v_session_rate,
      v_monthly_salary, v_gross, v_deduction, round(v_gross - v_deduction, 2),
      'draft', nullif(trim(p_notes), ''), auth.uid()
    );
  else
    update public.finance_teacher_payroll
    set teacher_id = p_teacher_id,
        period_start = p_period_start,
        period_end = p_period_end,
        hours = v_hours,
        hourly_rate = v_hourly_rate,
        compensation_mode = p_compensation_mode,
        session_count = v_session_count,
        session_rate = v_session_rate,
        monthly_salary = v_monthly_salary,
        gross_amount = v_gross,
        advance_deduction = v_deduction,
        amount_due = round(v_gross - v_deduction, 2),
        notes = nullif(trim(p_notes), '')
    where id = v_payroll_id and centre_id = v_centre_id and status = 'draft';

    if not found then
      raise exception 'La rémunération a changé entre-temps. Rechargez la page puis réessayez.';
    end if;
  end if;

  if v_deduction > 0 then
    insert into public.finance_teacher_advance_repayments (
      centre_id, teacher_id, payroll_id, amount, status, created_by
    ) values (
      v_centre_id, p_teacher_id, v_payroll_id, v_deduction, 'active', auth.uid()
    )
    on conflict (centre_id, payroll_id) do update
    set teacher_id = excluded.teacher_id,
        amount = excluded.amount,
        status = 'active',
        created_by = excluded.created_by;
  else
    update public.finance_teacher_advance_repayments
    set status = 'cancelled'
    where centre_id = v_centre_id and payroll_id = v_payroll_id and status = 'active';
  end if;

  return v_payroll_id;
end;
$$;


create or replace function public.finance_change_teacher_payroll_status(
  p_payroll_id uuid,
  p_status text
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_centre_id uuid;
  v_role text;
  v_current_status text;
  v_teacher_id bigint;
  v_period_start date;
  v_period_end date;
begin
  select p.centre_id, p.role
    into v_centre_id, v_role
  from public.profiles p
  where p.id = auth.uid();

  if auth.uid() is null or coalesce(v_role, '') not in ('admin', 'director') or v_centre_id is null then
    raise exception 'Accès refusé : directeur ou administrateur du centre requis.';
  end if;
  if p_status is null or p_status not in ('approved', 'cancelled') then
    raise exception 'Transition de statut invalide.';
  end if;

  select pr.status, pr.teacher_id, pr.period_start, pr.period_end
    into v_current_status, v_teacher_id, v_period_start, v_period_end
  from public.finance_teacher_payroll pr
  where pr.id = p_payroll_id and pr.centre_id = v_centre_id
  for update;

  if not found then
    raise exception 'Rémunération introuvable pour ce centre.';
  end if;
  if v_current_status <> 'draft' then
    raise exception 'Seule une rémunération en brouillon peut être validée ou annulée.';
  end if;

  if p_status = 'approved' and exists (
    select 1
    from public.finance_teacher_payroll pr
    where pr.centre_id = v_centre_id
      and pr.teacher_id = v_teacher_id
      and pr.id <> p_payroll_id
      and pr.status <> 'cancelled'
      and pr.period_start <= v_period_end
      and v_period_start <= pr.period_end
  ) then
    raise exception
      'Validation impossible : cette période chevauche une autre rémunération non annulée pour ce formateur.';
  end if;

  update public.finance_teacher_payroll
  set status = p_status,
      approved_by = case when p_status = 'approved' then auth.uid() else null end
  where id = p_payroll_id and centre_id = v_centre_id and status = 'draft';

  if not found then
    raise exception 'La rémunération a changé entre-temps. Rechargez la page puis réessayez.';
  end if;

  if p_status = 'cancelled' then
    update public.finance_teacher_advance_repayments
    set status = 'cancelled'
    where centre_id = v_centre_id and payroll_id = p_payroll_id and status = 'active';
  end if;
end;
$$;

revoke all on function public.finance_save_teacher_payroll(uuid, bigint, date, date, text, numeric, numeric, numeric, numeric, numeric, numeric, text) from public;
revoke all on function public.finance_change_teacher_payroll_status(uuid, text) from public;
grant execute on function public.finance_save_teacher_payroll(uuid, bigint, date, date, text, numeric, numeric, numeric, numeric, numeric, numeric, text) to authenticated;
grant execute on function public.finance_change_teacher_payroll_status(uuid, text) to authenticated;
