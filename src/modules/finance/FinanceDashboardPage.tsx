import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Button, LoadingState, confirmAction } from '../../components/ui';
import { getSupabaseClient } from '../../data/supabase/client';
import { useAuth } from '../auth/AuthProvider';
import { FinanceOperations } from './FinanceOperations';

type Student = { id: number; prenom: string; nom: string };
type Teacher = { id: number; nom: string; profile_id?: string | null };
type TeacherAdvance = { id: string; teacher_id: number; amount: number | string; advance_date: string; notes: string | null; status: string };
type AdvanceRepayment = { teacher_id: number; payroll_id: string; amount: number | string; status: string };
type FinanceAccount = { id: string; name: string; account_type: 'cash' | 'bank'; active: boolean };
type PlannedSession = { cours_id: number | string; date: string; validation_status: string };
type CourseTime = { id: number | string; debut: string; fin: string };
type Charge = { id: string; student_id: number; label: string; amount_due: number | string; due_date: string | null; status: string; notes: string | null };
type Payment = { id: string; charge_id: string; amount: number | string; payment_method: string; receipt_number: string; paid_at: string; reference?: string | null; notes?: string | null };
type Payroll = { id: string; teacher_id: number; period_start: string; period_end: string; hours: number | string; hourly_rate: number | string; compensation_mode?: string; session_count?: number | string; session_rate?: number | string; monthly_salary?: number | string; gross_amount?: number | string; advance_deduction?: number | string; amount_due: number | string; status: string; paid_at: string | null; notes: string | null; payment_method?: string | null; payment_reference?: string | null; cancellation_reason?: string | null; payment_reversed_at?: string | null; payment_reversal_reason?: string | null };
type TeacherRate = { id: string; teacher_id: number; compensation_mode: string; hourly_rate: number | string; session_rate: number | string; monthly_salary: number | string; effective_from: string; notes: string | null };
type PayrollAdjustment = { id: string; teacher_id: number; source_payroll_id: string | null; source_session_id: string | null; adjustment_type: 'late_session' | 'exceptional_payment' | 'correction' | 'reversal'; amount: number | string; reason: string; status: 'pending' | 'approved' | 'paid' | 'cancelled'; payment_method: string | null; payment_reference: string | null; paid_at: string | null };
type Summary = { charges: number; collected: number; expenses: number; payrollDue: number; chargeCount: number; expenseCount: number; payrollCount: number };
const EMPTY: Summary = { charges: 0, collected: 0, expenses: 0, payrollDue: 0, chargeCount: 0, expenseCount: 0, payrollCount: 0 };
const METHODS = [{ value: 'cash', label: 'Espèces' }, { value: 'bank_transfer', label: 'Virement bancaire' }, { value: 'card', label: 'Carte bancaire' }, { value: 'cheque', label: 'Chèque' }, { value: 'other', label: 'Autre' }];
const money = (value: number) => new Intl.NumberFormat('fr-MA', { style: 'currency', currency: 'MAD', maximumFractionDigits: 2 }).format(value);
const numeric = (value: number | string | null | undefined) => { const n = Number(value ?? 0); return Number.isFinite(n) ? n : 0; };
const today = () => new Date().toISOString().slice(0, 10);
const durationHours = (start: string, end: string) => { const parse = (value: string) => { const [hours, minutes] = value.split(':').map(Number); return hours * 60 + minutes; }; const duration = parse(end) - parse(start); return Number.isFinite(duration) && duration > 0 ? duration / 60 : 0; };
const monthStart = () => today().slice(0, 8) + '01';
const monthEnd = () => today().slice(0, 8) + String(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()).padStart(2, '0');
const lastDayOfMonth = (date: string) => { const [year, month] = date.split('-').map(Number); return year && month ? year + '-' + String(month).padStart(2, '0') + '-' + String(new Date(year, month, 0).getDate()).padStart(2, '0') : monthEnd(); };

function readableFinanceError(cause: unknown, fallback: string): string {
  if (cause && typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string') {
    const details = 'details' in cause && typeof cause.details === 'string' ? cause.details : '';
    const code = 'code' in cause && typeof cause.code === 'string' ? ' [' + cause.code + ']' : '';
    return cause.message + code + (details ? ' — ' + details : '');
  }
  return cause instanceof Error ? cause.message : fallback;
}


