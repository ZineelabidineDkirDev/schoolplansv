import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useParams } from 'react-router-dom';
import {
  canAccessSection,
  getVisibleSections,
  getRoleLabel,
  SECTION_LABELS,
} from '../../business/permissions/permissions';
import { useAuth } from './AuthProvider';
import { getSupabaseClient } from '../../data/supabase/client';
import { ForcedPasswordChange } from './ForcedPasswordChange';
import { PendingAccess } from './PendingAccess';
import { MyStudentsPage } from '../students/MyStudentsPage';
import { DashboardPage } from '../dashboard/DashboardPage';
import { PlanningPage } from '../planning/PlanningPage';
import { Alert, Button, LoadingState, ThemeToggle } from '../../components/ui';
import { CentreManagementPage } from '../centres/CentreManagementPage';
import { EnrollmentRequestsPage } from '../enrollments/EnrollmentRequestsPage';
import {
  AttendancePage,
  FormationGroupsPage,
  RoomsPage,
  StudentsPage,
  TeachersPage,
} from '../management/DirectoryPages';
import { CentreProfilePage } from '../management/CentreProfilePage';
import { CertificatesPage } from '../management/CertificatesPage';
import { HistoryPage } from '../management/HistoryPage';
import { SupportsPage } from '../management/SupportsPage';
import { StudentWorkspacePage } from '../students/StudentWorkspacePage';
import type { AppSection } from '../../types/auth';

export function AuthenticatedRoutes() {
  const { status, error, signOut } = useAuth();

  if (status === 'loading') {
    return (
      <main className="sp-login-loading">
        <LoadingState label="Chargement de votre espace…" />
      </main>
    );
  }
  if (status === 'anonymous' || status === 'configuration_error') {
    return <Navigate replace to="/login" />;
  }
  if (status === 'pending') return <PendingAccess />;
  if (status === 'error') {
    return (
      <main className="sp-error-page">
        <p className="sp-page-eyebrow">Connexion interrompue</p>
        <h1 className="sp-page-title">Impossible de charger votre profil</h1>
        <Alert tone="error">{error}</Alert>
        <Button className="w-fit" onClick={() => void signOut()} type="button">
          Se déconnecter
        </Button>
      </main>
    );
  }

  return <AuthenticatedContent />;
}

function AuthenticatedContent() {
  const { mustChangePassword } = useAuth();
  if (mustChangePassword) return <ForcedPasswordChange />;
  return <ApplicationShell />;
}

