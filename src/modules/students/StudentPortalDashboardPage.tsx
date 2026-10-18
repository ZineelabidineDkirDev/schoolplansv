import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, EmptyState, LoadingState, PageHeader, Panel } from '../../components/ui';
import { getStudentWorkspace, type StudentWorkspace } from '../../data/repositories/studentWorkspaceRepository';
import { getSupabaseClient } from '../../data/supabase/client';
import { useAuth } from '../auth/AuthProvider';
import { StudentWorkspacePage } from './StudentWorkspacePage';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; workspace: StudentWorkspace };

const DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function StudentPortalDashboardPage() {
  const { profile, session } = useAuth();
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    async function load() {
      if (!profile?.centreId) {
        setState({ status: 'error', message: 'Votre compte étudiant n’est pas rattaché à un centre.' });
        return;
      }
      setState({ status: 'loading' });
      try {
        const workspace = await getStudentWorkspace(
          getSupabaseClient(),
          profile.centreId,
          session?.user.email ?? '',
        );
        if (active) setState({ status: 'loaded', workspace });
      } catch (error) {
        if (active) setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Impossible de charger votre espace étudiant.',
        });
      }
    }
    void load();
    return () => { active = false; };
  }, [profile?.centreId, session?.user.email, reload]);

  const stats = useMemo(() => {
    if (state.status !== 'loaded') return null;
    const attendance = state.workspace.attendance;
    const present = attendance.filter((item) => item.status === 'present' || item.status === 'retard').length;
    return {
      courses: state.workspace.courses.length,
      attendance: attendance.length,
      absences: attendance.filter((item) => item.status === 'absent').length,
      rate: attendance.length ? Math.round((present / attendance.length) * 100) : null,
    };
  }, [state]);

  const upcoming = useMemo(() => {
    if (state.status !== 'loaded') return [];
    const now = new Date();
    const weekday = (now.getDay() + 6) % 7;
    return state.workspace.courses
      .filter((course) => {
        if (course.startsOn && course.startsOn > todayKey()) return true;
        if (course.endsOn && course.endsOn < todayKey()) return false;
        return true;
      })
      .sort((a, b) => {
        const dayA = (a.weekday - weekday + 7) % 7;
        const dayB = (b.weekday - weekday + 7) % 7;
        return dayA - dayB || a.startsAt.localeCompare(b.startsAt);
      })
      .slice(0, 3);
  }, [state]);

  return (
    <section className="student-portal mx-auto w-full max-w-screen-2xl space-y-6">
      <PageHeader
        eyebrow="Mon espace"
        title={`Bonjour ${profile?.fullName?.trim().split(/\\s+/)[0] || 'etudiant'} 👋`}
        description="Retrouvez en un coup d’œil vos cours, votre présence et vos ressources pédagogiques."
      />
      {state.status === 'loading' && <Panel><LoadingState label="Chargement de votre espace étudiant…" /></Panel>}
      {state.status === 'error' && (
        <Panel className="space-y-3">
          <EmptyState title="Votre tableau de bord est indisponible." description={state.message} />
          <Button onClick={() => setReload((value) => value + 1)} type="button" variant="secondary">Réessayer</Button>
        </Panel>
      )}
      {state.status === 'loaded' && !state.workspace.studentFound && (
        <Alert tone="warning">
          Votre compte Google est connecté, mais aucun dossier étudiant n’est associé à cette adresse e-mail.
          Contactez le directeur du centre pour vérifier votre inscription.
        </Alert>
      )}
      {state.status === 'loaded' && state.workspace.studentFound && stats && (
        <>
          <div className="student-portal-metrics">
            <Panel className="student-portal-metric">
              <span className="student-portal-metric-icon">▦</span>
              <span className="sp-muted">Mes cours</span>
              <strong>{stats.courses}</strong>
              <Link to="/app/vm">Voir mon emploi du temps →</Link>
            </Panel>
            <Panel className="student-portal-metric">
              <span className="student-portal-metric-icon">✓</span>
              <span className="sp-muted">Taux de présence</span>
              <strong>{stats.rate === null ? '—' : `${stats.rate}%`}</strong>
              <Link to="/app/vq">Consulter mes présences →</Link>
            </Panel>
            <Panel className="student-portal-metric">
              <span className="student-portal-metric-icon">◷</span>
              <span className="sp-muted">Absences</span>
              <strong>{stats.absences}</strong>
              <Link to="/app/vq">Voir l’historique →</Link>
            </Panel>
          </div>
          <section aria-label="Rapport de formation étudiant" className="student-portal-report">
            <StudentWorkspacePage view="report" />
          </section>
          <div className="student-portal-content-grid">
            <Panel className="student-portal-next">
              <div className="student-portal-section-heading">
                <div><span className="sp-page-eyebrow">Organisation</span><h2>Mes prochaines séances</h2></div>
                <Link to="/app/vm">Tout voir</Link>
              </div>
              {upcoming.length === 0 ? (
                <EmptyState title="Aucune séance à venir" description="Votre emploi du temps apparaîtra ici dès que des cours seront planifiés." />
              ) : (
                <div className="student-portal-session-list">
                  {upcoming.map((course) => (
                    <article className="student-portal-session" key={String(course.id)}>
                      <div className="student-portal-session-date">
                        <strong>{DAYS[course.weekday] ?? 'Cours'}</strong>
                        <span>{course.startsAt.slice(0, 5)}</span>
                      </div>
                      <div className="student-portal-session-info">
                        <strong>{course.subject}</strong>
                        <span>{course.teacher || 'Formateur à confirmer'}{course.room ? ` · Salle ${course.room}` : ''}</span>
                      </div>
                      <span className="student-portal-session-time">{course.startsAt.slice(0, 5)}–{course.endsAt.slice(0, 5)}</span>
                    </article>
                  ))}
                </div>
              )}
            </Panel>
            <Panel className="student-portal-resources">
              <span className="student-portal-resource-icon">▤</span>
              <h2>Mes supports de cours</h2>
              <p className="sp-muted">Retrouvez les documents et ressources partagés par vos formateurs.</p>
              <Link className="student-portal-resource-link" to="/app/vk">Accéder aux supports <span aria-hidden="true">→</span></Link>
              <div className="student-portal-resource-note">Accès limité aux ressources autorisées pour vos cours.</div>
            </Panel>
          </div>
        </>
      )}
    </section>
  );
}
