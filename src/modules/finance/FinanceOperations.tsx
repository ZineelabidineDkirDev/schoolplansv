import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Button, LoadingState } from '../../components/ui';
import { getSupabaseClient } from '../../data/supabase/client';
import { useAuth } from '../auth/AuthProvider';

type Expense = { id: string; label: string; category: string; supplier: string | null; amount: number | string; expense_date: string; due_date: string | null; status: 'pending' | 'approved' | 'paid' | 'rejected'; payment_method: string | null; notes: string | null; paid_at: string | null };
type Account = { id: string; name: string; account_type: 'cash' | 'bank'; opening_balance: number | string; active: boolean };
type Movement = { id: string; account_id: string; movement_type: 'inflow' | 'outflow' | 'transfer_in' | 'transfer_out' | 'adjustment'; amount: number | string; movement_date: string; description: string; transfer_group_id: string | null };

function OperationsModal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="finance-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section aria-modal="true" className="finance-modal" role="dialog">
      <header className="finance-modal-header"><div><p className="sp-page-eyebrow">Dépenses et trésorerie</p><h2>{title}</h2></div><button type="button" className="finance-modal-close" aria-label="Fermer" onClick={onClose}>×</button></header>
      {children}
    </section>
  </div>;
}

const CATEGORIES = ['Loyer', 'Eau et électricité', 'Internet et téléphone', 'Achats et fournitures', 'Maintenance et réparation', 'Salaires et rémunérations', 'Transport', 'Impôts et taxes', 'Autre'];
const money = (n: number) => new Intl.NumberFormat('fr-MA', { style: 'currency', currency: 'MAD', maximumFractionDigits: 2 }).format(n);
const num = (v: number | string | null | undefined) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const today = () => new Date().toISOString().slice(0, 10);
const movementLabel = (type: Movement['movement_type']) => ({ inflow: 'Entrée', outflow: 'Sortie', transfer_in: 'Transfert reçu', transfer_out: 'Transfert envoyé', adjustment: 'Ajustement' }[type]);

function readableFinanceError(cause: unknown, fallback: string): string {
  if (cause && typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string') {
    const details = 'details' in cause && typeof cause.details === 'string' ? cause.details : '';
    const code = 'code' in cause && typeof cause.code === 'string' ? ' [' + cause.code + ']' : '';
    return cause.message + code + (details ? ' — ' + details : '');
  }
  return cause instanceof Error ? cause.message : fallback;
}