function Popup({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="finance-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section aria-modal="true" className="finance-modal" role="dialog" aria-labelledby="finance-modal-title">
      <header className="finance-modal-header"><div><p className="sp-page-eyebrow">Tableau de bord financier</p><h2 id="finance-modal-title">{title}</h2></div><button type="button" className="finance-modal-close" aria-label="Fermer" onClick={onClose}>×</button></header>
      {children}
    </section>
  </div>;
}

export function FinanceDashboardPage() {
  const { profile } = useAuth();
  const isDirector = ['director', 'directeur'].includes(String(profile?.role ?? '').toLowerCase());
  const isFinanceReader = isDirector || String(profile?.role ?? '').toLowerCase() === 'admin';
  const [summary, setSummary] = useState<Summary>(EMPTY);
  const [students, setStudents] = useState<Student[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [charges, setCharges] = useState<Charge[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [payroll, setPayroll] = useState<Payroll[]>([]);
  const [advances, setAdvances] = useState<TeacherAdvance[]>([]);
  const [advanceRepayments, setAdvanceRepayments] = useState<AdvanceRepayment[]>([]);
  const [teacherRates, setTeacherRates] = useState<TeacherRate[]>([]);
  const [adjustments, setAdjustments] = useState<PayrollAdjustment[]>([]);
  const [financeAccounts, setFinanceAccounts] = useState<FinanceAccount[]>([]);
  const [validatedSessionStats, setValidatedSessionStats] = useState({ count: 0, hours: 0, gross: 0, loading: false, missingRateCount: 0, modeMismatchCount: 0, rateSummary: [] as string[] });
  const [payrollPaymentForm, setPayrollPaymentForm] = useState({ payrollId: '', amount: '', paidAt: today(), method: 'cash', reference: '', accountId: '' });
  const [rateForm, setRateForm] = useState({ teacherId: '', compensationMode: 'hourly', hourlyRate: '', sessionRate: '', monthlySalary: '', effectiveFrom: today(), notes: '' });
  const [adjustmentForm, setAdjustmentForm] = useState({ teacherId: '', type: 'late_session' as PayrollAdjustment['adjustment_type'], amount: '', sourceSessionId: '', reason: '' });
  const [adjustmentPaymentForm, setAdjustmentPaymentForm] = useState({ adjustmentId: '', paidAt: today(), method: 'cash', reference: '', accountId: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [view, setView] = useState<'students' | 'expenses' | 'receipts' | 'payroll'>('students');
  const [modal, setModal] = useState<'charge' | 'payment' | 'payroll' | 'advance' | 'payroll-payment' | 'rate' | 'adjustment' | 'adjustment-payment' | null>(null);
  const [editingChargeId, setEditingChargeId] = useState<string | null>(null);
  const [editingPayrollId, setEditingPayrollId] = useState<string | null>(null);
  const [chargeForm, setChargeForm] = useState({ studentId: '', label: 'Frais de scolarité', amount: '', dueDate: '', notes: '' });
  const [paymentForm, setPaymentForm] = useState({ chargeId: '', amount: '', method: 'cash', reference: '', notes: '' });
  const [payrollForm, setPayrollForm] = useState({ teacherId: '', periodStart: monthStart(), periodEnd: monthEnd(), compensationMode: 'hourly', hours: '', hourlyRate: '', sessionCount: '', sessionRate: '', monthlySalary: '', advanceDeduction: '', notes: '' });
  const [advanceForm, setAdvanceForm] = useState({ teacherId: '', amount: '', advanceDate: today(), notes: '' });
  const reload = useCallback(() => setReloadKey((value) => value + 1), []);
  useEffect(() => { if (profile?.role === 'formateur') setView('payroll'); }, [profile?.role]);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!profile?.centreId) { setError('Votre compte n’est pas rattaché à un établissement.'); setLoading(false); return; }
      setLoading(true); setError(null);
      try {
        const client = getSupabaseClient();
        const results = await Promise.all([
          client.from('etudiants').select('id,prenom,nom').eq('centre_id', profile.centreId).order('nom'),
          client.from('formateurs').select('id,nom,profile_id').eq('centre_id', profile.centreId).order('nom'),
          client.from('finance_student_charges').select('id,student_id,label,amount_due,due_date,status,notes').eq('centre_id', profile.centreId).neq('status', 'cancelled').order('created_at', { ascending: false }),
          client.from('finance_payments').select('id,charge_id,amount,payment_method,receipt_number,paid_at,reference,notes').eq('centre_id', profile.centreId).order('paid_at', { ascending: false }),
          client.from('finance_expenses').select('amount').eq('centre_id', profile.centreId).eq('status', 'paid'),
          client.from('finance_teacher_payroll').select('id,teacher_id,period_start,period_end,hours,hourly_rate,compensation_mode,session_count,session_rate,monthly_salary,gross_amount,advance_deduction,amount_due,status,paid_at,notes,payment_method,payment_reference,cancellation_reason,payment_reversed_at,payment_reversal_reason').eq('centre_id', profile.centreId).order('period_start', { ascending: false }),
          client.from('finance_teacher_advances').select('id,teacher_id,amount,advance_date,notes,status').eq('centre_id', profile.centreId).order('advance_date', { ascending: false }),
          client.from('finance_teacher_advance_repayments').select('teacher_id,payroll_id,amount,status').eq('centre_id', profile.centreId).eq('status', 'active'),
          client.from('finance_teacher_rates').select('id,teacher_id,compensation_mode,hourly_rate,session_rate,monthly_salary,effective_from,notes').eq('centre_id', profile.centreId).order('effective_from', { ascending: false }),
          client.from('finance_accounts').select('id,name,account_type,active').eq('centre_id', profile.centreId).eq('active', true).order('name'),
          client.from('finance_teacher_payroll_adjustments').select('id,teacher_id,source_payroll_id,source_session_id,adjustment_type,amount,reason,status,payment_method,payment_reference,paid_at').eq('centre_id', profile.centreId).order('created_at', { ascending: false }),
        ]);
        const failed = results.find((result) => result.error);
        if (failed?.error) throw failed.error;
        const nextCharges = (results[2].data ?? []) as Charge[];
        const nextPayments = (results[3].data ?? []) as Payment[];
        const expenses = (results[4].data ?? []) as { amount: number | string }[];
        const nextPayroll = (results[5].data ?? []) as Payroll[];
        const nextAdvances = (results[6].data ?? []) as TeacherAdvance[];
        const nextRepayments = (results[7].data ?? []) as AdvanceRepayment[];
        const nextRates = (results[8].data ?? []) as TeacherRate[];
        const nextAccounts = (results[9].data ?? []) as FinanceAccount[];
        const nextAdjustments = (results[10].data ?? []) as PayrollAdjustment[];
        const nextSummary: Summary = {
          charges: nextCharges.reduce((sum, row) => sum + numeric(row.amount_due), 0),
          collected: nextPayments.reduce((sum, row) => sum + numeric(row.amount), 0),
          expenses: expenses.reduce((sum, row) => sum + numeric(row.amount), 0),
          payrollDue: nextPayroll.filter((row) => row.status === 'approved').reduce((sum, row) => sum + numeric(row.amount_due), 0),
          chargeCount: nextCharges.length, expenseCount: expenses.length,
          payrollCount: nextPayroll.filter((row) => row.status === 'approved').length,
        };
        if (active) {
          setStudents((results[0].data ?? []) as Student[]);
          setTeachers(((results[1].data ?? []) as Teacher[]).filter((teacher) => profile.role !== 'formateur' || teacher.profile_id === profile.id));
          setCharges(nextCharges); setPayments(nextPayments); setPayroll(nextPayroll); setAdvances(nextAdvances); setAdvanceRepayments(nextRepayments); setTeacherRates(nextRates); setFinanceAccounts(nextAccounts); setAdjustments(nextAdjustments); setSummary(nextSummary);
          setPaymentForm((current) => ({ ...current, chargeId: nextCharges.find((charge) => ['open', 'partial'].includes(charge.status))?.id ?? current.chargeId }));
        }
      } catch (cause) { if (active) setError(readableFinanceError(cause, 'Impossible de charger les données financières.')); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [profile?.centreId, reloadKey]);

  useEffect(() => {
    let active = true;
    async function loadValidatedSessions() {
      if (modal !== 'payroll' || !isDirector || !profile?.centreId || !payrollForm.teacherId || !payrollForm.periodStart || !payrollForm.periodEnd) {
        setValidatedSessionStats({ count: 0, hours: 0, gross: 0, loading: false, missingRateCount: 0, modeMismatchCount: 0, rateSummary: [] });
        return;
      }
      setValidatedSessionStats((current) => ({ ...current, loading: true, gross: 0, missingRateCount: 0, modeMismatchCount: 0, rateSummary: [] }));
      try {
        const client = getSupabaseClient();
        const courseResult = await client.from('cours').select('id,debut,fin').eq('centre_id', profile.centreId).eq('formateur_id', Number(payrollForm.teacherId));
        if (courseResult.error) throw courseResult.error;
        const courseRows = (courseResult.data ?? []) as CourseTime[];
        if (!courseRows.length) {
          if (active) setValidatedSessionStats({ count: 0, hours: 0, gross: 0, loading: false, missingRateCount: 0, modeMismatchCount: 0, rateSummary: [] });
          return;
        }
        const courseIds = courseRows.map((course) => course.id);
        const [sessionResult, cancellationResult] = await Promise.all([
          client.from('seances_realisees').select('cours_id,date,validation_status').eq('centre_id', profile.centreId).eq('validation_status', 'approved').gte('date', payrollForm.periodStart).lte('date', payrollForm.periodEnd).in('cours_id', courseIds),
          client.from('annulations').select('cours_id,date').eq('centre_id', profile.centreId).gte('date', payrollForm.periodStart).lte('date', payrollForm.periodEnd).in('cours_id', courseIds),
        ]);
        if (sessionResult.error) throw sessionResult.error;
        if (cancellationResult.error) throw cancellationResult.error;
        const approved = (sessionResult.data ?? []) as PlannedSession[];
        const cancelled = new Set((cancellationResult.data ?? []).map((row) => String(row.cours_id) + '|' + row.date));
        const byId = new Map(courseRows.map((course) => [String(course.id), course]));
        let count = 0, hours = 0, gross = 0, missingRateCount = 0, modeMismatchCount = 0;
        const rateSummary = new Set<string>();
        for (const session of approved) {
          if (cancelled.has(String(session.cours_id) + '|' + session.date)) continue;
          const course = byId.get(String(session.cours_id));
          if (!course) continue;
          const sessionHours = durationHours(course.debut, course.fin);
          if (sessionHours <= 0) continue;
          count += 1;
          hours += sessionHours;
          if (payrollForm.compensationMode === 'monthly') continue;
          const rate = teacherRates
            .filter((item) => Number(item.teacher_id) === Number(payrollForm.teacherId) && item.effective_from <= session.date)
            .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
          if (!rate) { missingRateCount += 1; continue; }
          if (rate.compensation_mode !== payrollForm.compensationMode) { modeMismatchCount += 1; continue; }
          if (rate.compensation_mode === 'hourly') {
            const hourly = numeric(rate.hourly_rate);
            gross += sessionHours * hourly;
            rateSummary.add(rate.effective_from + ' : ' + money(hourly) + '/h');
          } else {
            const perSession = numeric(rate.session_rate);
            gross += perSession;
            rateSummary.add(rate.effective_from + ' : ' + money(perSession) + '/séance');
          }
        }
        if (active) setValidatedSessionStats({ count, hours: Math.round(hours * 100) / 100, gross: Math.round(gross * 100) / 100, loading: false, missingRateCount, modeMismatchCount, rateSummary: [...rateSummary].sort() });
      } catch (cause) {
        if (active) {
          setValidatedSessionStats({ count: 0, hours: 0, gross: 0, loading: false, missingRateCount: 0, modeMismatchCount: 0, rateSummary: [] });
          setError(readableFinanceError(cause, 'Impossible de calculer les séances validées.'));
        }
      }
    }
    void loadValidatedSessions();
    return () => { active = false; };
  }, [modal, isDirector, profile?.centreId, payrollForm.teacherId, payrollForm.periodStart, payrollForm.periodEnd, payrollForm.compensationMode, teacherRates, reloadKey]);

  const studentName = (id: number) => { const student = students.find((item) => Number(item.id) === Number(id)); return student ? (student.prenom + ' ' + student.nom).trim() : 'Étudiant #' + id; };
  const teacherName = (id: number) => { const teacher = teachers.find((item) => Number(item.id) === Number(id)); return teacher ? teacher.nom : 'Formateur #' + id; };
  const advanceBalance = (teacherId: number) => Math.max(0, advances.filter((item) => Number(item.teacher_id) === Number(teacherId) && item.status === 'active').reduce((sum, item) => sum + numeric(item.amount), 0) - advanceRepayments.filter((item) => Number(item.teacher_id) === Number(teacherId) && item.status === 'active').reduce((sum, item) => sum + numeric(item.amount), 0));
  const advanceBalanceForPayroll = (teacherId: number, payrollId: string | null) => advanceBalance(teacherId) + (payrollId ? advanceRepayments.filter((item) => item.payroll_id === payrollId && item.status === 'active').reduce((sum, item) => sum + numeric(item.amount), 0) : 0);
  const payrollGross = payrollForm.compensationMode === 'monthly' ? numeric(payrollForm.monthlySalary) : validatedSessionStats.gross;
  const payrollNet = Math.max(0, payrollGross - numeric(payrollForm.advanceDeduction));
  const paidForCharge = (chargeId: string) => payments.filter((payment) => payment.charge_id === chargeId).reduce((sum, payment) => sum + numeric(payment.amount), 0);
  const outstanding = Math.max(0, summary.charges - summary.collected);

  function openCharge(charge?: Charge) {
    setError(null); setEditingChargeId(charge?.id ?? null);
    setChargeForm(charge ? { studentId: String(charge.student_id), label: charge.label, amount: String(charge.amount_due), dueDate: charge.due_date ?? '', notes: charge.notes ?? '' } : { studentId: '', label: 'Frais de scolarité', amount: '', dueDate: '', notes: '' });
    setModal('charge');
  }
  function openPayroll(item?: Payroll) {
    setError(null); setEditingPayrollId(item?.id ?? null);
    const effectiveRate = teacherRates.filter((rate) => Number(rate.teacher_id) === Number(item?.teacher_id) && rate.effective_from <= (item?.period_start ?? monthStart())).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
    setPayrollForm(item ? { teacherId: String(item.teacher_id), periodStart: item.period_start, periodEnd: item.period_end, compensationMode: item.compensation_mode ?? effectiveRate?.compensation_mode ?? 'hourly', hours: String(item.hours), hourlyRate: String(item.hourly_rate), sessionCount: String(item.session_count ?? 0), sessionRate: String(item.session_rate ?? 0), monthlySalary: String(item.monthly_salary ?? 0), advanceDeduction: String(item.advance_deduction ?? 0), notes: item.notes ?? '' } : { teacherId: '', periodStart: monthStart(), periodEnd: monthEnd(), compensationMode: 'hourly', hours: '', hourlyRate: '', sessionCount: '', sessionRate: '', monthlySalary: '', advanceDeduction: '', notes: '' });
    setModal('payroll');
  }

  async function saveCharge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!profile?.centreId) return;
    if (!isDirector) { setError('Mode consultation : seul le directeur peut modifier les frais.'); return; }
    const amountDue = Number(chargeForm.amount);
    if (!chargeForm.studentId || !chargeForm.label.trim() || !Number.isFinite(amountDue) || amountDue <= 0) { setError('Choisissez un étudiant et saisissez un montant supérieur à 0 DH.'); return; }
    if (editingChargeId && amountDue < paidForCharge(editingChargeId)) { setError('Le montant ne peut pas être inférieur aux paiements déjà reçus.'); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const client = getSupabaseClient();
      const alreadyCollected = editingChargeId ? paidForCharge(editingChargeId) : 0;
      const nextStatus = alreadyCollected >= amountDue ? 'paid' : alreadyCollected > 0 ? 'partial' : 'open';
      const payload = { student_id: Number(chargeForm.studentId), label: chargeForm.label.trim(), amount_due: amountDue, due_date: chargeForm.dueDate || null, notes: chargeForm.notes.trim() || null, status: nextStatus, updated_at: new Date().toISOString() };
      const result = editingChargeId
        ? await client.from('finance_student_charges').update(payload).eq('id', editingChargeId).eq('centre_id', profile.centreId)
        : await client.from('finance_student_charges').insert({ ...payload, centre_id: profile.centreId, created_by: profile.id });
      if (result.error) throw result.error;
      setNotice(editingChargeId ? 'Frais modifié.' : 'Frais enregistré.');
      setModal(null); reload();
    } catch (cause) { setError(readableFinanceError(cause, 'Impossible d’enregistrer les frais.')); }
    finally { setSaving(false); }
  }

  async function cancelCharge(charge: Charge) {
    if (!profile?.centreId || !isDirector) { setError('Seul le directeur peut annuler des frais.'); return; }
    if (!window.confirm('Annuler les frais « ' + charge.label + ' » ? Les paiements existants seront conservés.')) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const { error } = await getSupabaseClient().from('finance_student_charges').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', charge.id).eq('centre_id', profile.centreId);
      if (error) throw error;
      setNotice('Frais annulé. L’historique des paiements est conservé.'); reload();
    } catch (cause) { setError(readableFinanceError(cause, 'Impossible d’annuler les frais.')); }
    finally { setSaving(false); }
  }

  async function recordPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!profile?.centreId) return;
    if (!isDirector) { setError('Mode consultation : seul le directeur peut enregistrer un paiement.'); return; }
    const charge = charges.find((item) => item.id === paymentForm.chargeId);
    const paidAmount = Number(paymentForm.amount);
    if (!charge || !Number.isFinite(paidAmount) || paidAmount <= 0) { setError('Sélectionnez des frais et saisissez un paiement supérieur à 0 DH.'); return; }
    const alreadyPaid = paidForCharge(charge.id);
    const remaining = Math.max(0, numeric(charge.amount_due) - alreadyPaid);
    if (paidAmount > remaining + 0.001) { setError('Le paiement dépasse le reste dû (' + money(remaining) + ').'); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const receipt = 'REC-' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
      const client = getSupabaseClient();
      const { error: paymentError } = await client.from('finance_payments').insert({ centre_id: profile.centreId, charge_id: charge.id, amount: paidAmount, payment_method: paymentForm.method, receipt_number: receipt, reference: paymentForm.reference.trim() || null, notes: paymentForm.notes.trim() || null, created_by: profile.id });
      if (paymentError) throw paymentError;
      const newTotal = alreadyPaid + paidAmount;
      const { error: statusError } = await client.from('finance_student_charges').update({ status: newTotal >= numeric(charge.amount_due) ? 'paid' : 'partial', updated_at: new Date().toISOString() }).eq('id', charge.id).eq('centre_id', profile.centreId);
      if (statusError) throw new Error('Paiement enregistré (reçu ' + receipt + '), mais le statut du frais n’a pas été actualisé : ' + statusError.message);
      setNotice('Paiement enregistré. Reçu n° ' + receipt + '.'); setPaymentForm({ chargeId: '', amount: '', method: 'cash', reference: '', notes: '' }); setModal(null); setView('receipts'); reload();
    } catch (cause) { setError(readableFinanceError(cause, 'Impossible d’enregistrer le paiement.')); }
    finally { setSaving(false); }
  }

  async function savePayroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!profile?.centreId) return;
    if (!isDirector) { setError('Seul le directeur peut préparer une rémunération.'); return; }
    const hours = validatedSessionStats.hours;
    const hourlyRate = payrollForm.compensationMode === 'hourly' && hours > 0 ? validatedSessionStats.gross / hours : 0;
    const sessionCount = validatedSessionStats.count;
    const sessionRate = payrollForm.compensationMode === 'session' && sessionCount > 0 ? validatedSessionStats.gross / sessionCount : 0;
    const monthlySalary = payrollForm.compensationMode === 'monthly' ? Number(payrollForm.monthlySalary) : 0;
    const deduction = Number(payrollForm.advanceDeduction || 0);
    const gross = payrollForm.compensationMode === 'monthly' ? monthlySalary : validatedSessionStats.gross;
    if (payrollForm.compensationMode !== 'monthly' && (validatedSessionStats.loading || validatedSessionStats.missingRateCount > 0 || validatedSessionStats.modeMismatchCount > 0)) { setError(validatedSessionStats.loading ? 'Attendez le calcul des séances validées.' : validatedSessionStats.missingRateCount > 0 ? 'Il manque un tarif avec date d’effet pour ' + validatedSessionStats.missingRateCount + ' séance(s) validée(s).' : 'Le mode de rémunération a changé pendant la période. Séparez la paie par mode avant de valider.'); return; }
    const duplicatePayroll = payroll.find((item) => item.id !== editingPayrollId && Number(item.teacher_id) === Number(payrollForm.teacherId) && item.period_start === payrollForm.periodStart && item.period_end === payrollForm.periodEnd && item.status !== 'cancelled');
    if (duplicatePayroll) { setError('Une rémunération existe déjà pour ce formateur et ce mois. Modifiez le brouillon existant.'); return; }
    if (!payrollForm.teacherId || !payrollForm.periodStart || !payrollForm.periodEnd || gross <= 0 || (payrollForm.compensationMode === 'monthly' && monthlySalary <= 0) || payrollForm.periodStart.slice(8,10) !== '01' || payrollForm.periodEnd !== payrollForm.periodStart.slice(0,8) + String(new Date(Number(payrollForm.periodStart.slice(0,4)), Number(payrollForm.periodStart.slice(5,7)), 0).getDate()).padStart(2,'0') || payrollForm.periodEnd < payrollForm.periodStart || ![hours,hourlyRate,sessionCount,sessionRate,monthlySalary,deduction,gross].every(Number.isFinite) || [hours,hourlyRate,sessionCount,sessionRate,monthlySalary,deduction].some((value) => value < 0) || deduction > gross || deduction > advanceBalanceForPayroll(Number(payrollForm.teacherId), editingPayrollId) + 0.001) { setError('La période doit couvrir un mois civil complet (du 1er au dernier jour). Vérifiez aussi les montants : la déduction ne peut dépasser ni la rémunération brute ni le solde des avances.'); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const client = getSupabaseClient();
      const payload = { teacher_id: Number(payrollForm.teacherId), period_start: payrollForm.periodStart, period_end: payrollForm.periodEnd, compensation_mode: payrollForm.compensationMode, hours, hourly_rate: hourlyRate, session_count: sessionCount, session_rate: sessionRate, monthly_salary: monthlySalary, gross_amount: Math.round(gross * 100) / 100, advance_deduction: Math.round(deduction * 100) / 100, amount_due: Math.round((gross - deduction) * 100) / 100, notes: payrollForm.notes.trim() || null };
      let payrollId = editingPayrollId;
      if (editingPayrollId) {
        const result = await client.from('finance_teacher_payroll').update(payload).eq('id', editingPayrollId).eq('centre_id', profile.centreId).eq('status', 'draft').select('id').maybeSingle();
        if (result.error) throw result.error;
        if (!result.data?.id) throw new Error('La rémunération n’est plus modifiable ou n’existe pas.');
        payrollId = result.data.id;
      } else {
        const result = await client.from('finance_teacher_payroll').insert({ ...payload, centre_id: profile.centreId, status: 'draft', created_by: profile.id }).select('id').single();
        if (result.error) throw result.error;
        payrollId = result.data.id;
      }
      if (deduction > 0 && payrollId) {
        const { error: repaymentError } = await client.from('finance_teacher_advance_repayments').upsert({ centre_id: profile.centreId, teacher_id: Number(payrollForm.teacherId), payroll_id: payrollId, amount: Math.round(deduction * 100) / 100, status: 'active', created_by: profile.id }, { onConflict: 'centre_id,payroll_id' });
        if (repaymentError) throw new Error('Rémunération enregistrée, mais la déduction d’avance n’a pas été enregistrée : ' + repaymentError.message);
      } else if (payrollId) {
        const { error: repaymentError } = await client.from('finance_teacher_advance_repayments').update({ status: 'cancelled' }).eq('centre_id', profile.centreId).eq('payroll_id', payrollId).eq('status', 'active');
        if (repaymentError) throw repaymentError;
      }
      setNotice(editingPayrollId ? 'Rémunération modifiée.' : 'Rémunération préparée en brouillon.'); setModal(null); reload();
    } catch (cause) { setError(readableFinanceError(cause, 'Impossible d’enregistrer la rémunération.')); }
    finally { setSaving(false); }
  }

  async function saveAdvance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!profile?.centreId) return;
    if (!isDirector) { setError('Seul le directeur peut enregistrer une avance.'); return; }
    const amount = Number(advanceForm.amount);
    if (!advanceForm.teacherId || !advanceForm.advanceDate || !Number.isFinite(amount) || amount <= 0) { setError('Choisissez un formateur et saisissez une avance supérieure à 0 DH.'); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const { error } = await getSupabaseClient().from('finance_teacher_advances').insert({ centre_id: profile.centreId, teacher_id: Number(advanceForm.teacherId), amount, advance_date: advanceForm.advanceDate, notes: advanceForm.notes.trim() || null, status: 'active', created_by: profile.id });
      if (error) throw error;
      setNotice('Avance enregistrée. Elle pourra être déduite lors de la préparation d’une rémunération.');
      setAdvanceForm({ teacherId: '', amount: '', advanceDate: today(), notes: '' }); setModal(null); reload();
    } catch (cause) { setError(readableFinanceError(cause, 'Impossible d’enregistrer l’avance.')); }
    finally { setSaving(false); }
  }

  async function changePayrollStatus(item: Payroll, status: 'approved' | 'cancelled') {
    if (!profile?.centreId) return;
    if (!isDirector) { setError('Seul le directeur peut modifier ou valider les rémunérations.'); return; }
    const cancellationReason = status === 'cancelled' ? window.prompt('Motif obligatoire de l’annulation :') : null;
    if (status === 'cancelled' && !cancellationReason?.trim()) { setError('L’annulation nécessite un motif.'); return; }
    const prompt = status === 'cancelled' ? 'Confirmer l’annulation de cette rémunération ?' : 'Valider définitivement cette rémunération ?';
    if (!window.confirm(prompt)) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const client = getSupabaseClient();
      const { error } = await client.from('finance_teacher_payroll').update({ status, approved_by: status === 'approved' ? profile.id : null, cancellation_reason: status === 'cancelled' ? cancellationReason!.trim() : null }).eq('id', item.id).eq('centre_id', profile.centreId).eq('status', 'draft');
      if (error) throw error;
      if (status === 'cancelled') {
        const { error: repaymentError } = await client.from('finance_teacher_advance_repayments').update({ status: 'cancelled' }).eq('centre_id', profile.centreId).eq('payroll_id', item.id).eq('status', 'active');
        if (repaymentError) throw repaymentError;
      }
      setNotice(status === 'approved' ? 'Rémunération validée.' : 'Rémunération annulée. La déduction d’avance associée est libérée.'); reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Impossible de modifier la rémunération.'); }
    finally { setSaving(false); }
  }

  function openPayrollPayment(item: Payroll) {
    setError(null); setPayrollPaymentForm({ payrollId: item.id, amount: String(numeric(item.amount_due)), paidAt: today(), method: 'cash', reference: '', accountId: financeAccounts[0]?.id ?? '' }); setModal('payroll-payment');
  }

  async function markPayrollPaid(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!profile?.centreId || !isDirector) { setError('Seul le directeur peut enregistrer un paiement.'); return; }
    const item = payroll.find(row => row.id === payrollPaymentForm.payrollId);
    const amount = Number(payrollPaymentForm.amount);
    if (!item || !payrollPaymentForm.paidAt || !Number.isFinite(amount) || amount <= 0 || Math.abs(amount - numeric(item.amount_due)) > 0.001) { setError('Le montant payé doit correspondre exactement au net à payer.'); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const paidAt = new Date(payrollPaymentForm.paidAt + 'T12:00:00').toISOString();
      if (!payrollPaymentForm.accountId) throw new Error('Créez ou activez une caisse/un compte bancaire dans la rubrique Trésorerie avant de payer.');
      const { error } = await getSupabaseClient().rpc('finance_pay_teacher_payroll', { p_payroll_id: item.id, p_account_id: payrollPaymentForm.accountId, p_paid_at: paidAt, p_payment_method: payrollPaymentForm.method, p_payment_reference: payrollPaymentForm.reference.trim() || null });
      if (error) throw error;
      setNotice('Paiement enregistré et rémunération verrouillée.'); setModal(null); reload();
    } catch (cause) { setError(readableFinanceError(cause, 'Impossible de confirmer le paiement.')); }
    finally { setSaving(false); }
  }

  async function cancelPayrollPayment(item: Payroll) {
    if (!profile?.centreId || !isDirector || item.status !== 'paid') return;
    const reason = window.prompt('Motif obligatoire de l’annulation du paiement :');
    if (!reason?.trim() || reason.trim().length < 3) { setError('Un motif détaillé est obligatoire.'); return; }
    if (!await confirmAction('Annuler le décaissement de ' + money(numeric(item.amount_due)) + ' et conserver son historique ?')) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const { error } = await getSupabaseClient().rpc('finance_reverse_teacher_payroll_payment', { p_payroll_id: item.id, p_reason: reason.trim() });
      if (error) throw error;
      setNotice('Paiement annulé avec motif. Le mouvement inverse est tracé et la rémunération est de nouveau à payer.'); reload();
    } catch (cause) { setError(readableFinanceError(cause, 'Impossible d’annuler le paiement.')); }
    finally { setSaving(false); }
  }

  async function savePayrollAdjustment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile?.centreId || !isDirector) { setError('Seul le directeur peut créer un ajustement.'); return; }
    const amount = Number(adjustmentForm.amount);
    if (!adjustmentForm.teacherId || !Number.isFinite(amount) || amount <= 0 || !adjustmentForm.reason.trim() || (adjustmentForm.type === 'late_session' && !adjustmentForm.sourceSessionId.trim())) {
      setError('Choisissez un formateur, un montant positif, un motif et une référence de séance pour un rappel tardif.');
      return;
    }
    setSaving(true); setError(null); setNotice(null);
    try {
      const { error } = await getSupabaseClient().from('finance_teacher_payroll_adjustments').insert({
        centre_id: profile.centreId,
        teacher_id: Number(adjustmentForm.teacherId),
        adjustment_type: adjustmentForm.type,
        amount: Math.round(amount * 100) / 100,
        source_session_id: adjustmentForm.sourceSessionId.trim() || null,
        reason: adjustmentForm.reason.trim(),
        status: 'pending',
        created_by: profile.id,
      });
      if (error) throw error;
      setNotice('Ajustement enregistré en attente de validation. Il ne modifie pas une paie déjà clôturée.');
      setModal(null); reload();
    } catch (cause) { setError(readableFinanceError(cause, 'Impossible de créer l’ajustement.')); }
    finally { setSaving(false); }
  }

  async function approvePayrollAdjustment(item: PayrollAdjustment) {
    if (!profile?.centreId || !isDirector || item.status !== 'pending') return;
    if (!await confirmAction('Valider l’ajustement de ' + money(numeric(item.amount)) + ' pour ' + teacherName(item.teacher_id) + ' ?')) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const { data, error } = await getSupabaseClient().from('finance_teacher_payroll_adjustments').update({ status: 'approved', approved_by: profile.id }).eq('id', item.id).eq('centre_id', profile.centreId).eq('status', 'pending').select('id').maybeSingle();
      if (error) throw error;
      if (!data?.id) throw new Error('Cet ajustement a déjà été traité. Actualisez la liste.');
      setNotice('Ajustement validé et prêt à être payé.'); reload();
    } catch (cause) { setError(readableFinanceError(cause, 'Impossible de valider l’ajustement.')); }
    finally { setSaving(false); }
  }

  function openAdjustmentPayment(item: PayrollAdjustment) {
    setAdjustmentPaymentForm({ adjustmentId: item.id, paidAt: today(), method: 'cash', reference: '', accountId: financeAccounts.find(account => account.account_type === 'cash')?.id ?? '' });
    setError(null); setModal('adjustment-payment');
  }

  async function payPayrollAdjustment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile?.centreId || !isDirector) { setError('Seul le directeur peut payer un ajustement.'); return; }
    if (!adjustmentPaymentForm.accountId) { setError('Créez ou activez une caisse/un compte bancaire avant le paiement.'); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const { error } = await getSupabaseClient().rpc('finance_pay_teacher_adjustment', {
        p_adjustment_id: adjustmentPaymentForm.adjustmentId,
        p_account_id: adjustmentPaymentForm.accountId,
        p_paid_at: new Date(adjustmentPaymentForm.paidAt + 'T12:00:00').toISOString(),
        p_payment_method: adjustmentPaymentForm.method,
        p_payment_reference: adjustmentPaymentForm.reference.trim() || null,
      });
      if (error) throw error;
      setNotice('Ajustement payé et sortie de trésorerie enregistrée.'); setModal(null); reload();
    } catch (cause) { setError(readableFinanceError(cause, 'Impossible de payer l’ajustement.')); }
    finally { setSaving(false); }
  }

  async function saveTeacherRate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!profile?.centreId || !isDirector) { setError('Seul le directeur peut gérer les tarifs.'); return; }
    const hourlyRate = rateForm.compensationMode === 'hourly' ? Number(rateForm.hourlyRate) : 0;
    const sessionRate = rateForm.compensationMode === 'session' ? Number(rateForm.sessionRate) : 0;
    const monthlySalary = rateForm.compensationMode === 'monthly' ? Number(rateForm.monthlySalary) : 0;
    if (teacherRates.some((rate) => Number(rate.teacher_id) === Number(rateForm.teacherId) && rate.effective_from === rateForm.effectiveFrom)) { setError('Un tarif existe déjà pour ce formateur à cette date d’effet. Choisissez une autre date.'); return; }
    if (!rateForm.teacherId || !rateForm.effectiveFrom || [hourlyRate,sessionRate,monthlySalary].some(v => !Number.isFinite(v) || v < 0) || (rateForm.compensationMode === 'hourly' && hourlyRate <= 0) || (rateForm.compensationMode === 'session' && sessionRate <= 0) || (rateForm.compensationMode === 'monthly' && monthlySalary <= 0)) { setError('Choisissez un formateur, une date d’effet et un tarif positif.'); return; }
    setSaving(true); setError(null); setNotice(null);
    try { const { error } = await getSupabaseClient().from('finance_teacher_rates').insert({ centre_id: profile.centreId, teacher_id: Number(rateForm.teacherId), compensation_mode: rateForm.compensationMode, hourly_rate: hourlyRate, session_rate: sessionRate, monthly_salary: monthlySalary, effective_from: rateForm.effectiveFrom, notes: rateForm.notes.trim() || null, created_by: profile.id }); if (error) throw error; setNotice('Tarif enregistré ; les tarifs précédents sont conservés.'); setModal(null); reload(); }
    catch (cause) { setError(readableFinanceError(cause, 'Impossible d’enregistrer le tarif.')); } finally { setSaving(false); }
  }

  const metrics = [
    { label: 'Frais enregistrés', value: money(summary.charges), note: charges.length + ' frais', tone: 'brand' },
    { label: 'Recettes encaissées', value: money(summary.collected), note: payments.length + ' paiements', tone: 'positive' },
    { label: 'Reste à encaisser', value: money(outstanding), note: 'Montants restant dus', tone: 'warning' },
    { label: 'Dépenses payées', value: money(summary.expenses), note: summary.expenseCount + ' dépenses', tone: 'neutral' },
    { label: 'Rémunérations à payer', value: money(summary.payrollDue), note: summary.payrollCount + ' rémunérations validées', tone: 'neutral' },
    { label: 'Solde net indicatif', value: money(summary.collected - summary.expenses), note: 'Encaissements moins dépenses', tone: 'brand' },
  ];

  if (loading) return <LoadingState label="Chargement du tableau de bord financier…" />;

  return <section className="sp-page finance-page">
    <div className="finance-page-heading"><div><p className="sp-page-eyebrow">Gestion de l’établissement</p><h1 className="sp-page-title">Tableau de bord financier</h1><p className="sp-muted">Suivez les recettes, les dépenses, les justificatifs et les rémunérations du centre.</p></div><span className="finance-currency-pill">Devise : MAD</span></div>
    {error && <Alert tone="error"><p>{error}</p></Alert>}
    {notice && <Alert tone="success"><p>{notice}</p></Alert>}
    {profile?.role !== 'formateur' && <div className="finance-metrics-grid">{metrics.map((metric) => <article className={'finance-metric-card finance-tone-' + metric.tone} key={metric.label}><p>{metric.label}</p><strong>{metric.value}</strong><span>{metric.note}</span></article>)}</div>}

    <nav aria-label="Sous-rubriques financières" className="finance-subnav">
      {profile?.role !== 'formateur' && <button type="button" className={view === 'students' ? 'active' : ''} onClick={() => { setView('students'); setModal(null); }}> <span>01</span><b>Opérations étudiants</b><small>Frais et encaissements</small></button>}
      {profile?.role !== 'formateur' && <button type="button" className={view === 'expenses' ? 'active' : ''} onClick={() => { setView('expenses'); setModal(null); }}><span>02</span><b>Dépenses et trésorerie</b><small>Sorties, caisses et banques</small></button>}
      {profile?.role !== 'formateur' && <button type="button" className={view === 'receipts' ? 'active' : ''} onClick={() => { setView('receipts'); setModal(null); }}><span>03</span><b>Reçus et justificatifs</b><small>Historique et impression</small></button>}
      <button type="button" className={view === 'payroll' ? 'active' : ''} onClick={() => { setView('payroll'); setModal(null); }}><span>04</span><b>Paiement des formateurs</b><small>Préparer et suivre les règlements</small></button>
    </nav>

    {view === 'students' && <section className="finance-content-panel">
      <div className="finance-content-heading"><div><h2>Opérations étudiants</h2><p>Créez les frais, enregistrez les paiements partiels et suivez le reste dû.</p></div>{isDirector && <div className="finance-toolbar"><Button type="button" variant="secondary" onClick={() => { setPaymentForm({ chargeId: charges.find((c) => ['open', 'partial'].includes(c.status))?.id ?? '', amount: '', method: 'cash', reference: '', notes: '' }); setError(null); setModal('payment'); }}>+ Enregistrer un paiement</Button><Button type="button" onClick={() => openCharge()}>+ Ajouter des frais</Button></div>}</div>
      <div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Étudiant</th><th>Frais</th><th>Montant</th><th>Payé</th><th>Reste</th><th>Statut</th><th>Actions</th></tr></thead><tbody>{charges.map((charge) => { const paid = paidForCharge(charge.id); const remaining = Math.max(0, numeric(charge.amount_due) - paid); return <tr key={charge.id}><td>{studentName(charge.student_id)}</td><td>{charge.label}{charge.due_date && <small>Échéance : {charge.due_date}</small>}</td><td>{money(numeric(charge.amount_due))}</td><td>{money(paid)}</td><td>{money(remaining)}</td><td><span className={'finance-status finance-status-' + charge.status}>{charge.status === 'paid' ? 'Payé' : charge.status === 'partial' ? 'Partiel' : 'À payer'}</span></td><td>{isDirector && <div className="finance-row-actions"><Button type="button" variant="secondary" disabled={saving || charge.status === 'cancelled'} onClick={() => openCharge(charge)}>Modifier</Button><Button type="button" variant="danger" disabled={saving || charge.status === 'cancelled'} onClick={() => void cancelCharge(charge)}>Annuler</Button></div>}</td></tr>; })}{charges.length === 0 && <tr><td colSpan={7}>Aucun frais enregistré.</td></tr>}</tbody></table></div>
    </section>}

    {view === 'expenses' && <FinanceOperations onChange={reload} readOnly={!isDirector} />}
    {view === 'receipts' && <section className="finance-content-panel"><div className="finance-content-heading"><div><h2>Reçus et justificatifs</h2><p>Retrouvez chaque encaissement et imprimez un reçu à remettre à l’étudiant.</p></div></div><div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>N° reçu</th><th>Étudiant</th><th>Frais</th><th>Montant</th><th>Mode</th><th>Date</th><th>Justificatif</th></tr></thead><tbody>{payments.map((payment) => { const charge = charges.find((item) => item.id === payment.charge_id); return <tr key={payment.id}><td><strong>{payment.receipt_number}</strong></td><td>{charge ? studentName(charge.student_id) : '—'}</td><td>{charge?.label ?? 'Frais archivés'}</td><td>{money(numeric(payment.amount))}</td><td>{METHODS.find((method) => method.value === payment.payment_method)?.label ?? payment.payment_method}</td><td>{new Date(payment.paid_at).toLocaleString('fr-MA')}</td><td><Button type="button" variant="secondary" onClick={() => { const receipt = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Reçu ' + payment.receipt_number + '</title><style>body{font:16px Arial;margin:40px;color:#172033}header{border-bottom:2px solid #173b6c;padding-bottom:18px;margin-bottom:24px}h1{color:#173b6c}table{width:100%;border-collapse:collapse;margin-top:24px}td{padding:12px;border-bottom:1px solid #ddd}.amount{font-size:24px;font-weight:bold}footer{margin-top:60px;color:#667}</style></head><body><header><h1>REÇU DE PAIEMENT</h1><p>SchoolPlans · Centre de formation</p></header><p><strong>Numéro :</strong> ' + payment.receipt_number + '</p><p><strong>Date :</strong> ' + new Date(payment.paid_at).toLocaleString('fr-MA') + '</p><p><strong>Étudiant :</strong> ' + (charge ? studentName(charge.student_id) : '—') + '</p><p><strong>Objet :</strong> ' + (charge?.label ?? 'Frais de formation') + '</p><p><strong>Mode de paiement :</strong> ' + (METHODS.find((method) => method.value === payment.payment_method)?.label ?? payment.payment_method) + '</p><p class="amount">Montant reçu : ' + money(numeric(payment.amount)) + '</p>' + (payment.reference ? '<p>Référence : ' + payment.reference + '</p>' : '') + '<footer>Document généré depuis le tableau de bord financier.</footer><script>window.onload=()=>window.print()</script></body></html>'; const blob = new Blob([receipt], { type: 'text/html;charset=utf-8' }); const url = URL.createObjectURL(blob); const win = window.open(url, '_blank'); if (!win) { URL.revokeObjectURL(url); setError('Autorisez les fenêtres popup pour imprimer le reçu.'); } }}>Imprimer le reçu</Button></td></tr>; })}{payments.length === 0 && <tr><td colSpan={7}>Aucun reçu disponible.</td></tr>}</tbody></table></div><p className="finance-security-note">Les paiements restent dans l’historique pour préserver la traçabilité comptable.</p></section>}

    {view === 'payroll' && <section className="finance-content-panel"><div className="finance-content-heading"><div><h2>Paiement des formateurs</h2><p>Choisissez un mode de calcul par formateur et suivez les avances déjà versées.</p></div><div className="finance-toolbar">{isDirector && <><Button type="button" variant="secondary" onClick={() => { setRateForm({ teacherId: '', compensationMode: 'hourly', hourlyRate: '', sessionRate: '', monthlySalary: '', effectiveFrom: today(), notes: '' }); setError(null); setModal('rate'); }}>+ Ajouter un tarif</Button><Button type="button" variant="secondary" onClick={() => { setAdjustmentForm({ teacherId: '', type: 'late_session', amount: '', sourceSessionId: '', reason: '' }); setError(null); setModal('adjustment'); }}>+ Ajouter un ajustement</Button><Button type="button" variant="secondary" onClick={() => { setAdvanceForm({ teacherId: '', amount: '', advanceDate: today(), notes: '' }); setError(null); setModal('advance'); }}>+ Enregistrer une avance</Button><Button type="button" onClick={() => openPayroll()}>+ Préparer une rémunération</Button></>}</div></div><div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Formateur</th><th>Mode</th><th>Période</th><th>Brut</th><th>Avance déduite</th><th>Net à payer</th><th>Statut</th><th>Mode de paiement</th><th>Date de paiement</th><th>Référence</th><th>Actions</th></tr></thead><tbody>{payroll.map((item) => <tr key={item.id}><td>{teacherName(item.teacher_id)}</td><td>{item.compensation_mode === 'session' ? 'À la séance' : item.compensation_mode === 'monthly' ? 'Mensuel' : 'À l’heure'}</td><td>{item.period_start} → {item.period_end}</td><td>{money(numeric(item.gross_amount ?? item.amount_due))}</td><td>{money(numeric(item.advance_deduction))}</td><td>{money(numeric(item.amount_due))}</td><td><span className={'finance-status finance-status-' + item.status}>{item.status === 'draft' ? 'Brouillon' : item.status === 'approved' ? (item.payment_reversed_at ? 'Paiement annulé — à repayer' : 'Validée') : item.status === 'paid' ? 'Payée' : 'Annulée'}</span></td><td>{item.payment_method ? (METHODS.find(method => method.value === item.payment_method)?.label ?? item.payment_method) : '—'}</td><td>{item.paid_at ? new Date(item.paid_at).toLocaleDateString('fr-MA') : '—'}</td><td>{item.payment_reference || '—'}</td><td><div className="finance-row-actions">{isDirector && item.status === 'draft' && <><Button type="button" variant="secondary" disabled={saving} onClick={() => openPayroll(item)}>Modifier</Button><Button type="button" variant="secondary" disabled={saving} onClick={() => void changePayrollStatus(item, 'cancelled')}>Annuler</Button><Button type="button" disabled={saving} onClick={() => void changePayrollStatus(item, 'approved')}>Valider</Button></>}{isDirector && item.status === 'approved' && <Button type="button" disabled={saving} onClick={() => openPayrollPayment(item)}>Enregistrer le paiement</Button>}{isDirector && item.status === 'paid' && <Button type="button" variant="danger" disabled={saving} onClick={() => void cancelPayrollPayment(item)}>Annuler le paiement</Button>}{item.payment_reversed_at && <small>Annulé le {new Date(item.payment_reversed_at).toLocaleDateString('fr-MA')} : {item.payment_reversal_reason}</small>}</div></td></tr>)}{payroll.length === 0 && <tr><td colSpan={11}>Aucune rémunération préparée.</td></tr>}</tbody></table></div>{profile?.role !== 'formateur' && <div className="finance-table-wrap"><h3>Avances versées</h3><table className="finance-table"><thead><tr><th>Formateur</th><th>Date</th><th>Montant</th><th>Solde total d’avance du formateur</th><th>Notes</th></tr></thead><tbody>{advances.filter((item) => item.status === 'active').map((item) => <tr key={item.id}><td>{teacherName(item.teacher_id)}</td><td>{item.advance_date}</td><td>{money(numeric(item.amount))}</td><td>{money(advanceBalance(item.teacher_id))}</td><td>{item.notes || '—'}</td></tr>)}{advances.filter((item) => item.status === 'active').length === 0 && <tr><td colSpan={5}>Aucune avance enregistrée.</td></tr>}</tbody></table></div>}<div className="finance-table-wrap"><h3>Historique des tarifs</h3><table className="finance-table"><thead><tr><th>Formateur</th><th>Mode</th><th>Tarif horaire</th><th>Tarif séance</th><th>Salaire mensuel</th><th>Date d’effet</th></tr></thead><tbody>{teacherRates.map(rate => <tr key={rate.id}><td>{teacherName(rate.teacher_id)}</td><td>{rate.compensation_mode === 'session' ? 'À la séance' : rate.compensation_mode === 'monthly' ? 'Mensuel' : 'À l’heure'}</td><td>{rate.compensation_mode === 'hourly' ? money(numeric(rate.hourly_rate)) : '—'}</td><td>{rate.compensation_mode === 'session' ? money(numeric(rate.session_rate)) : '—'}</td><td>{rate.compensation_mode === 'monthly' ? money(numeric(rate.monthly_salary)) : '—'}</td><td>{rate.effective_from}</td></tr>)}{teacherRates.length === 0 && <tr><td colSpan={6}>Aucun tarif enregistré.</td></tr>}</tbody></table></div>{profile?.role !== 'formateur' && <div className="finance-table-wrap"><h3>Ajustements exceptionnels et séances tardives</h3><table className="finance-table"><thead><tr><th>Formateur</th><th>Type</th><th>Référence séance</th><th>Montant</th><th>Motif</th><th>Statut</th><th>Paiement</th><th>Actions</th></tr></thead><tbody>{adjustments.map(item => <tr key={item.id}><td>{teacherName(item.teacher_id)}</td><td>{item.adjustment_type === 'late_session' ? 'Séance validée tardivement' : item.adjustment_type === 'exceptional_payment' ? 'Paiement exceptionnel' : item.adjustment_type === 'correction' ? 'Correction' : 'Annulation / contrepassation'}</td><td>{item.source_session_id || '—'}</td><td>{money(numeric(item.amount))}</td><td>{item.reason}</td><td>{item.status === 'pending' ? 'À valider' : item.status === 'approved' ? 'À payer' : item.status === 'paid' ? 'Payé' : 'Annulé'}</td><td>{item.paid_at ? (METHODS.find(method => method.value === item.payment_method)?.label ?? item.payment_method ?? '—') + ' · ' + new Date(item.paid_at).toLocaleDateString('fr-MA') : '—'}</td><td>{isDirector && item.status === 'pending' && <Button type="button" disabled={saving} onClick={() => void approvePayrollAdjustment(item)}>Valider</Button>}{isDirector && item.status === 'approved' && <Button type="button" disabled={saving} onClick={() => openAdjustmentPayment(item)}>Payer</Button>}</td></tr>)}{adjustments.length === 0 && <tr><td colSpan={8}>Aucun ajustement enregistré.</td></tr>}</tbody></table></div>}<p className="finance-security-note">Les tarifs sont historisés ; vérifiez les changements de tarif à l’intérieur d’une même période mensuelle. {isDirector ? 'Seul le directeur peut modifier et valider.' : 'Mode consultation : aucune modification de rémunération n’est disponible.'}</p></section>}

    {modal === 'charge' && <Popup title={editingChargeId ? 'Modifier les frais' : 'Ajouter des frais'} onClose={() => setModal(null)}><form className="finance-modal-form" onSubmit={(event) => void saveCharge(event)}>
      <label className="sp-form-field">Étudiant<select className="sp-field" required value={chargeForm.studentId} onChange={(event) => setChargeForm((v) => ({ ...v, studentId: event.target.value }))}><option value="">Sélectionner un étudiant</option>{students.map((student) => <option key={student.id} value={student.id}>{student.prenom} {student.nom}</option>)}</select></label>
      <label className="sp-form-field">Libellé<input className="sp-field" required maxLength={120} value={chargeForm.label} onChange={(event) => setChargeForm((v) => ({ ...v, label: event.target.value }))} /></label>
      <label className="sp-form-field">Montant (DH)<input className="sp-field" required min="0.01" step="0.01" type="number" value={chargeForm.amount} onChange={(event) => setChargeForm((v) => ({ ...v, amount: event.target.value }))} /></label>
      <label className="sp-form-field">Date limite (facultative)<input className="sp-field" type="date" value={chargeForm.dueDate} onChange={(event) => setChargeForm((v) => ({ ...v, dueDate: event.target.value }))} /></label>
      <label className="sp-form-field">Notes (facultatif)<textarea className="sp-field" rows={2} value={chargeForm.notes} onChange={(event) => setChargeForm((v) => ({ ...v, notes: event.target.value }))} /></label>
      <div className="finance-modal-actions"><Button type="button" variant="secondary" onClick={() => setModal(null)}>Annuler</Button><Button type="submit" disabled={saving || students.length === 0}>{saving ? 'Enregistrement…' : 'Enregistrer'}</Button></div>
    </form></Popup>}

    {modal === 'payment' && <Popup title="Enregistrer un paiement" onClose={() => setModal(null)}><form className="finance-modal-form" onSubmit={(event) => void recordPayment(event)}>
      <label className="sp-form-field">Frais de l’étudiant<select className="sp-field" required value={paymentForm.chargeId} onChange={(event) => setPaymentForm((v) => ({ ...v, chargeId: event.target.value }))}><option value="">Sélectionner des frais</option>{charges.filter((charge) => ['open', 'partial'].includes(charge.status)).map((charge) => <option key={charge.id} value={charge.id}>{studentName(charge.student_id)} — {charge.label} (reste {money(Math.max(0, numeric(charge.amount_due) - paidForCharge(charge.id)))})</option>)}</select></label>
      <label className="sp-form-field">Montant reçu (DH)<input className="sp-field" required min="0.01" step="0.01" type="number" value={paymentForm.amount} onChange={(event) => setPaymentForm((v) => ({ ...v, amount: event.target.value }))} /></label>
      <label className="sp-form-field">Mode de paiement<select className="sp-field" value={paymentForm.method} onChange={(event) => setPaymentForm((v) => ({ ...v, method: event.target.value }))}>{METHODS.map((method) => <option key={method.value} value={method.value}>{method.label}</option>)}</select></label>
      <label className="sp-form-field">Référence (facultative)<input className="sp-field" value={paymentForm.reference} onChange={(event) => setPaymentForm((v) => ({ ...v, reference: event.target.value }))} /></label>
      <label className="sp-form-field">Notes (facultatif)<textarea className="sp-field" rows={2} value={paymentForm.notes} onChange={(event) => setPaymentForm((v) => ({ ...v, notes: event.target.value }))} /></label>
      <div className="finance-modal-actions"><Button type="button" variant="secondary" onClick={() => setModal(null)}>Annuler</Button><Button type="submit" disabled={saving || !charges.some((charge) => ['open', 'partial'].includes(charge.status))}>{saving ? 'Enregistrement…' : 'Enregistrer le paiement'}</Button></div>
    </form></Popup>}

    {modal === 'payroll' && <Popup title={editingPayrollId ? 'Modifier la rémunération' : 'Préparer une rémunération'} onClose={() => setModal(null)}><form className="finance-modal-form" onSubmit={(event) => void savePayroll(event)}>
      <label className="sp-form-field">Formateur<select className="sp-field" required value={payrollForm.teacherId} onChange={(event) => { const teacherId = event.target.value; const previous = payroll.find((item) => String(item.teacher_id) === teacherId && item.period_start === payrollForm.periodStart); const rate = teacherRates.filter((item) => String(item.teacher_id) === teacherId && item.effective_from <= payrollForm.periodStart).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0]; setPayrollForm((v) => ({ ...v, teacherId, compensationMode: previous?.compensation_mode ?? rate?.compensation_mode ?? v.compensationMode, hours: previous ? String(previous.hours) : v.hours, hourlyRate: previous ? String(previous.hourly_rate) : rate?.compensation_mode === 'hourly' ? String(rate.hourly_rate) : v.hourlyRate, sessionCount: previous ? String(previous.session_count ?? 0) : v.sessionCount, sessionRate: previous ? String(previous.session_rate ?? 0) : rate?.compensation_mode === 'session' ? String(rate.session_rate) : v.sessionRate, monthlySalary: previous ? String(previous.monthly_salary ?? 0) : rate?.compensation_mode === 'monthly' ? String(rate.monthly_salary) : v.monthlySalary, advanceDeduction: String(advanceBalanceForPayroll(Number(teacherId), editingPayrollId)) })); }}><option value="">Sélectionner un formateur</option>{teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.nom}</option>)}</select></label>
      <div className="finance-modal-grid"><label className="sp-form-field">Début de période<input className="sp-field" required type="date" value={payrollForm.periodStart} onChange={(event) => setPayrollForm((v) => { const selectedDate = event.target.value; const periodStart = selectedDate ? selectedDate.slice(0, 7) + '-01' : ''; const periodEnd = periodStart ? lastDayOfMonth(periodStart) : v.periodEnd; const rate = teacherRates.filter((item) => String(item.teacher_id) === v.teacherId && item.effective_from <= periodStart).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0]; return { ...v, periodStart, periodEnd, compensationMode: rate?.compensation_mode ?? v.compensationMode, hourlyRate: rate?.compensation_mode === 'hourly' ? String(rate.hourly_rate) : v.hourlyRate, sessionRate: rate?.compensation_mode === 'session' ? String(rate.session_rate) : v.sessionRate, monthlySalary: rate?.compensation_mode === 'monthly' ? String(rate.monthly_salary) : v.monthlySalary }; })} /></label><label className="sp-form-field">Fin de période<input className="sp-field" required type="date" value={payrollForm.periodEnd} onChange={(event) => setPayrollForm((v) => ({ ...v, periodEnd: event.target.value }))} /></label></div>
      <label className="sp-form-field">Mode de rémunération<select className="sp-field" value={payrollForm.compensationMode} onChange={(event) => setPayrollForm((v) => ({ ...v, compensationMode: event.target.value }))}><option value="hourly">À l’heure</option><option value="session">À la séance</option><option value="monthly">Salaire mensuel</option></select></label>
      {payrollForm.compensationMode === 'hourly' && <div className="finance-modal-grid"><div className="sp-form-field"><label>Heures validées</label><strong>{validatedSessionStats.loading ? 'Calcul…' : validatedSessionStats.hours.toFixed(2) + ' h'}</strong></div><div className="sp-form-field"><label>Tarif moyen pondéré</label><strong>{validatedSessionStats.hours > 0 ? money(validatedSessionStats.gross / validatedSessionStats.hours) + '/h' : '—'}</strong></div></div>}
      {payrollForm.compensationMode === 'session' && <div className="finance-modal-grid"><div className="sp-form-field"><label>Séances validées</label><strong>{validatedSessionStats.loading ? 'Calcul…' : String(validatedSessionStats.count)}</strong></div><div className="sp-form-field"><label>Tarif moyen par séance</label><strong>{validatedSessionStats.count > 0 ? money(validatedSessionStats.gross / validatedSessionStats.count) : '—'}</strong></div></div>}
      {payrollForm.compensationMode === 'monthly' && <label className="sp-form-field">Salaire mensuel (DH)<input className="sp-field" required readOnly type="number" min="0.01" step="0.01" value={payrollForm.monthlySalary} /><small className="sp-muted">Salaire fixe configuré dans le tarif en vigueur au premier jour du mois.</small></label>}
      <label className="sp-form-field">Avance à déduire (DH)<input className="sp-field" type="number" min="0" step="0.01" max={payrollGross} value={payrollForm.advanceDeduction} onChange={(event) => setPayrollForm((v) => ({ ...v, advanceDeduction: event.target.value }))} /><small className="sp-muted">Avances restant à récupérer pour ce formateur : {money(advanceBalance(Number(payrollForm.teacherId)))}</small></label>
      <p className="finance-payroll-estimate">{payrollForm.compensationMode !== 'monthly' && validatedSessionStats.loading ? 'Calcul des séances validées…' : null}Brut : <strong>{money(payrollGross)}</strong> · Net à payer : <strong>{money(payrollNet)}</strong></p>{payrollForm.compensationMode !== 'monthly' && validatedSessionStats.rateSummary.length > 0 && <p className="sp-muted">Tarifs appliqués selon la date de chaque séance : {validatedSessionStats.rateSummary.join(' · ')}</p>}
      <label className="sp-form-field">Notes (facultatif)<textarea className="sp-field" rows={2} value={payrollForm.notes} onChange={(event) => setPayrollForm((v) => ({ ...v, notes: event.target.value }))} /></label>
      <div className="finance-modal-actions"><Button type="button" variant="secondary" onClick={() => setModal(null)}>Annuler</Button><Button type="submit" disabled={saving || teachers.length === 0 || validatedSessionStats.loading || (payrollForm.compensationMode !== 'monthly' && (validatedSessionStats.missingRateCount > 0 || validatedSessionStats.modeMismatchCount > 0))}>{saving ? 'Enregistrement…' : 'Enregistrer en brouillon'}</Button></div>
    </form></Popup>}
    {modal === 'payroll-payment' && <Popup title="Enregistrer le paiement du formateur" onClose={() => setModal(null)}><form className="finance-modal-form" onSubmit={(event) => void markPayrollPaid(event)}><label className="sp-form-field">Montant payé (DH)<input className="sp-field" required type="number" min="0.01" step="0.01" value={payrollPaymentForm.amount} onChange={(event) => setPayrollPaymentForm(v => ({ ...v, amount: event.target.value }))} /></label><label className="sp-form-field">Date du paiement<input className="sp-field" required type="date" value={payrollPaymentForm.paidAt} onChange={(event) => setPayrollPaymentForm(v => ({ ...v, paidAt: event.target.value }))} /></label><label className="sp-form-field">Caisse / compte bancaire<select className="sp-field" required value={payrollPaymentForm.accountId} onChange={(event) => setPayrollPaymentForm(v => ({ ...v, accountId: event.target.value }))}><option value="">Sélectionner un compte</option>{financeAccounts.filter(account => payrollPaymentForm.method === 'cash' ? account.account_type === 'cash' : ['bank_transfer','card','cheque'].includes(payrollPaymentForm.method) ? account.account_type === 'bank' : true).map(account => <option key={account.id} value={account.id}>{account.name} — {account.account_type === 'cash' ? 'Caisse' : 'Banque'}</option>)}</select>{financeAccounts.length === 0 && <small className="sp-muted">Aucun compte actif. Créez-en un dans Dépenses et trésorerie.</small>}</label><label className="sp-form-field">Mode de paiement<select className="sp-field" value={payrollPaymentForm.method} onChange={(event) => setPayrollPaymentForm(v => { const method = event.target.value; const requiredType = method === 'cash' ? 'cash' : ['bank_transfer','card','cheque'].includes(method) ? 'bank' : null; const account = financeAccounts.find(item => !requiredType || item.account_type === requiredType); return { ...v, method, accountId: requiredType ? account?.id ?? '' : v.accountId }; })}>{METHODS.map(method => <option key={method.value} value={method.value}>{method.label}</option>)}</select></label><label className="sp-form-field">Référence / reçu (facultatif)<input className="sp-field" value={payrollPaymentForm.reference} onChange={(event) => setPayrollPaymentForm(v => ({ ...v, reference: event.target.value }))} /></label><div className="finance-modal-actions"><Button type="button" variant="secondary" onClick={() => setModal(null)}>Annuler</Button><Button type="submit" disabled={saving || !isDirector || financeAccounts.length === 0}>{saving ? 'Enregistrement…' : 'Confirmer et verrouiller'}</Button></div></form></Popup>}
    {modal === 'adjustment' && <Popup title="Créer un ajustement exceptionnel" onClose={() => setModal(null)}><form className="finance-modal-form" onSubmit={(event) => void savePayrollAdjustment(event)}><label className="sp-form-field">Formateur<select className="sp-field" required value={adjustmentForm.teacherId} onChange={(event) => setAdjustmentForm(v => ({ ...v, teacherId: event.target.value }))}><option value="">Sélectionner un formateur</option>{teachers.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.nom}</option>)}</select></label><label className="sp-form-field">Type d’ajustement<select className="sp-field" value={adjustmentForm.type} onChange={(event) => setAdjustmentForm(v => ({ ...v, type: event.target.value as PayrollAdjustment['adjustment_type'] }))}><option value="late_session">Séance validée après clôture</option><option value="exceptional_payment">Paiement exceptionnel (ex. séance annulée autorisée)</option><option value="correction">Correction exceptionnelle</option></select></label>{adjustmentForm.type === 'late_session' && <label className="sp-form-field">Référence de séance (cours_id|date)<input className="sp-field" required value={adjustmentForm.sourceSessionId} onChange={(event) => setAdjustmentForm(v => ({ ...v, sourceSessionId: event.target.value }))} placeholder="ex. 123|2026-10-17" /></label>}<label className="sp-form-field">Montant exceptionnel (DH)<input className="sp-field" required type="number" min="0.01" step="0.01" value={adjustmentForm.amount} onChange={(event) => setAdjustmentForm(v => ({ ...v, amount: event.target.value }))} /></label><label className="sp-form-field">Motif obligatoire<textarea className="sp-field" rows={3} required minLength={3} value={adjustmentForm.reason} onChange={(event) => setAdjustmentForm(v => ({ ...v, reason: event.target.value }))} /></label><div className="finance-modal-actions"><Button type="button" variant="secondary" onClick={() => setModal(null)}>Annuler</Button><Button type="submit" disabled={saving || !isDirector}>{saving ? 'Enregistrement…' : 'Soumettre pour validation'}</Button></div></form></Popup>}
    {modal === 'adjustment-payment' && <Popup title="Payer un ajustement" onClose={() => setModal(null)}><form className="finance-modal-form" onSubmit={(event) => void payPayrollAdjustment(event)}><label className="sp-form-field">Date du paiement<input className="sp-field" required type="date" value={adjustmentPaymentForm.paidAt} onChange={(event) => setAdjustmentPaymentForm(v => ({ ...v, paidAt: event.target.value }))} /></label><label className="sp-form-field">Mode de paiement<select className="sp-field" value={adjustmentPaymentForm.method} onChange={(event) => setAdjustmentPaymentForm(v => { const method = event.target.value; const requiredType = method === 'cash' ? 'cash' : ['bank_transfer','card','cheque'].includes(method) ? 'bank' : null; const account = financeAccounts.find(item => !requiredType || item.account_type === requiredType); return { ...v, method, accountId: requiredType ? account?.id ?? '' : v.accountId }; })}>{METHODS.map(method => <option key={method.value} value={method.value}>{method.label}</option>)}</select></label><label className="sp-form-field">Caisse / compte<select className="sp-field" required value={adjustmentPaymentForm.accountId} onChange={(event) => setAdjustmentPaymentForm(v => ({ ...v, accountId: event.target.value }))}><option value="">Sélectionner un compte</option>{financeAccounts.filter(account => adjustmentPaymentForm.method === 'cash' ? account.account_type === 'cash' : ['bank_transfer','card','cheque'].includes(adjustmentPaymentForm.method) ? account.account_type === 'bank' : true).map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><label className="sp-form-field">Référence / reçu (facultatif)<input className="sp-field" value={adjustmentPaymentForm.reference} onChange={(event) => setAdjustmentPaymentForm(v => ({ ...v, reference: event.target.value }))} /></label><div className="finance-modal-actions"><Button type="button" variant="secondary" onClick={() => setModal(null)}>Annuler</Button><Button type="submit" disabled={saving || !isDirector || !financeAccounts.length}>{saving ? 'Paiement…' : 'Confirmer le paiement'}</Button></div></form></Popup>}
    {modal === 'rate' && <Popup title="Ajouter un tarif formateur" onClose={() => setModal(null)}><form className="finance-modal-form" onSubmit={(event) => void saveTeacherRate(event)}><label className="sp-form-field">Formateur<select className="sp-field" required value={rateForm.teacherId} onChange={(event) => setRateForm(v => ({ ...v, teacherId: event.target.value }))}><option value="">Sélectionner un formateur</option>{teachers.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.nom}</option>)}</select></label><label className="sp-form-field">Mode de rémunération<select className="sp-field" value={rateForm.compensationMode} onChange={(event) => setRateForm(v => ({ ...v, compensationMode: event.target.value }))}><option value="hourly">À l’heure</option><option value="session">À la séance</option><option value="monthly">Salaire mensuel</option></select></label>{rateForm.compensationMode === 'hourly' && <label className="sp-form-field">Tarif horaire (DH)<input className="sp-field" required type="number" min="0.01" step="0.01" value={rateForm.hourlyRate} onChange={(event) => setRateForm(v => ({ ...v, hourlyRate: event.target.value }))} /></label>}{rateForm.compensationMode === 'session' && <label className="sp-form-field">Tarif par séance (DH)<input className="sp-field" required type="number" min="0.01" step="0.01" value={rateForm.sessionRate} onChange={(event) => setRateForm(v => ({ ...v, sessionRate: event.target.value }))} /></label>}{rateForm.compensationMode === 'monthly' && <label className="sp-form-field">Salaire mensuel (DH)<input className="sp-field" required type="number" min="0.01" step="0.01" value={rateForm.monthlySalary} onChange={(event) => setRateForm(v => ({ ...v, monthlySalary: event.target.value }))} /></label>}<label className="sp-form-field">Date d’effet<input className="sp-field" required type="date" value={rateForm.effectiveFrom} onChange={(event) => setRateForm(v => ({ ...v, effectiveFrom: event.target.value }))} /></label><label className="sp-form-field">Notes (facultatif)<textarea className="sp-field" rows={2} value={rateForm.notes} onChange={(event) => setRateForm(v => ({ ...v, notes: event.target.value }))} /></label><div className="finance-modal-actions"><Button type="button" variant="secondary" onClick={() => setModal(null)}>Annuler</Button><Button type="submit" disabled={saving || !isDirector}>{saving ? 'Enregistrement…' : 'Enregistrer le tarif'}</Button></div></form></Popup>}
    {modal === 'advance' && <Popup title="Enregistrer une avance au formateur" onClose={() => setModal(null)}><form className="finance-modal-form" onSubmit={(event) => void saveAdvance(event)}>
      <label className="sp-form-field">Formateur<select className="sp-field" required value={advanceForm.teacherId} onChange={(event) => setAdvanceForm((v) => ({ ...v, teacherId: event.target.value }))}><option value="">Sélectionner un formateur</option>{teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.nom}</option>)}</select></label>
      <label className="sp-form-field">Montant de l’avance (DH)<input className="sp-field" required type="number" min="0.01" step="0.01" value={advanceForm.amount} onChange={(event) => setAdvanceForm((v) => ({ ...v, amount: event.target.value }))} /></label>
      <label className="sp-form-field">Date<input className="sp-field" required type="date" value={advanceForm.advanceDate} onChange={(event) => setAdvanceForm((v) => ({ ...v, advanceDate: event.target.value }))} /></label>
      <label className="sp-form-field">Notes (facultatif)<textarea className="sp-field" rows={2} value={advanceForm.notes} onChange={(event) => setAdvanceForm((v) => ({ ...v, notes: event.target.value }))} /></label>
      <div className="finance-modal-actions"><Button type="button" variant="secondary" onClick={() => setModal(null)}>Annuler</Button><Button type="submit" disabled={saving || teachers.length === 0}>{saving ? 'Enregistrement…' : 'Enregistrer l’avance'}</Button></div>
    </form></Popup>}
    <p className="finance-security-note">{isDirector ? 'Les actions de gestion financière sont réservées au directeur du centre.' : isFinanceReader ? 'Mode consultation : votre rôle permet de consulter les données financières, sans modification ni validation.' : profile?.role === 'formateur' ? 'Espace formateur : seules vos rémunérations, vos tarifs et votre historique personnel sont visibles.' : 'Accès financier réservé au directeur et à l’administrateur du centre.'} Les opérations sont isolées par établissement.</p>
  </section>;
}