function ApplicationShell() {
 const {
  profile,
  session,
  permissions,
  permissionErrors,
  error: authError,
  signOut,
  activeCentreId,
  setActiveCentreId,
} = useAuth();
  type CentreHeaderInfo = {
    id: string;
    nom: string;
    actif: boolean;
    logo_url?: string | null;
    type_abonnement?: string | null;
    statut_abonnement?: string | null;
    date_debut?: string | null;
    date_expiration?: string | null;
  };
  const [centres, setCentres] = useState<CentreHeaderInfo[]>([]);
  const [activeCentre, setActiveCentre] = useState<CentreHeaderInfo | null>(null);
  const [centresLoading, setCentresLoading] = useState(false);
  const [centresError, setCentresError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile || !['super_admin', 'admin', 'director'].includes(profile.role)) return;
    const currentProfile = profile;
    let active = true;

    async function loadSubscription(centreId: string, base: CentreHeaderInfo) {
      const { data } = await getSupabaseClient()
        .from('centres')
        .select('type_abonnement, statut_abonnement, date_debut, date_expiration')
        .eq('id', centreId)
        .maybeSingle();
      if (!active) return base;
      return data ? { ...base, ...data } : base;
    }

    async function loadCentres() {
      setCentresLoading(true);
      setCentresError(null);
      const client = getSupabaseClient();

      if (currentProfile.role === 'super_admin') {
        const { data, error } = await client
          .from('centres')
          .select('id, nom, actif, logo_url')
          .eq('actif', true)
          .order('nom');

        if (!active) return;
        if (error) {
          setCentresError(error.message);
          setCentres([]);
          setActiveCentre(null);
          setCentresLoading(false);
          return;
        }

        const available = (data ?? []).filter(
          (centre) => typeof centre.id === 'string' && typeof centre.nom === 'string',
        ) as CentreHeaderInfo[];
        if (!available.some((centre) => centre.id === currentProfile.centreId)) {
          const firstId = available[0]?.id ?? null;
          setActiveCentreId(firstId);
          if (!firstId) {
            setCentres([]);
            setActiveCentre(null);
            setCentresLoading(false);
            return;
          }
        }
        const selectedId = available.some((centre) => centre.id === currentProfile.centreId)
          ? currentProfile.centreId
          : available[0]?.id ?? null;
        const selected = available.find((centre) => centre.id === selectedId) ?? null;
        setCentres(available);
        setActiveCentre(selected ? await loadSubscription(selected.id, selected) : null);
        setCentresLoading(false);
        return;
      }

      if (!currentProfile.centreId) {
        setActiveCentre(null);
        setCentresLoading(false);
        return;
      }
      const { data, error } = await client
        .from('centres')
        .select('id, nom, actif, logo_url')
        .eq('id', currentProfile.centreId)
        .maybeSingle();
      if (!active) return;
      if (error) {
        setCentresError(error.message);
        setActiveCentre(null);
      } else if (data) {
        const base = data as CentreHeaderInfo;
        setActiveCentre(await loadSubscription(base.id, base));
      } else {  
        setActiveCentre(null);
      }
      setCentresLoading(false);
    }

    void loadCentres();
    return () => {
      active = false;
    };
  }, [profile, setActiveCentreId]);

  if (!profile) return null;

  const visibleSections = getVisibleSections(profile.role, permissions);

  return (
    <div className="sp-app">
      <header className="sp-app-header">
        <Link className="sp-app-brand" to="/app">
          <b className="sp-app-brand-mark">I</b>
          <span>SchoolPlans</span>
        </Link>
        {['super_admin', 'admin', 'director'].includes(profile.role) && (
          <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-white">
            <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-white">
              {activeCentre?.logo_url ? (
                <img alt={`Logo de ${activeCentre.nom}`} className="h-full w-full object-contain" src={activeCentre.logo_url} />
              ) : (
                <span aria-hidden="true" className="text-xl">🏫</span>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <strong className="max-w-[220px] truncate text-sm">{activeCentre?.nom ?? (centresLoading ? 'Chargement du centre…' : 'Centre non défini')}</strong>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {activeCentre && (
                  <span className={activeCentre.actif ? 'rounded-full bg-emerald-400/20 px-2 py-0.5 text-emerald-100' : 'rounded-full bg-rose-400/20 px-2 py-0.5 text-rose-100'}>
                    {activeCentre.actif ? 'Centre actif' : 'Centre suspendu'}
                  </span>
                )}
                {activeCentre?.type_abonnement && <span>Pack : <b>{activeCentre.type_abonnement}</b></span>}
                {activeCentre?.statut_abonnement && <span>Abonnement : <b>{activeCentre.statut_abonnement}</b></span>}
                {activeCentre?.date_expiration && (() => {
                  const today = new Date();
                  const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
                  const days = Math.round((new Date(`${activeCentre.date_expiration}T12:00:00`).getTime() - new Date(`${localToday}T12:00:00`).getTime()) / 86400000);
                  return (
                    <span className={days < 0 ? 'font-bold text-rose-200' : days <= 30 ? 'font-bold text-amber-200' : 'text-white/90'}>
                      Expiration : {activeCentre.date_expiration.split('-').reverse().join('/')} ({days < 0 ? `expiré depuis ${-days} j` : days === 0 ? 'expire aujourd’hui' : `${days} j restants`})
                    </span>
                  );
                })()}
                {!activeCentre?.type_abonnement && !activeCentre?.statut_abonnement && !activeCentre?.date_expiration && (
                  <span className="text-white/75">Abonnement non défini</span>
                )}
              </div>
            </div>
            {profile.role === 'super_admin' && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-white/15 bg-white/10 px-3 py-2">
            <label className="whitespace-nowrap text-xs font-semibold text-white" htmlFor="sp-centre-select">
              Centre actif
            </label>
            <select
              className="min-h-9 max-w-[220px] min-w-[150px] rounded-lg border border-slate-300 bg-white px-2 text-sm font-semibold text-slate-900"
              disabled={centresLoading || centres.length === 0}
              id="sp-centre-select"
              onChange={(event) => setActiveCentreId(event.target.value || null)}
              value={profile.centreId ?? ''}
            >
              {centres.length === 0 && <option value="">Aucun centre actif</option>}
              {centres.map((centre) => (
                <option key={centre.id} value={centre.id}>
                  {centre.nom}
                </option>
              ))}
            </select>
            {centresError && (
              <small className="w-full text-xs text-red-200">{centresError}</small>
            )}
          </div>
            )}
          </div>
        )}
        <div aria-label="Utilisateur connecté" className="sp-user">
          <strong>{profile.fullName || session?.user.email}</strong>
          <small>{getRoleLabel(profile.role)}</small>
        </div>
        <Link
          aria-label="Accueil (reste connecté)"
          className="sp-icon-button"
          title="Accueil"
          to="/app"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="m4 11 8-7 8 7v9h-5v-6H9v6H4z" />
          </svg>
        </Link>
        <ThemeToggle />
        <Button
          className="sp-header-logout"
          onClick={() => void signOut()}
          type="button"
          variant="secondary"
        >
          Déconnexion
        </Button>
      </header>

      <div className="sp-app-wrap">
        <nav aria-label="Navigation principale" className="sp-app-nav">
          <NavLink className={({ isActive }) => navItemClass(isActive)} end to="/app">
            <NavIcon section="home" />
            <span className="sp-nav-label">Accueil</span>
          </NavLink>
          {profile.role === 'super_admin' && (
            <NavLink
              className={({ isActive }) => navItemClass(isActive)}
              to="/app/vz"
            >
              <NavIcon section="vz" />
              <span className="sp-nav-label">Gérer les centres</span>
            </NavLink>
          )}
          {visibleSections
            .filter((section) => !(profile.role === 'super_admin' && section === 'vz'))
            .map((section) => (
              <NavLink
                className={({ isActive }) => navItemClass(isActive)}
                key={section}
                to={`/app/${section}`}
              >
                <NavIcon section={section} />
                <span className="sp-nav-label">{SECTION_LABELS[section]}</span>
              </NavLink>
            ))}
        </nav>

        <main className="sp-app-content">
          {profile.role === 'super_admin' && !activeCentreId && (
            <Alert tone="warning">
              Aucun centre actif n’est disponible. Créez ou réactivez un centre dans « Gestion des centres ».
            </Alert>
          )}
          {authError && <Alert tone="error">{authError}</Alert>}
          {permissionErrors.length > 0 && (
            <Alert tone="warning">
              Impossible de confirmer certains droits centre ({permissionErrors.join(', ')}). Les
              rubriques associées restent indisponibles. Contactez l’administration si cela
              persiste.
            </Alert>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function navItemClass(isActive: boolean) {
  return `sp-nav-link${isActive ? ' active' : ''}`;
}

function NavIcon({ section }: { section: AppSection | 'home' }) {
  const paths: Record<string, string> = {
    home: 'm4 11 8-7 8 7v9h-5v-6H9v6H4z',
    vcal: 'M4 5h16v15H4zM8 3v4m8-4v4M4 10h16',
    vd: 'M4 20V4m0 16h16M8 16v-5m4 5V8m4 8v-3',
    vl: 'M5 4h14v16H5zM8 8h8m-8 4h8m-8 4h5',
    vr: 'M4 20h16M6 20V5h12v15M9 9h2m2 0h2m-6 4h2m2 0h2m-4 7v-4h3v4',
    vk: 'M5 4h14v16H5zM8 8h8m-8 4h8m-8 4h5',
    vm: 'M4 5h16v14H4zM8 9h8m-8 4h5',
    vq: 'M5 12l4 4L19 6',
    vf: 'M16 20v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m6-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8m6-7a4 4 0 0 1 0 8m2 3h2a3 3 0 0 1 3 3v1',
    vp: 'M12 3v18m-8-9h16M5 6h14v12H5z',
    vn: 'M16 20v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m6-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8m8-2h4m-2-2v4',
    vi: 'M4 5h16v14H4zM8 9h8m-8 4h5',
    vs: 'M16 20v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m6-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
    vfg: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    vc: 'M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6zM9 12l2 2 4-4',
    vh: 'M12 7v5l3 2m5-2a8 8 0 1 1-2.3-5.7M20 4v5h-5',
    vpcentre: 'M3 20h18M5 20V7l7-4 7 4v13M9 10h1m4 0h1m-6 4h1m4 0h1m-4 6v-4h3v4',
    vz: 'M3 20h18M5 20V5h14v15M8 9h8m-8 4h8m-8 4h5',
  };

  return (
    <svg aria-hidden="true" className="sp-nav-icon" viewBox="0 0 24 24">
      <path d={paths[section]} />
    </svg>
  );
}

export function SectionPlaceholder() {
  const { section } = useParams();
  const { profile, permissions } = useAuth();

  if (!profile || !section || !canAccessSection(profile.role, section, permissions)) {
    return (
      <section className="sp-page">
        <h1 className="sp-page-title">Accès indisponible</h1>
        <p className="sp-muted">
          Cette rubrique n’est pas autorisée pour votre rôle ou votre centre.
        </p>
      </section>
    );
  }

  if (section === 'vn') return <MyStudentsPage />;
  if (section === 'vd') return <DashboardPage />;
  if (section === 'vcal') return <PlanningPage />;
  if (section === 'vl') return <PlanningPage view="sessions" />;
  if (section === 'vi') return <EnrollmentRequestsPage />;
  if (section === 'vz') return <CentreManagementPage />;
  if (section === 'vr') return <RoomsPage />;
  if (section === 'vf') return <TeachersPage />;
  if (section === 'vp') return <AttendancePage />;
  if (section === 'vs') return <StudentsPage />;
  if (section === 'vfg') return <FormationGroupsPage />;
  if (section === 'vpcentre') return <CentreProfilePage />;
  if (section === 'vk') return <SupportsPage />;
  if (section === 'vm') return <StudentWorkspacePage view="courses" />;
  if (section === 'vq') return <StudentWorkspacePage view="attendance" />;
  if (section === 'vc') return <CertificatesPage />;
  if (section === 'vh') return <HistoryPage />;

  return (
    <section className="sp-page">
      <p className="sp-page-eyebrow">Rubrique sélectionnée</p>
      <h1 className="sp-page-title">{SECTION_LABELS[section]}</h1>
      <p className="sp-muted">
        Cette rubrique n’a pas encore été migrée. Consultez l’application historique pour continuer
        à utiliser la fonctionnalité.
      </p>
    </section>
  );
}
