import { useEffect, useState } from 'react';
import { Alert, Button, EmptyState, LoadingState, PageHeader, Panel } from '../../components/ui';
import {
  getStudentWorkspace,
  type StudentWorkspace,
} from '../../data/repositories/studentWorkspaceRepository';
import { getSupabaseClient } from '../../data/supabase/client';
import { useAuth } from '../auth/AuthProvider';

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; workspace: StudentWorkspace };

const WEEKDAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const ATTENDANCE_LABELS = {
  present: 'Présent',
  retard: 'En retard',
  absent: 'Absent',
} as const;

function displayDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString('fr-FR');
}

export function StudentWorkspacePage({ view }: { view: 'courses' | 'attendance' | 'planning' | 'rooms' }) {
  const { profile, session } = useAuth();
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<PageState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    async function load() {
      if (!profile?.centreId) {
        setState({ status: 'error', message: 'Votre profil n’est pas rattaché à un centre.' });
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
      } catch (cause) {
        if (active) {
          setState({
            status: 'error',
            message: cause instanceof Error ? cause.message : 'Impossible de charger votre espace.',
          });
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [profile?.centreId, session?.user.email, reload]);

  const isCourses = view === 'courses' || view === 'planning';
  const isPlanning = view === 'planning';
  const isRooms = view === 'rooms';
  return (
    <section className="mx-auto w-full max-w-screen-2xl space-y-5">
      <PageHeader
        description={
          isPlanning
            ? 'Votre emploi du temps personnel, limité aux cours auxquels vous êtes inscrit.'
            : isRooms
              ? 'Consultez les salles prévues pour vos cours et leurs horaires.'
              : isCourses
                ? 'Retrouvez les séances planifiées pour les cours auxquels vous êtes inscrit.'
                : 'Consultez vos présences, retards et absences enregistrés par le centre.'
        }
        eyebrow="Espace étudiant"
        title={isPlanning ? 'Mon planning' : isRooms ? 'Mes salles de cours' : isCourses ? 'Mes cours' : 'Mes présences'}
      />
      {state.status === 'loading' && (
        <Panel>
          <LoadingState label="Chargement de votre espace étudiant…" />
        </Panel>
      )}
      {state.status === 'error' && (
        <Panel className="space-y-3">
          <EmptyState
            description={state.message}
            title="Votre espace étudiant n’a pas pu être chargé."
          />
          <Button onClick={() => setReload((value) => value + 1)} type="button" variant="secondary">
            Réessayer
          </Button>
        </Panel>
      )}
      {state.status === 'loaded' && !state.workspace.studentFound && (
        <Alert tone="warning">
          Votre compte n’est relié à aucun dossier étudiant dans ce centre. Demandez à
          l’administration de vérifier que votre dossier utilise l’adresse e-mail de connexion.
        </Alert>
      )}
      {state.status === 'loaded' && state.workspace.studentFound && isRooms && (
        state.workspace.courses.length === 0 ? (
          <EmptyState title="Aucune salle n’est associée à vos cours." description="Les salles apparaîtront ici lorsque l’administration aura affecté une salle à vos cours." />
        ) : (
          <div className="space-y-4">
            {[...new Set(state.workspace.courses.map((course) => course.room).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr')).map((room) => {
              const roomCourses = state.workspace.courses.filter((course) => course.room === room).sort((a, b) => a.weekday - b.weekday || a.startsAt.localeCompare(b.startsAt));
              return (
                <Panel key={room}>
                  <h2 className="text-lg font-semibold">Salle {room}</h2>
                  <div className="sp-table-wrap">
                    <table className="sp-table">
                      <thead><tr><th>Jour</th><th>Cours</th><th>Horaire</th><th>Formateur</th></tr></thead>
                      <tbody>{roomCourses.map((course) => (
                        <tr key={String(course.id)}>
                          <td>{course.startsOn && course.startsOn === course.endsOn ? displayDate(course.startsOn) : WEEKDAYS[course.weekday] ?? 'Jour à confirmer'}</td>
                          <td><strong>{course.subject}</strong></td>
                          <td>{course.startsAt.slice(0, 5)} – {course.endsAt.slice(0, 5)}</td>
                          <td>{course.teacher || '—'}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                </Panel>
              );
            })}
            {state.workspace.courses.some((course) => !course.room) && (
              <Panel><h2 className="font-semibold">Salle à confirmer</h2><p className="sp-muted">Certains cours n’ont pas encore de salle affectée.</p></Panel>
            )}
          </div>
        )
      )}
      {state.status === 'loaded' &&
        state.workspace.studentFound &&
        isCourses &&
        (state.workspace.courses.length === 0 ? (
          <EmptyState
            description="L’administration pourra vous inscrire à vos cours depuis la gestion des étudiants."
            title="Vous n’êtes inscrit à aucun cours pour le moment."
          />
        ) : (
          <Panel className="!p-0">
            <div className="sp-table-wrap">
              <table className="sp-table">
                <thead>
                  <tr>
                    <th>Séance</th>
                    <th>Horaire</th>
                    <th>Formateur</th>
                    <th>Salle</th>
                  </tr>
                </thead>
                <tbody>
                  {[...state.workspace.courses]
                    .sort(
                      (left, right) =>
                        left.weekday - right.weekday || left.startsAt.localeCompare(right.startsAt),
                    )
                    .map((course) => {
                      const oneOff = course.startsOn && course.startsOn === course.endsOn;
                      const weekday = WEEKDAYS[course.weekday] ?? 'Jour à confirmer';
                      return (
                        <tr key={String(course.id)}>
                          <td>
                            <strong>{course.subject}</strong>
                          </td>
                          <td>
                            {oneOff && course.startsOn ? displayDate(course.startsOn) : weekday}
                            <br />
                            <small>
                              {course.startsAt.slice(0, 5)} – {course.endsAt.slice(0, 5)}
                            </small>
                          </td>
                          <td>{course.teacher || '—'}</td>
                          <td>{course.room || '—'}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </Panel>
        ))}
      {state.status === 'loaded' && state.workspace.studentFound && !isCourses && !isRooms && (
        <>
          {state.workspace.attendance.length > 0 && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Panel>
                <strong className="text-2xl">
                  {state.workspace.attendance.length
                    ? `${Math.round((state.workspace.attendance.filter((item) => item.status !== 'absent').length / state.workspace.attendance.length) * 100)}%`
                    : '—'}
                </strong>
                <p className="sp-muted">Taux de présence</p>
              </Panel>
              <Panel>
                <strong className="text-2xl">
                  {state.workspace.attendance.filter((item) => item.status === 'present').length}
                </strong>
                <p className="sp-muted">Présences</p>
              </Panel>
              <Panel>
                <strong className="text-2xl">
                  {state.workspace.attendance.filter((item) => item.status === 'retard').length}
                </strong>
                <p className="sp-muted">Retards</p>
              </Panel>
              <Panel>
                <strong className="text-2xl">
                  {state.workspace.attendance.filter((item) => item.status === 'absent').length}
                </strong>
                <p className="sp-muted">Absences</p>
              </Panel>
            </div>
          )}
          {state.workspace.attendance.length === 0 ? (
            <EmptyState
              description="Vos présences apparaîtront après le pointage des séances."
              title="Aucune présence enregistrée."
            />
          ) : (
            <Panel className="!p-0">
              <div className="sp-table-wrap">
                <table className="sp-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Séance</th>
                      <th>Statut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.workspace.attendance.map((item, index) => (
                      <tr key={`${item.courseId}-${item.date}-${index}`}>
                        <td>{displayDate(item.date)}</td>
                        <td>{item.subject}</td>
                        <td>{ATTENDANCE_LABELS[item.status]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}
    </section>
  );
}
