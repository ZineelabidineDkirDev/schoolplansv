import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Alert,
  Button,
  EmptyState,
  Field,
  LoadingState,
  Modal,
  PageHeader,
  Panel,
  StatusBadge,
  confirmAction,
  notify,
} from '../../components/ui';
import { invokeCentreDirectorAccess } from '../../data/repositories/edgeFunctionRepository';
import { getSupabaseClient } from '../../data/supabase/client';
import type { CentreDirector } from '../../data/repositories/edgeFunctionRepository';
import { uploadCentreLogo } from '../../data/repositories/centreProfileRepository';

type Centre = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  logoUrl: string | null;
  pack: string | null;
  subscriptionStatus: string | null;
  expirationDate: string | null;
};

type CentreState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'loaded';
      centres: Centre[];
      userCounts: Map<string, number>;
      warning: string | null;
    };

type CentreForm = {
  name: string;
  slug: string;
  directorName: string;
  directorEmail: string;
  password: string;
  confirmPassword: string;
  pack: string;
  subscriptionStatus: string;
  startDate: string;
  expirationDate: string;
  rights: Record<string, boolean>;
};

type DirectorForm = {
  fullName: string;
  email: string;
  password: string;
};

const CENTRE_RIGHTS = [
  ['etudiants', 'Étudiants'],
  ['formateurs', 'Formateurs'],
  ['cours', 'Cours / séances'],
  ['planning', 'Planning'],
  ['formations', 'Formations'],
  ['groupes', 'Groupes'],
  ['salles', 'Salles'],
  ['presences', 'Présences'],
  ['certificats', 'Certificats'],
  ['supports', 'Supports'],
  ['documents', 'Documents'],
  ['statistiques', 'Statistiques'],
  ['rapports', 'Rapports'],
  ['import_excel', 'Import Excel'],
  ['export_excel', 'Export Excel'],
  ['seances', 'Gestion des séances'],
] as const;

type CentreConfigForm = {
  pack: string;
  subscriptionStatus: string;
  startDate: string;
  expirationDate: string;
  rights: Record<string, boolean>;
};

const DEFAULT_CENTRE_RIGHTS = Object.fromEntries(
  CENTRE_RIGHTS.map(([key]) => [key, true]),
) as Record<string, boolean>;

const emptyForm: CentreForm = {
  name: '',
  slug: '',
  directorName: '',
  directorEmail: '',
  password: '',
  confirmPassword: '',
  pack: '',
  subscriptionStatus: '',
  startDate: '',
  expirationDate: '',
  rights: DEFAULT_CENTRE_RIGHTS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCentres(value: unknown): Centre[] {
  if (!Array.isArray(value)) throw new Error('La liste des centres reçue est invalide.');
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.nom !== 'string' ||
      typeof item.slug !== 'string' ||
      typeof item.actif !== 'boolean'
    ) {
      throw new Error('Une fiche centre ne contient pas les champs attendus.');
    }
    return {
      id: item.id,
      name: item.nom,
      slug: item.slug,
      active: item.actif,
      logoUrl: typeof item.logo_url === 'string' ? item.logo_url : null,
      pack: typeof item.type_abonnement === 'string' ? item.type_abonnement : null,
      subscriptionStatus: typeof item.statut_abonnement === 'string' ? item.statut_abonnement : null,
      expirationDate: typeof item.date_expiration === 'string' ? item.date_expiration : null,
    };
  });
}

async function loadCentres(client: SupabaseClient): Promise<CentreState> {
  const { data, error } = await client
    .from('centres')
    .select('id, nom, slug, actif, logo_url, type_abonnement, statut_abonnement, date_expiration')
    .order('created_at', { ascending: true });
  let centreRows: unknown = data;
  if (error) {
    const fallback = await client
      .from('centres')
      .select('id, nom, slug, actif, logo_url')
      .order('created_at', { ascending: true });
    if (fallback.error) throw fallback.error;
    centreRows = fallback.data;
  }

  const centres = parseCentres(centreRows);
  const userCounts = new Map<string, number>();
  let profileWarning: string | null = null;
  for (let offset = 0; ; offset += 1000) {
    const { data: profiles, error: profileError } = await client
      .from('profiles')
      .select('centre_id, role')
      .range(offset, offset + 999);
    if (profileError) {
      profileWarning = `Le nombre d’utilisateurs n’a pas pu être chargé : ${profileError.message}`;
      break;
    }
    for (const profile of profiles ?? []) {
      if (isRecord(profile) && typeof profile.centre_id === 'string') {
        userCounts.set(profile.centre_id, (userCounts.get(profile.centre_id) ?? 0) + 1);
      }
    }
    if (!profiles || profiles.length < 1000) break;
  }

  return {
    status: 'loaded',
    centres,
    userCounts,
    warning: profileWarning,
  };
}

