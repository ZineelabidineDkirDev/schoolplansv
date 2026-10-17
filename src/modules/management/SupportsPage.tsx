import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, EmptyState, LoadingState, PageHeader, Panel, confirmAction, notify } from '../../components/ui';
import {
  deleteCourseSupport,
  getCourseSupports,
  getSupportSignedUrl,
  uploadCourseSupport,
  type CourseSupport,
} from '../../data/repositories/supportRepository';
import { getPlanningData } from '../../data/repositories/planningRepository';
import { getStudentWorkspace } from '../../data/repositories/studentWorkspaceRepository';
import { getSupabaseClient } from '../../data/supabase/client';
import type { StudentIdentifier } from '../../types/students';
import type { PlanningCourse } from '../../types/planning';
import { useAuth } from '../auth/AuthProvider';

type SupportCourse = { id: StudentIdentifier; label: string };
type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'loaded';
      documents: CourseSupport[];
      courses: SupportCourse[];
      studentFound: boolean;
    };

function fileSize(size: number) {
  return size >= 1024 * 1024
    ? `${(size / (1024 * 1024)).toFixed(1)} Mo`
    : `${Math.max(1, Math.round(size / 1024))} Ko`;
}

function sessionCourse(course: PlanningCourse): SupportCourse {
  return {
    id: course.id,
    label: `${course.subjectName} · ${course.teacherName}${course.roomName ? ` · ${course.roomName}` : ''}`,
  };
}