export function FinanceOperations({ onChange, readOnly = false }: { onChange: () => void; readOnly?: boolean }) {
  const { profile } = useAuth();
  const isDirector = ['director', 'directeur'].includes(String(profile?.role ?? '').toLowerCase()) && !readOnly;
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [section, setSection] = useState<'expenses' | 'treasury'>('expenses');
  const [modal, setModal] = useState<'expense' | 'account' | 'movement' | 'transfer' | null>(null);
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [expenseForm, setExpenseForm] = useState({ label: '', category: 'Loyer', supplier: '', amount: '', expenseDate: today(), dueDate: '', notes: '' });
  const [accountForm, setAccountForm] = useState({ name: '', accountType: 'cash' as 'cash' | 'bank', openingBalance: '0' });
  const [movementForm, setMovementForm] = useState({ accountId: '', movementType: 'inflow' as 'inflow' | 'outflow', amount: '', date: today(), description: '', destinationId: '' });
  const [paymentAccountId, setPaymentAccountId] = useState('');
  const reload = useCallback(() => setReloadKey((v) => v + 1), []);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!profile?.centreId) { setError('Votre compte n’est pas rattaché à un établissement.'); setLoading(false); return; }
      setLoading(true); setError(null);
      try {
        const client = getSupabaseClient();
        const results = await Promise.all([
          client.from('finance_expenses').select('id,label,category,supplier,amount,expense_date,due_date,status,payment_method,notes,paid_at').eq('centre_id', profile.centreId).order('expense_date', { ascending: false }),
          client.from('finance_accounts').select('id,name,account_type,opening_balance,active').eq('centre_id', profile.centreId).order('created_at'),
          client.from('finance_account_movements').select('id,account_id,movement_type,amount,movement_date,description,transfer_group_id').eq('centre_id', profile.centreId).order('movement_date', { ascending: false }),
        ]);
        const failed = results.find((r) => r.error);
        if (failed?.error) throw failed.error;
        if (!active) return;
        const nextAccounts = (results[1].data ?? []) as Account[];
        setExpenses((results[0].data ?? []) as Expense[]);
        setAccounts(nextAccounts);
        setMovements((results[2].data ?? []) as Movement[]);
        setPaymentAccountId((v) => v || nextAccounts.find((a) => a.active)?.id || '');
        setMovementForm((v) => ({ ...v, accountId: v.accountId || nextAccounts.find((a) => a.active)?.id || '', destinationId: v.destinationId || nextAccounts.find((a) => a.active)?.id || '' }));
      } catch (e) { if (active) setError(readableFinanceError(e, 'Impossible de charger les données.')); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [profile?.centreId, reloadKey]);

  const activeAccounts = useMemo(() => accounts.filter((a) => a.active), [accounts]);
  const balanceFor = useCallback((account: Account) => num(account.opening_balance) + movements.filter((m) => m.account_id === account.id).reduce((sum, m) => {
    const amount = num(m.amount);
    return ['inflow', 'transfer_in', 'adjustment'].includes(m.movement_type) ? sum + amount : sum - amount;
  }, 0), [movements]);
  const cashTotal = activeAccounts.filter((a) => a.account_type === 'cash').reduce((s, a) => s + balanceFor(a), 0);
  const bankTotal = activeAccounts.filter((a) => a.account_type === 'bank').reduce((s, a) => s + balanceFor(a), 0);
  const pendingTotal = expenses.filter((e) => e.status === 'pending' || e.status === 'approved').reduce((s, e) => s + num(e.amount), 0);
  const paidTotal = expenses.filter((e) => e.status === 'paid').reduce((s, e) => s + num(e.amount), 0);

  async function createExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!profile?.centreId) return;
    if (!isDirector) { setError('Mode consultation : seul le directeur peut effectuer cette opération.'); return; }
    const amount = Number(expenseForm.amount);
    if (!expenseForm.label.trim() || !Number.isFinite(amount) || amount <= 0) { setError('Saisissez un libellé et un montant supérieur à 0 DH.'); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const client = getSupabaseClient();
      const payload = { label: expenseForm.label.trim(), category: expenseForm.category, supplier: expenseForm.supplier.trim() || null, amount, expense_date: expenseForm.expenseDate || today(), due_date: expenseForm.dueDate || null, notes: expenseForm.notes.trim() || null };
      const result = editingExpenseId
        ? await client.from('finance_expenses').update(payload).eq('id', editingExpenseId).eq('centre_id', profile.centreId).eq('status', 'pending')
        : await client.from('finance_expenses').insert({ ...payload, centre_id: profile.centreId, status: 'pending', created_by: profile.id });
      if (result.error) throw result.error;
      setExpenseForm({ label: '', category: 'Loyer', supplier: '', amount: '', expenseDate: today(), dueDate: '', notes: '' });
      setEditingExpenseId(null); setModal(null);
      setNotice(editingExpenseId ? 'Dépense modifiée.' : 'Dépense enregistrée comme « à valider ». La trésorerie reste inchangée.'); reload(); onChange();
    } catch (e) { setError(readableFinanceError(e, 'Impossible d’enregistrer la dépense.')); }
    finally { setSaving(false); }
  }

  async function changeExpenseStatus(expense: Expense, status: 'approved' | 'rejected') {
    if (!profile?.centreId) return;
    if (!isDirector) { setError('Mode consultation : seul le directeur peut effectuer cette opération.'); return; }
    if (status === 'rejected' && !window.confirm('Supprimer cette dépense en la marquant comme refusée ? Son historique sera conservé.')) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const { error } = await getSupabaseClient().from('finance_expenses').update({ status, approved_by: status === 'approved' ? profile.id : null }).eq('id', expense.id).eq('centre_id', profile.centreId).eq('status', 'pending');
      if (error) throw error;
      setNotice(status === 'approved' ? 'Dépense validée.' : 'Dépense refusée.'); reload(); onChange();
    } catch (e) { setError(readableFinanceError(e, 'Impossible de modifier le statut.')); }
    finally { setSaving(false); }
  }

  async function payExpense(expense: Expense) {
    if (!profile?.centreId) return;
    if (!isDirector) { setError('Mode consultation : seul le directeur peut effectuer cette opération.'); return; }
    const account = activeAccounts.find((a) => a.id === paymentAccountId);
    if (!account) { setError('Sélectionnez une caisse ou un compte actif.'); return; }
    if (num(expense.amount) > balanceFor(account) + 0.001) { setError('Solde insuffisant dans « ' + account.name + ' » (' + money(balanceFor(account)) + ').'); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const { error: payError } = await getSupabaseClient().rpc('finance_pay_expense', { p_expense_id: expense.id, p_account_id: account.id });
      if (payError) throw payError;
      setNotice('Dépense payée depuis « ' + account.name + ' ». Le statut et le mouvement de trésorerie ont été enregistrés ensemble.'); reload(); onChange();
    } catch (e) { setError(readableFinanceError(e, 'Impossible de payer la dépense.')); }
    finally { setSaving(false); }
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!profile?.centreId) return;
    if (!isDirector) { setError('Mode consultation : seul le directeur peut effectuer cette opération.'); return; }
    const opening = Number(accountForm.openingBalance);
    if (!accountForm.name.trim() || !Number.isFinite(opening) || opening < 0) { setError('Saisissez un nom et un solde initial positif ou nul.'); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const client = getSupabaseClient();
      const result = editingAccountId
        ? await client.from('finance_accounts').update({ name: accountForm.name.trim() }).eq('id', editingAccountId).eq('centre_id', profile.centreId).eq('active', true)
        : await client.from('finance_accounts').insert({ centre_id: profile.centreId, name: accountForm.name.trim(), account_type: accountForm.accountType, opening_balance: opening, currency: 'MAD', created_by: profile.id });
      if (result.error) throw result.error;
      setAccountForm({ name: '', accountType: 'cash', openingBalance: '0' }); setEditingAccountId(null); setModal(null);
      setNotice(editingAccountId ? 'Nom du compte modifié.' : 'Caisse/compte créé avec succès.'); reload(); onChange();
    } catch (e) { setError(readableFinanceError(e, 'Impossible de créer le compte.')); }
    finally { setSaving(false); }
  }

  async function deactivateAccount(account: Account) {
    if (!profile?.centreId || !isDirector) { setError('Seul le directeur peut désactiver un compte.'); return; }
    if (!window.confirm('Désactiver « ' + account.name + ' » ? Son historique sera conservé.')) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const { error } = await getSupabaseClient().from('finance_accounts').update({ active: false }).eq('id', account.id).eq('centre_id', profile.centreId).eq('active', true);
      if (error) throw error;
      setNotice('Compte désactivé. Les mouvements existants restent consultables.'); reload(); onChange();
    } catch (e) { setError(readableFinanceError(e, 'Impossible de désactiver le compte.')); }
    finally { setSaving(false); }
  }

  async function createMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!profile?.centreId) return;
    if (!isDirector) { setError('Mode consultation : seul le directeur peut effectuer cette opération.'); return; }
    const account = activeAccounts.find((a) => a.id === movementForm.accountId);
    const amount = Number(movementForm.amount);
    if (!account || !movementForm.description.trim() || !Number.isFinite(amount) || amount <= 0) { setError('Choisissez un compte, une description et un montant supérieur à 0 DH.'); return; }
    if (movementForm.movementType === 'outflow' && amount > balanceFor(account) + 0.001) { setError('Solde insuffisant dans « ' + account.name + ' ».'); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const { error } = await getSupabaseClient().from('finance_account_movements').insert({ centre_id: profile.centreId, account_id: account.id, movement_type: movementForm.movementType, amount, movement_date: new Date((movementForm.date || today()) + 'T12:00:00').toISOString(), description: movementForm.description.trim(), source_type: 'manual', created_by: profile.id });
      if (error) throw error;
      setMovementForm((v) => ({ ...v, amount: '', description: '' })); setNotice('Mouvement de trésorerie enregistré.'); reload(); onChange();
    } catch (e) { setError(readableFinanceError(e, 'Impossible d’enregistrer le mouvement.')); }
    finally { setSaving(false); }
  }

  async function transfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!profile?.centreId) return;
    if (!isDirector) { setError('Mode consultation : seul le directeur peut effectuer cette opération.'); return; }
    const source = activeAccounts.find((a) => a.id === movementForm.accountId);
    const destination = activeAccounts.find((a) => a.id === movementForm.destinationId);
    const amount = Number(movementForm.amount);
    if (!source || !destination || source.id === destination.id || !Number.isFinite(amount) || amount <= 0) { setError('Choisissez deux comptes différents et un montant supérieur à 0 DH.'); return; }
    if (amount > balanceFor(source) + 0.001) { setError('Solde insuffisant dans « ' + source.name + ' ».'); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const date = new Date((movementForm.date || today()) + 'T12:00:00').toISOString();
      const { error } = await getSupabaseClient().rpc('finance_transfer_accounts', {
        p_source_account_id: source.id,
        p_destination_account_id: destination.id,
        p_amount: amount,
        p_movement_date: date,
      });
      if (error) throw error;
      setMovementForm((v) => ({ ...v, amount: '', description: '' })); setNotice('Transfert de ' + money(amount) + ' effectué ; les deux mouvements sont liés et atomiques.'); reload(); onChange();
    } catch (e) { setError(readableFinanceError(e, 'Impossible d’effectuer le transfert.')); }
    finally { setSaving(false); }
  }

  if (loading) return <LoadingState label="Chargement des dépenses et de la trésorerie…" />;

  return <section className="finance-operations-module">
    {readOnly && <Alert tone="info"><p>Mode consultation : l’administrateur peut consulter les dépenses et la trésorerie, mais seul le directeur peut créer, modifier, valider ou payer des opérations.</p></Alert>}
    {error && <Alert tone="error"><p>{error}</p></Alert>}
    {notice && <Alert tone="success"><p>{notice}</p></Alert>}
    <div className="finance-operation-tabs">
      <Button type="button" variant={section === 'expenses' ? 'primary' : 'secondary'} onClick={() => setSection('expenses')}>Dépenses</Button>
      <Button type="button" variant={section === 'treasury' ? 'primary' : 'secondary'} onClick={() => setSection('treasury')}>Trésorerie</Button>
    </div>
    {section === 'expenses' && <>
      <div className="finance-quick-metrics"><article><span>Dépenses en attente/à valider</span><strong>{money(pendingTotal)}</strong></article><article><span>Dépenses payées</span><strong>{money(paidTotal)}</strong></article></div>
      <div className="finance-operation-layout">
        <div className="finance-operation-card"><div className="finance-content-heading"><div><h3>Nouvelle dépense</h3><p>Ajoutez une dépense à valider avant paiement.</p></div>{isDirector && <Button type="button" onClick={() => { setEditingExpenseId(null); setExpenseForm({ label: '', category: 'Loyer', supplier: '', amount: '', expenseDate: today(), dueDate: '', notes: '' }); setModal('expense'); }}>+ Ajouter une dépense</Button>}</div></div>
        {modal === 'expense' && <OperationsModal title={editingExpenseId ? 'Modifier une dépense' : 'Enregistrer une dépense'} onClose={() => setModal(null)}><form className="finance-modal-form" onSubmit={(e) => void createExpense(e)}>
          <h3>Enregistrer une dépense</h3>
          <label className="sp-form-field">Libellé<input className="sp-field" required maxLength={140} value={expenseForm.label} onChange={(e) => setExpenseForm((v) => ({ ...v, label: e.target.value }))} placeholder="Ex. Loyer du mois" /></label>
          <label className="sp-form-field">Catégorie<select className="sp-field" value={expenseForm.category} onChange={(e) => setExpenseForm((v) => ({ ...v, category: e.target.value }))}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
          <label className="sp-form-field">Fournisseur / bénéficiaire<input className="sp-field" value={expenseForm.supplier} onChange={(e) => setExpenseForm((v) => ({ ...v, supplier: e.target.value }))} /></label>
          <label className="sp-form-field">Montant (DH)<input className="sp-field" required min="0.01" step="0.01" type="number" value={expenseForm.amount} onChange={(e) => setExpenseForm((v) => ({ ...v, amount: e.target.value }))} /></label>
          <label className="sp-form-field">Date de dépense<input className="sp-field" required type="date" value={expenseForm.expenseDate} onChange={(e) => setExpenseForm((v) => ({ ...v, expenseDate: e.target.value }))} /></label>
          <label className="sp-form-field">Échéance (facultative)<input className="sp-field" type="date" value={expenseForm.dueDate} onChange={(e) => setExpenseForm((v) => ({ ...v, dueDate: e.target.value }))} /></label>
          <label className="sp-form-field">Notes / justificatif<textarea className="sp-field" rows={2} value={expenseForm.notes} onChange={(e) => setExpenseForm((v) => ({ ...v, notes: e.target.value }))} /></label>
          <Button type="submit" disabled={saving}>{saving ? 'Enregistrement…' : 'Enregistrer la dépense'}</Button>
        </form></OperationsModal>}
        <div className="finance-operation-card"><h3>Suivi des dépenses</h3>
          {expenses.length === 0 ? <p className="management-muted">Aucune dépense enregistrée.</p> : <>
            <label className="sp-form-field">Compte utilisé pour payer<select className="sp-field" value={paymentAccountId} onChange={(e) => setPaymentAccountId(e.target.value)}><option value="">Sélectionner un compte</option>{activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name} — {money(balanceFor(a))}</option>)}</select></label>
            <div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Dépense</th><th>Montant</th><th>Date</th><th>Statut</th><th>Actions</th></tr></thead><tbody>{expenses.map((expense) => <tr key={expense.id}>
              <td>{expense.label}<small>{expense.category}{expense.supplier ? ' · ' + expense.supplier : ''}</small></td><td>{money(num(expense.amount))}</td><td>{expense.expense_date}</td>
              <td><span className={'finance-status finance-status-' + expense.status}>{expense.status === 'pending' ? 'À valider' : expense.status === 'approved' ? 'Validée' : expense.status === 'paid' ? 'Payée' : 'Refusée'}</span></td>
              <td>{isDirector && <div className="finance-row-actions">{expense.status === 'pending' && <><Button type="button" variant="secondary" disabled={saving} onClick={() => { setEditingExpenseId(expense.id); setExpenseForm({ label: expense.label, category: expense.category, supplier: expense.supplier ?? '', amount: String(expense.amount), expenseDate: expense.expense_date, dueDate: expense.due_date ?? '', notes: expense.notes ?? '' }); setModal('expense'); }}>Modifier</Button><Button type="button" variant="danger" disabled={saving} onClick={() => void changeExpenseStatus(expense, 'rejected')}>Supprimer</Button><Button type="button" variant="secondary" disabled={saving} onClick={() => void changeExpenseStatus(expense, 'approved')}>Valider</Button></>}{expense.status === 'approved' && <Button type="button" disabled={saving || !paymentAccountId} onClick={() => void payExpense(expense)}>Marquer payée</Button>}</div>}</td>
            </tr>)}</tbody></table></div>
          </>}
        </div>
      </div>
    </>}
    {section === 'treasury' && <>
      <div className="finance-quick-metrics"><article><span>Solde des caisses</span><strong>{money(cashTotal)}</strong></article><article><span>Solde bancaire</span><strong>{money(bankTotal)}</strong></article><article><span>Trésorerie disponible</span><strong>{money(cashTotal + bankTotal)}</strong></article></div>
      <div className="finance-operation-layout">
        {modal === 'account' && <OperationsModal title={editingAccountId ? 'Modifier le compte' : 'Créer une caisse ou un compte'} onClose={() => setModal(null)}><form className="finance-modal-form" onSubmit={(e) => void createAccount(e)}>
          <h3>{editingAccountId ? 'Modifier le nom du compte' : 'Créer une caisse / un compte'}</h3>
          <label className="sp-form-field">Nom du compte<input className="sp-field" required maxLength={100} value={accountForm.name} onChange={(e) => setAccountForm((v) => ({ ...v, name: e.target.value }))} placeholder="Ex. Caisse principale" /></label>
          {!editingAccountId && <><label className="sp-form-field">Type<select className="sp-field" value={accountForm.accountType} onChange={(e) => setAccountForm((v) => ({ ...v, accountType: e.target.value as 'cash' | 'bank' }))}><option value="cash">Caisse (espèces)</option><option value="bank">Compte bancaire</option></select></label>
          <label className="sp-form-field">Solde initial (DH)<input className="sp-field" required min="0" step="0.01" type="number" value={accountForm.openingBalance} onChange={(e) => setAccountForm((v) => ({ ...v, openingBalance: e.target.value }))} /></label></>}
          <div className="finance-modal-actions"><Button type="button" variant="secondary" onClick={() => setModal(null)}>Annuler</Button><Button type="submit" disabled={saving}>{saving ? 'Enregistrement…' : editingAccountId ? 'Enregistrer les modifications' : 'Créer le compte'}</Button></div>
        </form></OperationsModal>}
        <div className="finance-operation-card"><div className="finance-content-heading"><div><h3>Caisses et comptes actifs</h3><p>Soldes calculés à partir des mouvements.</p></div>{isDirector && <Button type="button" onClick={() => setModal('account')}>+ Ajouter un compte</Button>}</div>{activeAccounts.length === 0 ? <p className="management-muted">Créez d’abord une caisse ou un compte bancaire.</p> : <div className="finance-account-grid">{activeAccounts.map((a) => <article className="finance-account-card" key={a.id}><span>{a.account_type === 'cash' ? 'Caisse' : 'Banque'}</span><strong>{a.name}</strong><b>{money(balanceFor(a))}</b><small>Solde initial : {money(num(a.opening_balance))}</small>{isDirector && <div className="finance-row-actions"><Button type="button" variant="secondary" disabled={saving} onClick={() => { setEditingAccountId(a.id); setAccountForm({ name: a.name, accountType: a.account_type, openingBalance: String(a.opening_balance) }); setModal('account'); }}>Modifier</Button><Button type="button" variant="danger" disabled={saving} onClick={() => void deactivateAccount(a)}>Désactiver</Button></div>}</article>)}</div>}</div>
      </div>
      <div className="finance-operation-layout">
        <div className="finance-operation-card"><div className="finance-content-heading"><div><h3>Mouvements</h3><p>Enregistrez une entrée ou une sortie manuelle.</p></div>{isDirector && <Button type="button" onClick={() => setModal('movement')}>+ Nouveau mouvement</Button>}</div></div>
        <div className="finance-operation-card"><div className="finance-content-heading"><div><h3>Transfert</h3><p>Déplacez des fonds entre deux comptes.</p></div>{isDirector && <Button type="button" disabled={activeAccounts.length < 2} onClick={() => setModal('transfer')}>+ Nouveau transfert</Button>}</div></div>
        {modal === 'movement' && <OperationsModal title="Entrée / sortie manuelle" onClose={() => setModal(null)}><form className="finance-modal-form" onSubmit={(e) => void createMovement(e)}>
          <h3>Entrée / sortie manuelle</h3>
          <label className="sp-form-field">Compte<select className="sp-field" required value={movementForm.accountId} onChange={(e) => setMovementForm((v) => ({ ...v, accountId: e.target.value }))}><option value="">Sélectionner un compte</option>{activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name} — {money(balanceFor(a))}</option>)}</select></label>
          <label className="sp-form-field">Opération<select className="sp-field" value={movementForm.movementType} onChange={(e) => setMovementForm((v) => ({ ...v, movementType: e.target.value as 'inflow' | 'outflow' }))}><option value="inflow">Entrée de fonds</option><option value="outflow">Sortie de fonds</option></select></label>
          <label className="sp-form-field">Montant (DH)<input className="sp-field" required min="0.01" step="0.01" type="number" value={movementForm.amount} onChange={(e) => setMovementForm((v) => ({ ...v, amount: e.target.value }))} /></label>
          <label className="sp-form-field">Date<input className="sp-field" required type="date" value={movementForm.date} onChange={(e) => setMovementForm((v) => ({ ...v, date: e.target.value }))} /></label>
          <label className="sp-form-field">Description<input className="sp-field" required maxLength={180} value={movementForm.description} onChange={(e) => setMovementForm((v) => ({ ...v, description: e.target.value }))} /></label>
          <Button type="submit" disabled={saving || activeAccounts.length === 0}>{saving ? 'Enregistrement…' : 'Enregistrer le mouvement'}</Button>
        </form></OperationsModal>}
        {modal === 'transfer' && <OperationsModal title="Transfert entre comptes" onClose={() => setModal(null)}><form className="finance-modal-form" onSubmit={(e) => void transfer(e)}>
          <h3>Transfert entre comptes</h3><p className="management-muted">Le transfert crée une sortie et une entrée liées : le total de trésorerie ne change pas.</p>
          <label className="sp-form-field">Compte source<select className="sp-field" required value={movementForm.accountId} onChange={(e) => setMovementForm((v) => ({ ...v, accountId: e.target.value }))}><option value="">Compte à débiter</option>{activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name} — {money(balanceFor(a))}</option>)}</select></label>
          <label className="sp-form-field">Compte destinataire<select className="sp-field" required value={movementForm.destinationId} onChange={(e) => setMovementForm((v) => ({ ...v, destinationId: e.target.value }))}><option value="">Compte à créditer</option>{activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label className="sp-form-field">Montant (DH)<input className="sp-field" required min="0.01" step="0.01" type="number" value={movementForm.amount} onChange={(e) => setMovementForm((v) => ({ ...v, amount: e.target.value }))} /></label>
          <label className="sp-form-field">Date<input className="sp-field" required type="date" value={movementForm.date} onChange={(e) => setMovementForm((v) => ({ ...v, date: e.target.value }))} /></label>
          <Button type="submit" disabled={saving || activeAccounts.length < 2}>{saving ? 'Enregistrement…' : 'Effectuer le transfert'}</Button>
        </form></OperationsModal>}
      </div>
      <div className="finance-operation-card"><h3>Historique de trésorerie</h3>{movements.length === 0 ? <p className="management-muted">Aucun mouvement enregistré.</p> : <div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Date</th><th>Compte</th><th>Opération</th><th>Description</th><th>Montant</th></tr></thead><tbody>{movements.map((m) => { const a = accounts.find((item) => item.id === m.account_id); const outgoing = m.movement_type === 'outflow' || m.movement_type === 'transfer_out'; return <tr key={m.id}><td>{new Date(m.movement_date).toLocaleDateString('fr-MA')}</td><td>{a?.name ?? 'Compte inconnu'}</td><td>{movementLabel(m.movement_type)}</td><td>{m.description}{m.transfer_group_id && <small>Transfert lié</small>}</td><td className={outgoing ? 'finance-amount-out' : 'finance-amount-in'}>{outgoing ? '−' : '+'}{money(num(m.amount))}</td></tr>; })}</tbody></table></div>}</div>
    </>}
    <p className="finance-security-note">Les opérations sont isolées par centre. Les soldes sont calculés à partir des soldes initiaux et des mouvements.</p>
  </section>;
}