export function CentreManagementPage() {
  const [state, setState] = useState<CentreState>({ status: 'loading' });
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<CentreForm>(emptyForm);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessageState] = useState<{ tone: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const setMessage = (value: { tone: 'success' | 'error' | 'warning'; text: string } | null) => {
    setMessageState(value);
    if (value) notify(value.text, value.tone === 'error' ? 'error' : value.tone === 'warning' ? 'info' : 'success');
  };
  const [selectedCentre, setSelectedCentre] = useState<Centre | null>(null);
  const [configCentre, setConfigCentre] = useState<Centre | null>(null);
  const [configForm, setConfigForm] = useState<CentreConfigForm>({
    pack: '',
    subscriptionStatus: '',
    startDate: '',
    expirationDate: '',
    rights: DEFAULT_CENTRE_RIGHTS,
  });
  const [configCapabilities, setConfigCapabilities] = useState({ subscription: false, rights: false });
  const [configLoading, setConfigLoading] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [directors, setDirectors] = useState<CentreDirector[]>([]);
  const [directorLoading, setDirectorLoading] = useState(false);
  const [directorForm, setDirectorForm] = useState<DirectorForm>({
    fullName: '',
    email: '',
    password: '',
  });
  const [directorFormOpen, setDirectorFormOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<CentreDirector | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetConfirmation, setResetConfirmation] = useState('');

  useEffect(() => {
    if (!logoFile) {
      setLogoPreview(null);
      return;
    }
    const previewUrl = URL.createObjectURL(logoFile);
    setLogoPreview(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [logoFile]);

  const refresh = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState(await loadCentres(getSupabaseClient()));
    } catch (cause) {
      setState({
        status: 'error',
        message: cause instanceof Error ? cause.message : 'Impossible de charger les centres.',
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filteredCentres = useMemo(() => {
    if (state.status !== 'loaded') return [];
    const query = search.trim().toLocaleLowerCase('fr');
    return state.centres.filter(
      (centre) =>
        !query ||
        centre.name.toLocaleLowerCase('fr').includes(query) ||
        centre.slug.toLocaleLowerCase('fr').includes(query),
    );
  }, [search, state]);

  async function createCentre(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const email = form.directorEmail.trim().toLowerCase();
    const slug = form.slug.trim().toLowerCase();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
      setMessage({
        tone: 'error',
        text: 'Slug invalide : lettres minuscules, chiffres et tirets uniquement.',
      });
      return;
    }
    if (form.password.length < 10 || form.password.length > 72) {
      setMessage({
        tone: 'error',
        text: 'Le mot de passe du directeur doit contenir entre 10 et 72 caractères.',
      });
      return;
    }
    if (form.password !== form.confirmPassword) {
      setMessage({ tone: 'error', text: 'Les deux mots de passe ne correspondent pas.' });
      return;
    }
    if (form.startDate && form.expirationDate && form.expirationDate < form.startDate) {
      setMessage({ tone: 'error', text: "La date d'expiration doit suivre la date de début." });
      return;
    }

    setSaving(true);
    try {
      const client = getSupabaseClient();
      const [subscriptionProbe, rightsProbe] = await Promise.all([
        client.from('centres').select('type_abonnement, statut_abonnement, date_debut, date_expiration').limit(1),
        client.from('centres').select('droits').limit(1),
      ]);
      const centrePayload = {
        nom: form.name.trim(),
        slug,
        actif: true,
        ...(!subscriptionProbe.error ? {
          type_abonnement: form.pack || null,
          statut_abonnement: form.subscriptionStatus || null,
          date_debut: form.startDate || null,
          date_expiration: form.expirationDate || null,
        } : {}),
        ...(!rightsProbe.error ? { droits: form.rights } : {}),
      };
      await invokeCentreDirectorAccess(client, {
        action: 'create_centre',
        centre: centrePayload,
        director: {
          full_name: form.directorName.trim(),
          email,
          password: form.password,
        },
      });
      setMessage({
        tone: subscriptionProbe.error || rightsProbe.error ? 'warning' : 'success',
        text: subscriptionProbe.error || rightsProbe.error
          ? `Centre et directeur créés. Attention : ${subscriptionProbe.error ? "les champs d'abonnement" : ''}${subscriptionProbe.error && rightsProbe.error ? ' et ' : ''}${rightsProbe.error ? 'les droits' : ''} n'ont pas pu être enregistrés, car les colonnes correspondantes sont absentes ou inaccessibles.`
          : 'Centre, directeur, abonnement et droits créés avec succès.',
      });
      setForm(emptyForm);
      setFormOpen(false);
      await refresh();
    } catch (cause) {
      setMessage({
        tone: 'error',
        text: cause instanceof Error ? cause.message : 'La création du centre a échoué.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function toggleCentre(centre: Centre) {
    const action = centre.active ? 'suspendre' : 'réactiver';
    if (
      !await confirmAction(`${action === 'suspendre' ? 'Suspendre' : 'Réactiver'} « ${centre.name} » ?`)
    ) {
      return;
    }
    setMessage(null);
    try {
      const { data, error } = await getSupabaseClient()
        .from('centres')
        .update({ actif: !centre.active })
        .eq('id', centre.id)
        .select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('Modification refusée : aucun centre n’a été mis à jour.');
      await refresh();
    } catch (cause) {
      setMessage({
        tone: 'error',
        text: cause instanceof Error ? cause.message : 'La modification du statut a échoué.',
      });
    }
  }

  async function openCentreConfig(centre: Centre) {
    setConfigCentre(centre);
    setLogoFile(null);
    setConfigLoading(true);
    setMessage(null);
    const client = getSupabaseClient();
    const [subscriptionResult, rightsResult] = await Promise.all([
      client
        .from('centres')
        .select('type_abonnement, statut_abonnement, date_debut, date_expiration')
        .eq('id', centre.id)
        .maybeSingle(),
      client.from('centres').select('droits').eq('id', centre.id).maybeSingle(),
    ]);

    const rightsValue = rightsResult.data?.droits;
    const storedRights =
      rightsValue && typeof rightsValue === 'object' && !Array.isArray(rightsValue)
        ? (rightsValue as Record<string, unknown>)
        : {};
    setConfigCapabilities({
      subscription: !subscriptionResult.error,
      rights: !rightsResult.error,
    });
    setConfigForm({
      pack: typeof subscriptionResult.data?.type_abonnement === 'string'
        ? subscriptionResult.data.type_abonnement
        : '',
      subscriptionStatus: typeof subscriptionResult.data?.statut_abonnement === 'string'
        ? subscriptionResult.data.statut_abonnement
        : '',
      startDate: typeof subscriptionResult.data?.date_debut === 'string'
        ? subscriptionResult.data.date_debut
        : '',
      expirationDate: typeof subscriptionResult.data?.date_expiration === 'string'
        ? subscriptionResult.data.date_expiration
        : '',
      rights: Object.fromEntries(
        CENTRE_RIGHTS.map(([key]) => [key, storedRights[key] !== false]),
      ),
    });
    setConfigLoading(false);
  }

  async function saveCentreConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configCentre) return;
    if (configForm.startDate && configForm.expirationDate && configForm.expirationDate < configForm.startDate) {
      setMessage({ tone: 'error', text: "La date d'expiration doit suivre la date de début." });
      return;
    }

    const payload: Record<string, string | null | Record<string, boolean>> = {};
    if (configCapabilities.subscription) {
      payload.type_abonnement = configForm.pack || null;
      payload.statut_abonnement = configForm.subscriptionStatus || null;
      payload.date_debut = configForm.startDate || null;
      payload.date_expiration = configForm.expirationDate || null;
    }
    if (configCapabilities.rights) payload.droits = configForm.rights;
    if (Object.keys(payload).length === 0 && !logoFile) {
      setMessage({
        tone: 'error',
        text: "Les colonnes d'abonnement et de droits ne sont pas disponibles dans Supabase. Vérifiez le schéma avant de continuer.",
      });
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const client = getSupabaseClient();
      if (logoFile) payload.logo_url = await uploadCentreLogo(client, configCentre.id, logoFile);
      const { data, error } = await client
        .from('centres')
        .update(payload)
        .eq('id', configCentre.id)
        .select('id');
      if (error) throw error;
      if (!data?.length) throw new Error("Aucune modification n'a été enregistrée.");
      setMessage({ tone: 'success', text: `Configuration de « ${configCentre.name} » enregistrée.` });
      setLogoFile(null);
      setConfigCentre(null);
      await refresh();
    } catch (cause) {
      setMessage({
        tone: 'error',
        text: cause instanceof Error ? cause.message : "Impossible d'enregistrer la configuration du centre.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function showDirectors(centre: Centre) {
    setSelectedCentre(centre);
    setDirectors([]);
    setDirectorLoading(true);
    setMessage(null);
    try {
      const result = await invokeCentreDirectorAccess(getSupabaseClient(), {
        action: 'list',
        centre_id: centre.id,
      });
      if (!('directors' in result)) throw new Error('La liste des directeurs est indisponible.');
      setDirectors(result.directors);
    } catch (cause) {
      setMessage({
        tone: 'error',
        text: cause instanceof Error ? cause.message : 'Impossible de charger les directeurs.',
      });
    } finally {
      setDirectorLoading(false);
    }
  }

  async function resetDirector(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCentre || !resetTarget) return;
    if (resetPassword.length < 10 || resetPassword.length > 72) {
      setMessage({
        tone: 'error',
        text: 'Le mot de passe doit contenir entre 10 et 72 caractères.',
      });
      return;
    }
    if (resetPassword !== resetConfirmation) {
      setMessage({ tone: 'error', text: 'Les deux mots de passe ne correspondent pas.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await invokeCentreDirectorAccess(getSupabaseClient(), {
        action: 'reset',
        centre_id: selectedCentre.id,
        user_id: resetTarget.user_id,
        password: resetPassword,
      });
      setMessage({ tone: 'success', text: 'Mot de passe directeur réinitialisé.' });
      setResetTarget(null);
      setResetPassword('');
      setResetConfirmation('');
    } catch (cause) {
      setMessage({
        tone: 'error',
        text:
          cause instanceof Error ? cause.message : 'La réinitialisation du mot de passe a échoué.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function createDirector(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCentre) return;
    if (directorForm.password.length < 10 || directorForm.password.length > 72) {
      setMessage({
        tone: 'error',
        text: 'Le mot de passe doit contenir entre 10 et 72 caractères.',
      });
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      await invokeCentreDirectorAccess(getSupabaseClient(), {
        action: 'create_director',
        centre_id: selectedCentre.id,
        director: {
          full_name: directorForm.fullName.trim(),
          email: directorForm.email.trim().toLowerCase(),
          password: directorForm.password,
        },
      });
      const list = await invokeCentreDirectorAccess(getSupabaseClient(), {
        action: 'list',
        centre_id: selectedCentre.id,
      });
      if (!('directors' in list)) throw new Error('La liste des directeurs est indisponible.');
      setDirectors(list.directors);
      setMessage({ tone: 'success', text: 'Directeur créé avec succès.' });
      setDirectorForm({ fullName: '', email: '', password: '' });
      setDirectorFormOpen(false);
    } catch (cause) {
      setMessage({
        tone: 'error',
        text: cause instanceof Error ? cause.message : 'La création du directeur a échoué.',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mx-auto w-full max-w-screen-2xl space-y-5">
      <PageHeader
        actions={
          <Button onClick={() => setFormOpen((open) => !open)} type="button">
            {formOpen ? 'Fermer le formulaire' : '+ Ajouter un centre'}
          </Button>
        }
        description="Centres de formation, accès directeurs et statut d’activité."
        eyebrow="Administration"
        title="Gérer les centres"
      />

      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      {state.status === 'loaded' && state.warning && <Alert tone="warning">{state.warning}</Alert>}

      {formOpen && (
        <Modal label="Nouveau centre et directeur" onClose={() => setFormOpen(false)}>
        <Panel>
          <h2 className="m-0 mb-4 text-lg font-bold text-brand-900">Nouveau centre et directeur</h2>
          <form className="grid gap-4 md:grid-cols-2" onSubmit={createCentre}>
            <Field
              label="Nom du centre"
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              required
              value={form.name}
            />
            <Field
              autoCapitalize="none"
              label="Slug"
              onChange={(event) => setForm((current) => ({ ...current, slug: event.target.value }))}
              placeholder="centre-de-formation"
              required
              value={form.slug}
            />
            <div className="grid gap-4 rounded-xl border border-line p-4 md:col-span-2 md:grid-cols-2">
              <label className="sp-form-field">
                Pack choisi
                <select className="sp-field" onChange={(event) => setForm((current) => ({ ...current, pack: event.target.value }))} value={form.pack}>
                  <option value="">Choisir un pack…</option>
                  <option value="STARTER">STARTER</option>
                  <option value="STANDARD">STANDARD</option>
                  <option value="PROFESSIONAL">PROFESSIONAL</option>
                  <option value="ENTERPRISE">ENTERPRISE — Grand École</option>
                </select>
              </label>
              <label className="sp-form-field">
                Statut de l'abonnement
                <select className="sp-field" onChange={(event) => setForm((current) => ({ ...current, subscriptionStatus: event.target.value }))} value={form.subscriptionStatus}>
                  <option value="">Choisir un statut…</option>
                  <option value="TRIAL">TRIAL</option>
                  <option value="ACTIF">ACTIF</option>
                  <option value="EXPIRE">EXPIRE</option>
                  <option value="SUSPENDU">SUSPENDU</option>
                </select>
              </label>
              <label className="sp-form-field">
                Date de début
                <input className="sp-field" onChange={(event) => setForm((current) => ({ ...current, startDate: event.target.value }))} type="date" value={form.startDate} />
              </label>
              <label className="sp-form-field">
                Date d'expiration
                <input className="sp-field" onChange={(event) => setForm((current) => ({ ...current, expirationDate: event.target.value }))} type="date" value={form.expirationDate} />
              </label>
              <div className="md:col-span-2">
                <h3 className="mb-3 text-sm font-bold text-brand-900">Droits d'accès inclus</h3>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {CENTRE_RIGHTS.map(([key, label]) => (
                    <label className="flex items-center gap-2 rounded-lg border border-line p-2 text-sm" key={key}>
                      <input
                        checked={form.rights[key] === true}
                        className="h-4 w-4"
                        onChange={(event) => setForm((current) => ({
                          ...current,
                          rights: { ...current.rights, [key]: event.target.checked },
                        }))}
                        type="checkbox"
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <Field
              className="md:col-span-2"
              label="Nom complet du directeur"
              onChange={(event) =>
                setForm((current) => ({ ...current, directorName: event.target.value }))
              }
              required
              value={form.directorName}
            />
            <Field
              autoComplete="email"
              label="E-mail du directeur"
              onChange={(event) =>
                setForm((current) => ({ ...current, directorEmail: event.target.value }))
              }
              required
              type="email"
              value={form.directorEmail}
            />
            <Field
              autoComplete="new-password"
              label="Mot de passe provisoire (10–72 caractères)"
              maxLength={72}
              minLength={10}
              onChange={(event) =>
                setForm((current) => ({ ...current, password: event.target.value }))
              }
              required
              type="password"
              value={form.password}
            />
            <Field
              autoComplete="new-password"
              label="Confirmer le mot de passe"
              maxLength={72}
              minLength={10}
              onChange={(event) =>
                setForm((current) => ({ ...current, confirmPassword: event.target.value }))
              }
              required
              type="password"
              value={form.confirmPassword}
            />
            <div className="flex items-end justify-end gap-2">
              <Button onClick={() => setFormOpen(false)} type="button" variant="secondary">
                Annuler
              </Button>
              <Button disabled={saving} type="submit">
                {saving ? 'Création…' : 'Créer le centre'}
              </Button>
            </div>
          </form>
        </Panel>
        </Modal>
      )}

      {state.status === 'loading' && (
        <Panel>
          <LoadingState label="Chargement des centres…" />
        </Panel>
      )}
      {state.status === 'error' && (
        <Alert className="space-y-3" tone="error">
          <p>{state.message}</p>
          <Button onClick={() => void refresh()} type="button" variant="secondary">
            Réessayer
          </Button>
        </Alert>
      )}

      {state.status === 'loaded' && (
        <>
          <Panel className="!p-4">
            <Field
              autoComplete="off"
              label="Rechercher un centre"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Nom ou slug…"
              value={search}
            />
          </Panel>
          {filteredCentres.length === 0 ? (
            <EmptyState
              description={
                search ? 'Essayez un autre nom ou slug.' : 'Ajoutez un centre pour commencer.'
              }
              title={search ? 'Aucun résultat.' : 'Aucun centre enregistré.'}
            />
          ) : (
            <Panel className="!p-0">
              <div className="sp-table-wrap">
                <table className="sp-table">
                  <thead>
                    <tr className="border-b border-line bg-slate-50 text-xs tracking-wide text-slate-500 uppercase">
                      <th className="px-4 py-3 font-semibold">Centre</th>
                      <th className="px-4 py-3 font-semibold">Statut du centre</th>
                      <th className="px-4 py-3 font-semibold">Pack</th>
                      <th className="px-4 py-3 font-semibold">Abonnement</th>
                      <th className="px-4 py-3 font-semibold">Expiration</th>
                      <th className="px-4 py-3 font-semibold">Utilisateurs</th>
                      <th className="px-4 py-3 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCentres.map((centre) => (
                      <tr
                        className="border-b border-line last:border-0 hover:bg-slate-50/70"
                        key={centre.id}
                      >
                        <td data-label="Centre">
                          <div className="centre-table-identity">
                            <span className="centre-table-logo">
                              {centre.logoUrl ? <img alt={`Logo de ${centre.name}`} src={centre.logoUrl} /> : <span aria-hidden="true">🏫</span>}
                            </span>
                            <span className="min-w-0">
                              <strong className="block text-slate-900">{centre.name}</strong>
                              <span className="text-xs text-slate-500">{centre.slug}</span>
                            </span>
                          </div>
                        </td>
                        <td data-label="Statut">
                          <StatusBadge tone={centre.active ? 'success' : 'danger'}>
                            {centre.active ? 'Actif' : 'Suspendu'}
                          </StatusBadge>
                        </td>
                        <td data-label="Pack"><span className="centre-pack-badge">{centre.pack || 'Non défini'}</span></td>
                        <td data-label="Abonnement">
                          <StatusBadge tone={centre.subscriptionStatus === 'ACTIF' ? 'success' : centre.subscriptionStatus === 'TRIAL' ? 'warning' : centre.subscriptionStatus === 'EXPIRE' || centre.subscriptionStatus === 'SUSPENDU' ? 'danger' : 'neutral'}>
                            {centre.subscriptionStatus || 'Non défini'}
                          </StatusBadge>
                        </td>
                        <td data-label="Expiration">
                          {centre.expirationDate ? (() => {
                            const today = new Date();
                            const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
                            const days = Math.ceil((new Date(`${centre.expirationDate}T00:00:00`).getTime() - new Date(`${todayKey}T00:00:00`).getTime()) / 86400000);
                            return <span className={days < 0 ? 'centre-expiry is-expired' : days <= 30 ? 'centre-expiry is-soon' : 'centre-expiry'}>{new Date(`${centre.expirationDate}T12:00:00`).toLocaleDateString('fr-FR')}{days < 0 ? ' · Expiré' : days <= 30 ? ` · ${days} j` : ''}</span>;
                          })() : <span className="text-slate-400">Non définie</span>}
                        </td>
                        <td data-label="Utilisateurs">{state.userCounts.get(centre.id) ?? '—'}</td>
                        <td data-label="Actions">
                          <div className="flex flex-wrap gap-2">
                            <Button
                              className="min-h-9 px-3"
                              onClick={() => void openCentreConfig(centre)}
                              type="button"
                              variant="secondary"
                            >
                              Abonnement & droits
                            </Button>
                            <Button
                              className="min-h-9 px-3"
                              onClick={() => void showDirectors(centre)}
                              type="button"
                              variant="secondary"
                            >
                              Directeurs
                            </Button>
                            <Button
                              className="min-h-9 px-3"
                              onClick={() => void toggleCentre(centre)}
                              type="button"
                              variant="secondary"
                            >
                              {centre.active ? 'Suspendre' : 'Réactiver'}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}

      {configCentre && (
        <Modal label={`Configuration de ${configCentre.name}`} onClose={() => setConfigCentre(null)}>
        <Panel>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="m-0 text-xs font-bold tracking-[.12em] text-accent-600 uppercase">Configuration du centre</p>
              <h2 className="m-0 mt-1 text-lg font-bold text-brand-900">{configCentre.name}</h2>
            </div>
            <Button onClick={() => setConfigCentre(null)} type="button" variant="secondary">Fermer</Button>
          </div>
          {configLoading ? (
            <LoadingState label="Chargement de l'abonnement et des droits…" />
          ) : (
            <form className="space-y-5" onSubmit={(event) => void saveCentreConfig(event)}>
              <div className="centre-logo-editor md:col-span-2">
                <div className="centre-logo-preview">
                  {logoPreview ? (
                    <img alt={`Aperçu du logo de ${configCentre.name}`} src={logoPreview} />
                  ) : configCentre.logoUrl ? (
                    <img alt={`Logo actuel de ${configCentre.name}`} src={configCentre.logoUrl} />
                  ) : (
                    <span aria-hidden="true">🏫</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <strong className="block text-sm text-brand-900">Identité visuelle du centre</strong>
                  <p className="management-muted">Logo carré conseillé · PNG, JPG ou WebP.</p>
                  <input
                    accept="image/*"
                    className="sp-field mt-2"
                    onChange={(event) => setLogoFile(event.target.files?.[0] ?? null)}
                    type="file"
                  />
                  {logoFile && <p className="management-muted mt-1">Nouveau fichier : {logoFile.name}</p>}
                </div>
              </div>
              {!configCapabilities.subscription && (
                <Alert tone="warning">
                  Les colonnes d'abonnement ne sont pas disponibles ou lisibles. Le pack, le statut et les dates ne pourront pas être enregistrés tant que le schéma Supabase n'est pas vérifié.
                </Alert>
              )}
              {!configCapabilities.rights && (
                <Alert tone="warning">
                  Le champ centres.droits n'est pas disponible ou lisible. Les droits ne pourront pas être enregistrés tant que le schéma/RLS n'est pas vérifié.
                </Alert>
              )}
              <div className="grid gap-4 md:grid-cols-2">
                <label className="sp-form-field">
                  Pack choisi
                  <select
                    className="sp-field"
                    disabled={!configCapabilities.subscription}
                    onChange={(event) => setConfigForm((current) => ({ ...current, pack: event.target.value }))}
                    value={configForm.pack}
                  >
                    <option value="">Choisir un pack…</option>
                    <option value="STARTER">STARTER</option>
                    <option value="STANDARD">STANDARD</option>
                    <option value="PROFESSIONAL">PROFESSIONAL</option>
                    <option value="ENTERPRISE">ENTERPRISE — Grand École</option>
                  </select>
                </label>
                <label className="sp-form-field">
                  Statut de l'abonnement
                  <select
                    className="sp-field"
                    disabled={!configCapabilities.subscription}
                    onChange={(event) => setConfigForm((current) => ({ ...current, subscriptionStatus: event.target.value }))}
                    value={configForm.subscriptionStatus}
                  >
                    <option value="">Choisir un statut…</option>
                    <option value="TRIAL">TRIAL</option>
                    <option value="ACTIF">ACTIF</option>
                    <option value="EXPIRE">EXPIRE</option>
                    <option value="SUSPENDU">SUSPENDU</option>
                  </select>
                </label>
                <label className="sp-form-field">
                  Date de début
                  <input
                    className="sp-field"
                    disabled={!configCapabilities.subscription}
                    onChange={(event) => setConfigForm((current) => ({ ...current, startDate: event.target.value }))}
                    type="date"
                    value={configForm.startDate}
                  />
                </label>
                <label className="sp-form-field">
                  Date d'expiration
                  <input
                    className="sp-field"
                    disabled={!configCapabilities.subscription}
                    onChange={(event) => setConfigForm((current) => ({ ...current, expirationDate: event.target.value }))}
                    type="date"
                    value={configForm.expirationDate}
                  />
                </label>
              </div>
              <div>
                <h3 className="mb-3 text-base font-bold text-brand-900">Droits d'accès du centre</h3>
                <p className="mb-3 text-sm text-slate-500">Coche uniquement les modules inclus dans le pack. Les restrictions doivent aussi être appliquées par les fonctions/RLS Supabase.</p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {CENTRE_RIGHTS.map(([key, label]) => (
                    <label className="flex items-center gap-2 rounded-lg border border-line p-3 text-sm" key={key}>
                      <input
                        checked={configForm.rights[key] === true}
                        className="h-4 w-4"
                        disabled={!configCapabilities.rights}
                        onChange={(event) => setConfigForm((current) => ({
                          ...current,
                          rights: { ...current.rights, [key]: event.target.checked },
                        }))}
                        type="checkbox"
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button onClick={() => setConfigCentre(null)} type="button" variant="secondary">Annuler</Button>
                <Button disabled={saving || (!configCapabilities.subscription && !configCapabilities.rights)} type="submit">
                  {saving ? 'Enregistrement…' : 'Enregistrer la configuration'}
                </Button>
              </div>
            </form>
          )}
        </Panel>
        </Modal>
      )}

      {selectedCentre && (
        <Modal label={`Accès du directeur — ${selectedCentre.name}`} onClose={() => { setSelectedCentre(null); setResetTarget(null); setDirectorFormOpen(false); }}>
        <Panel>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="m-0 text-xs font-bold tracking-[.12em] text-accent-600 uppercase">
                Accès du directeur
              </p>
              <h2 className="m-0 mt-1 text-lg font-bold text-brand-900">{selectedCentre.name}</h2>
            </div>
            <div className="flex gap-2">
              {directors.length === 0 && !directorLoading && (
                <Button
                  onClick={() => setDirectorFormOpen((open) => !open)}
                  type="button"
                  variant="secondary"
                >
                  {directorFormOpen ? 'Annuler' : 'Créer un directeur'}
                </Button>
              )}
              <Button
                onClick={() => {
                  setSelectedCentre(null);
                  setResetTarget(null);
                  setDirectorFormOpen(false);
                }}
                type="button"
                variant="quiet"
              >
                Fermer
              </Button>
            </div>
          </div>

          {directorLoading ? (
            <LoadingState label="Chargement des directeurs…" />
          ) : directors.length === 0 ? (
            <EmptyState title="Aucun directeur rattaché à ce centre." />
          ) : (
            <ul className="m-0 grid list-none gap-3 p-0">
              {directors.map((director) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-4"
                  key={director.user_id}
                >
                  <div>
                    <strong className="block">{director.full_name || 'Nom non renseigné'}</strong>
                    <span className="text-sm text-slate-600">
                      {director.email || 'E-mail non renseigné'}
                    </span>
                  </div>
                  <Button
                    onClick={() => {
                      setResetTarget(director);
                      setResetPassword('');
                      setResetConfirmation('');
                    }}
                    type="button"
                    variant="secondary"
                  >
                    Réinitialiser le mot de passe
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {directorFormOpen && (
            <form
              className="mt-5 grid gap-4 rounded-xl bg-slate-50 p-4 sm:grid-cols-2"
              onSubmit={createDirector}
            >
              <p className="m-0 font-semibold text-slate-800 sm:col-span-2">
                Créer le compte directeur pour ce centre
              </p>
              <Field
                className="sm:col-span-2"
                label="Nom complet"
                onChange={(event) =>
                  setDirectorForm((current) => ({ ...current, fullName: event.target.value }))
                }
                required
                value={directorForm.fullName}
              />
              <Field
                autoComplete="email"
                label="E-mail"
                onChange={(event) =>
                  setDirectorForm((current) => ({ ...current, email: event.target.value }))
                }
                required
                type="email"
                value={directorForm.email}
              />
              <Field
                autoComplete="new-password"
                label="Mot de passe provisoire (10–72 caractères)"
                maxLength={72}
                minLength={10}
                onChange={(event) =>
                  setDirectorForm((current) => ({ ...current, password: event.target.value }))
                }
                required
                type="password"
                value={directorForm.password}
              />
              <div className="flex justify-end sm:col-span-2">
                <Button disabled={saving} type="submit">
                  {saving ? 'Création…' : 'Créer le directeur'}
                </Button>
              </div>
            </form>
          )}

          {resetTarget && (
            <form
              className="mt-5 grid gap-4 rounded-xl bg-slate-50 p-4 sm:grid-cols-2"
              onSubmit={resetDirector}
            >
              <p className="m-0 font-semibold text-slate-800 sm:col-span-2">
                Nouveau mot de passe pour {resetTarget.full_name || resetTarget.email}
              </p>
              <Field
                autoComplete="new-password"
                label="Nouveau mot de passe (10–72 caractères)"
                maxLength={72}
                minLength={10}
                onChange={(event) => setResetPassword(event.target.value)}
                required
                type="password"
                value={resetPassword}
              />
              <Field
                autoComplete="new-password"
                label="Confirmer le mot de passe"
                maxLength={72}
                minLength={10}
                onChange={(event) => setResetConfirmation(event.target.value)}
                required
                type="password"
                value={resetConfirmation}
              />
              <div className="flex justify-end gap-2 sm:col-span-2">
                <Button onClick={() => setResetTarget(null)} type="button" variant="secondary">
                  Annuler
                </Button>
                <Button disabled={saving} type="submit">
                  {saving ? 'Réinitialisation…' : 'Confirmer'}
                </Button>
              </div>
            </form>
          )}
        </Panel>
        </Modal>
      )}
    </section>
  );
}