export function SupportsPage() {
  const { profile, session } = useAuth();
  const [state, setState] = useState<PageState>({ status: 'loading' });
  const [reload, setReload] = useState(0);
  const [selectedCourse, setSelectedCourse] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessageState] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const setMessage = (value: { tone: 'success' | 'error'; text: string } | null) => {
    setMessageState(value);
    if (value) notify(value.text, value.tone === 'error' ? 'error' : 'success');
  };

  useEffect(() => {
    let active = true;
    async function load() {
      if (!profile?.centreId) {
        setState({ status: 'error', message: 'Votre profil n’est pas rattaché à un centre.' });
        return;
      }
      setState({ status: 'loading' });
      try {
        const client = getSupabaseClient();
        if (profile.role === 'etudiant') {
          const workspace = await getStudentWorkspace(
            client,
            profile.centreId,
            session?.user.email ?? '',
          );
          if (!workspace.studentFound) {
            if (active) {
              setState({
                status: 'loaded',
                documents: [],
                courses: [],
                studentFound: false,
              });
            }
            return;
          }
          const courseIds = workspace.courses.map((course) => course.id);
          const courseById = new Map(
            workspace.courses.map((course) => [String(course.id), course]),
          );
          const documents = await getCourseSupports(client, profile.centreId, courseIds);
          if (active) {
            setState({
              status: 'loaded',
              documents,
              courses: [...courseById.values()].map((course) => ({
                id: course.id,
                label: course.subject,
              })),
              studentFound: true,
            });
          }
          return;
        }
        if (!['admin', 'director', 'formateur'].includes(profile.role)) {
          throw new Error('Votre rôle ne permet pas de consulter les supports du centre.');
        }
        const planning = await getPlanningData(client, profile.centreId, profile.id, profile.role);
        const documents = await getCourseSupports(client, profile.centreId);
        if (active) {
          setState({
            status: 'loaded',
            documents,
            courses: planning.courses.map(sessionCourse),
            studentFound: true,
          });
        }
      } catch (cause) {
        if (active) {
          setState({
            status: 'error',
            message: cause instanceof Error ? cause.message : 'Impossible de charger les supports.',
          });
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [profile?.centreId, profile?.id, profile?.role, session?.user.email, reload]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.status !== 'loaded' || !profile?.centreId || !file) {
      setMessage({ tone: 'error', text: 'Choisissez un fichier à importer.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const support = await uploadCourseSupport(getSupabaseClient(), {
        centreId: profile.centreId,
        courseId: selectedCourse,
        title,
        description,
        file,
      });
      setState({ ...state, documents: [support, ...state.documents] });
      setTitle('');
      setDescription('');
      setFile(null);
      setSelectedCourse('');
      const fileInput = document.getElementById('support-file') as HTMLInputElement | null;
      if (fileInput) fileInput.value = '';
      setMessage({
        tone: 'success',
        text: 'Document importé. Les étudiants inscrits au cours peuvent le consulter et le télécharger.',
      });
    } catch (cause) {
      setMessage({
        tone: 'error',
        text: cause instanceof Error ? cause.message : 'Impossible d’importer le document.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function openSupport(support: CourseSupport, download: boolean) {
    setMessage(null);
    try {
      const url = await getSupportSignedUrl(getSupabaseClient(), support, download);
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      if (download) link.download = support.fileName;
      document.body.append(link);
      link.click();
      link.remove();
    } catch (cause) {
      setMessage({
        tone: 'error',
        text: cause instanceof Error ? cause.message : 'Impossible d’ouvrir ce support.',
      });
    }
  }

  async function removeSupport(support: CourseSupport) {
    if (!profile?.centreId || profile.role !== 'formateur' || state.status !== 'loaded') return;
    if (!await confirmAction('Supprimer ce document ?')) return;
    const ownCourseIds = state.courses.map((course) => course.id);
    setMessage(null);
    try {
      await deleteCourseSupport(getSupabaseClient(), profile.centreId, support, ownCourseIds);
      setState({
        ...state,
        documents: state.documents.filter((item) => String(item.id) !== String(support.id)),
      });
      setMessage({ tone: 'success', text: 'Le support a été supprimé.' });
    } catch (cause) {
      setMessage({
        tone: 'error',
        text: cause instanceof Error ? cause.message : 'Impossible de supprimer ce support.',
      });
    }
  }

  return (
    <section className="mx-auto w-full max-w-screen-2xl space-y-5">
      <PageHeader
        description="Consultez les ressources pédagogiques associées à vos cours. Les fichiers sont accessibles par lien temporaire sécurisé."
        eyebrow="Ressources pédagogiques"
        title="Supports de cours"
      />
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      {state.status === 'loading' && (
        <Panel>
          <LoadingState label="Chargement des supports…" />
        </Panel>
      )}
      {state.status === 'error' && (
        <Panel className="space-y-3">
          <EmptyState description={state.message} title="Les supports ne sont pas disponibles." />
          <Button onClick={() => setReload((value) => value + 1)} type="button" variant="secondary">
            Réessayer
          </Button>
        </Panel>
      )}
      {state.status === 'loaded' && !state.studentFound && (
        <Alert tone="warning">
          Votre compte n’est pas relié à un dossier étudiant de ce centre. Demandez à
          l’administration de vérifier l’adresse e-mail associée à votre dossier.
        </Alert>
      )}
      {state.status === 'loaded' && profile?.role === 'formateur' && (
        <Panel>
          <h2 className="management-panel-title">Partager un support</h2>
          {state.courses.length === 0 ? (
            <EmptyState
              description="Affectez-vous d’abord à un cours dans le planning."
              title="Aucun cours disponible."
            />
          ) : (
            <form className="management-editor-form" onSubmit={(event) => void submit(event)}>
              <label className="sp-form-field">
                Cours
                <select
                  className="sp-field"
                  onChange={(event) => setSelectedCourse(event.target.value)}
                  required
                  value={selectedCourse}
                >
                  <option value="">Sélectionner un cours</option>
                  {state.courses.map((course) => (
                    <option key={String(course.id)} value={String(course.id)}>
                      {course.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="sp-form-field">
                Titre
                <input
                  className="sp-field"
                  maxLength={150}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  value={title}
                />
              </label>
              <label className="sp-form-field management-editor-wide">
                Description
                <textarea
                  className="sp-field management-textarea"
                  maxLength={1000}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={3}
                  value={description}
                />
              </label>
              <label className="sp-form-field management-editor-wide">
                Fichier (20 Mo maximum)
                <input
                  accept="application/pdf,image/*,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt"
                  className="sp-field"
                  id="support-file"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  required
                  type="file"
                />
              </label>
              <div className="management-editor-actions management-editor-wide">
                <Button disabled={busy} type="submit">
                  {busy ? 'Importation…' : 'Importer le support'}
                </Button>
              </div>
            </form>
          )}
        </Panel>
      )}
      {state.status === 'loaded' && state.studentFound && (
        <Panel className="!p-0">
          {state.documents.length === 0 ? (
            <EmptyState
              description="Les documents de vos cours apparaîtront ici."
              title="Aucun support disponible."
            />
          ) : (
            <div className="sp-table-wrap">
              <table className="sp-table">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Cours</th>
                    <th>Fichier</th>
                    <th>Ajouté le</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {state.documents.map((support) => {
                    const course = state.courses.find(
                      (item) => String(item.id) === String(support.courseId),
                    );
                    return (
                      <tr key={String(support.id)}>
                        <td>
                          <strong>{support.title}</strong>
                          {support.description && <p className="sp-muted">{support.description}</p>}
                        </td>
                        <td>{course?.label ?? 'Cours associé'}</td>
                        <td>
                          {support.fileName}
                          <br />
                          <small>{fileSize(support.size)}</small>
                        </td>
                        <td>{new Date(support.createdAt).toLocaleDateString('fr-FR')}</td>
                        <td>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              onClick={() => void openSupport(support, false)}
                              type="button"
                              variant="secondary"
                            >
                              Voir
                            </Button>
                            <Button
                              onClick={() => void openSupport(support, true)}
                              type="button"
                              variant="secondary"
                            >
                              Télécharger
                            </Button>
                            {profile?.role === 'formateur' && (
                              <Button
                                onClick={() => void removeSupport(support)}
                                type="button"
                                variant="danger"
                              >
                                Supprimer
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </section>
  );
}
