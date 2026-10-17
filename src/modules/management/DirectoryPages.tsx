import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Button, EmptyState, LoadingState, Modal, PageHeader, Panel, confirmAction, notify } from '../../components/ui';
import { getWeekOccurrences } from '../../business/planning/planningSchedule';
import { getPlanningData } from '../../data/repositories/planningRepository';
import {
  calculateGroupEndDate,
  createGroup,
  createModuleForCentre,
  deleteFormation,
  deleteGroup,
  getFormationGroupData,
  saveFormation,
  updateGroup,
  type FormationInput,
  type ModuleDomain,
  type ModuleOption,
} from '../../data/repositories/formationGroupRepository';
import {
  getAttendanceSheet,
  getCentreStudents,
  saveAttendance,
} from '../../data/repositories/managementRepository';
import {
  createCentreStudent,
  deleteCentreStudent,
  updateCentreStudent,
  type StudentRecordInput,
} from '../../data/repositories/studentManagementRepository';
import { assignStudentToGroup, getStudentCourseEnrollmentIds, setStudentCourseEnrollment } from '../../data/repositories/studentAssignmentRepository';
import { createCentreRoom, updateCentreRoom, deleteCentreRoom, createCentreTeacher, updateCentreTeacher, deleteCentreTeacher, type RoomInput, type TeacherInput } from '../../data/repositories/directoryCrudRepository';
import { getSupabaseClient } from '../../data/supabase/client';
import type { PlanningData, PlanningOccurrence } from '../../types/planning';
import type { AttendanceSheet, AttendanceStatus, ManagedStudent } from '../../types/management';
import { useAuth } from '../auth/AuthProvider';

type PlanningState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: PlanningData };

type StudentState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; students: ManagedStudent[] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur inattendue est survenue.';
}

function usePlanningData() {
  const { profile } = useAuth();
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<PlanningState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    async function load() {
      if (!profile) return;
      if (profile.role === 'etudiant') {
        setState({
          status: 'error',
          message: 'Cette rubrique n’est pas disponible pour votre rôle.',
        });
        return;
      }
      setState({ status: 'loading' });
      try {
        const data = await getPlanningData(
          getSupabaseClient(),
          profile.centreId ?? '',
          profile.id,
          profile.role,
        );
        if (active) setState({ status: 'loaded', data });
      } catch (error) {
        if (active) setState({ status: 'error', message: errorMessage(error) });
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [profile, reloadKey]);

  return { profile, state, reload: () => setReloadKey((key) => key + 1) };
}

function PageFrame({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="mx-auto w-full max-w-screen-2xl space-y-5">
      <PageHeader
        actions={actions}
        description={description}
        eyebrow="Gestion du centre"
        title={title}
      />
      {children}
    </section>
  );
}

function PlanningLoadState({ state, retry }: { state: PlanningState; retry: () => void }) {
  if (state.status === 'loading') {
    return (
      <Panel>
        <LoadingState label="Chargement des données du centre…" />
      </Panel>
    );
  }
  if (state.status === 'error') {
    return (
      <Alert tone="error">
        <p>Les données de cette rubrique n’ont pas pu être chargées.</p>
        <p>{state.message}</p>
        <Button onClick={retry} type="button" variant="secondary">
          Réessayer
        </Button>
      </Alert>
    );
  }
  return null;
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase('fr') ?? '')
    .join('');
}

function courseDuration(course: PlanningData['courses'][number]): number {
  const [startHour, startMinute] = course.startsAt.split(':').map(Number);
  const [endHour, endMinute] = course.endsAt.split(':').map(Number);
  const minutes = endHour * 60 + endMinute - startHour * 60 - startMinute;
  return Number.isFinite(minutes) && minutes > 0 ? minutes / 60 : 0;
}

function toMinutes(time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

const ROOM_DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

export function RoomsPage() {
  const { profile } = useAuth();
  const { state, reload } = usePlanningData();
  const [editingId, setEditingId] = useState<string | number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setErrorState] = useState<string | null>(null);
  const setError = (value: string | null) => {
    setErrorState(value);
    if (value) notify(value, 'error');
  };
  const [message, setMessageState] = useState<string | null>(null);
  const setMessage = (value: string | null) => {
    setMessageState(value);
    if (value) notify(value, 'success');
  };
  const [form, setForm] = useState<RoomInput>({ name: '', type: '', capacity: 30 });
  const canManage = profile?.role === 'admin' || profile?.role === 'director';
  function openForm(room?: PlanningData['filters']['rooms'][number]) {
    setEditingId(room?.id ?? null);
    setForm(room ? { name: room.name, type: room.type ?? '', capacity: room.capacity } : { name: '', type: '', capacity: 30 });
    setError(null); setMessage(null); setFormOpen(true);
  }
  async function saveRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile?.centreId || !canManage) return;
    setSaving(true); setError(null); setMessage(null);
    try {
      if (editingId === null) await createCentreRoom(getSupabaseClient(), profile.centreId, form);
      else await updateCentreRoom(getSupabaseClient(), profile.centreId, editingId, form);
      setMessage(editingId === null ? 'Salle créée.' : 'Salle modifiée.');
      setFormOpen(false); reload();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  async function removeRoom(room: PlanningData['filters']['rooms'][number]) {
    if (!profile?.centreId || !canManage || !await confirmAction(`Supprimer la salle « ${room.name} » ?`)) return;
    setError(null); setMessage(null);
    try { await deleteCentreRoom(getSupabaseClient(), profile.centreId, room.id); setMessage('Salle supprimée.'); reload(); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  return (
    <PageFrame actions={canManage ? <Button onClick={() => openForm()} type="button">+ Ajouter une salle</Button> : undefined}
      description="Salles du centre et volume d’occupation hebdomadaire selon les séances planifiées." title="Salles">
      {error && <Alert tone="error"><p>{error}</p></Alert>}{message && <Alert tone="success"><p>{message}</p></Alert>}
      {formOpen && canManage && <Modal label={editingId === null ? 'Nouvelle salle' : 'Modifier la salle'} onClose={() => setFormOpen(false)}><Panel className="management-editor">
        <h2>{editingId === null ? 'Nouvelle salle' : 'Modifier la salle'}</h2>
        <form className="sp-form-grid" onSubmit={(event) => void saveRoom(event)}>
          <label className="sp-form-field">Nom<input className="sp-field" required value={form.name} onChange={(event) => setForm((v) => ({ ...v, name: event.target.value }))} /></label>
          <label className="sp-form-field">Type<input className="sp-field" value={form.type} onChange={(event) => setForm((v) => ({ ...v, type: event.target.value }))} /></label>
          <label className="sp-form-field">Capacité<input className="sp-field" min="1" type="number" value={form.capacity ?? ''} onChange={(event) => setForm((v) => ({ ...v, capacity: event.target.value ? Number(event.target.value) : null }))} /></label>
          <div className="management-toolbar"><Button disabled={saving} type="submit">{saving ? 'Enregistrement…' : 'Enregistrer'}</Button><Button onClick={() => setFormOpen(false)} type="button" variant="secondary">Annuler</Button></div>
        </form>
      </Panel></Modal>}
      <PlanningLoadState retry={reload} state={state} />
      {state.status === 'loaded' && (state.data.filters.rooms.length === 0 ? <EmptyState title="Aucune salle n’est enregistrée dans ce centre." /> :
        <div className="management-card-grid">{state.data.filters.rooms.map((room) => {
          const courses = state.data.courses.filter((course) => String(course.roomId) === String(room.id));
          const occupiedHours = courses.reduce((total, course) => total + courseDuration(course), 0);
          const weeklyHours = 66; const freeHours = Math.max(weeklyHours - occupiedHours, 0);
          const now = new Date(); const today = (now.getDay() + 6) % 7; const currentMinutes = now.getHours() * 60 + now.getMinutes();
          const todayCourses = courses.filter((course) => course.weekday === today).sort((a, b) => toMinutes(a.startsAt) - toMinutes(b.startsAt));
          const currentCourse = todayCourses.find((course) => toMinutes(course.startsAt) <= currentMinutes && currentMinutes < toMinutes(course.endsAt));
          const nextCourse = todayCourses.find((course) => toMinutes(course.startsAt) > currentMinutes);
          const isOpen = today < ROOM_DAYS.length && currentMinutes >= 8 * 60 && currentMinutes < 19 * 60;
          const roomState = currentCourse ? { tone: 'busy', label: `Occupée jusqu’à ${currentCourse.endsAt.slice(0, 5)}` } : !isOpen ? { tone: 'closed', label: 'Fermée actuellement' } : nextCourse ? { tone: 'free', label: `Libre jusqu’à ${nextCourse.startsAt.slice(0, 5)}` } : { tone: 'free', label: 'Libre jusqu’à la fermeture' };
          return <Panel className="management-room-card" key={room.id}>
            <header className="management-room-heading"><h2>{room.name}</h2><span className={`management-room-status is-${roomState.tone}`}>{roomState.label}</span></header>
            <p className="management-room-description">{room.type || 'Salle de formation'} · {room.capacity ?? '—'} places</p>
            <div aria-label={`Disponibilité hebdomadaire de ${room.name}`}>{ROOM_DAYS.map((day, weekday) => <div className="management-room-day" key={day}><span>{day.slice(0, 3)}</span>{Array.from({ length: 11 }, (_, hour) => {
              const startsAt = 8 * 60 + hour * 60; const endsAt = startsAt + 60;
              const course = courses.find((item) => item.weekday === weekday && toMinutes(item.startsAt) < endsAt && toMinutes(item.endsAt) > startsAt);
              return <span aria-label={`${day}, ${hour + 8} h : ${course ? `${course.subjectName}, ${course.teacherName}` : 'libre'}`} className={`management-room-hour${course ? ' is-occupied' : ''}`} key={hour} role="img" title={course ? `${course.subjectName} · ${course.teacherName}` : 'Libre'} />;
            })}</div>)}</div>
            <div className="management-room-totals"><span>Occupée {occupiedHours.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} h / {weeklyHours} h</span><span>Libre {freeHours.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} h</span></div>
            {canManage && <div className="management-toolbar"><Button onClick={() => openForm(room)} type="button" variant="secondary">Modifier</Button><Button onClick={() => void removeRoom(room)} type="button" variant="danger">Supprimer</Button></div>}
          </Panel>;
        })}</div>)}
    </PageFrame>
  );
}

export function TeachersPage() {
  const { profile } = useAuth();
  const { state, reload } = usePlanningData();
  const [editingId, setEditingId] = useState<string | number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setErrorState] = useState<string | null>(null);
  const setError = (value: string | null) => {
    setErrorState(value);
    if (value) notify(value, 'error');
  };
  const [message, setMessageState] = useState<string | null>(null);
  const setMessage = (value: string | null) => {
    setMessageState(value);
    if (value) notify(value, 'success');
  };
  const [form, setForm] = useState<TeacherInput>({ name: '', email: '' });
  const canManage = profile?.role === 'admin' || profile?.role === 'director';
  function openForm(teacher?: PlanningData['filters']['teachers'][number]) {
    setEditingId(teacher?.id ?? null); setForm(teacher ? { name: teacher.name, email: teacher.email ?? '' } : { name: '', email: '' });
    setError(null); setMessage(null); setFormOpen(true);
  }
  async function saveTeacher(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!profile?.centreId || !canManage) return;
    setSaving(true); setError(null); setMessage(null);
    try {
      if (editingId === null) await createCentreTeacher(getSupabaseClient(), profile.centreId, form);
      else await updateCentreTeacher(getSupabaseClient(), profile.centreId, editingId, form);
      setMessage(editingId === null ? 'Formateur créé.' : 'Formateur modifié.'); setFormOpen(false); reload();
    } catch (cause) { setError(errorMessage(cause)); } finally { setSaving(false); }
  }
  async function removeTeacher(teacher: PlanningData['filters']['teachers'][number]) {
    if (!profile?.centreId || !canManage || !await confirmAction(`Supprimer la fiche de ${teacher.name} ?`)) return;
    setError(null); setMessage(null);
    try { await deleteCentreTeacher(getSupabaseClient(), profile.centreId, teacher.id); setMessage('Formateur supprimé.'); reload(); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  return <PageFrame actions={canManage ? <Button onClick={() => openForm()} type="button">+ Ajouter un formateur</Button> : undefined}
    description="Équipe pédagogique, matières enseignées et séances attribuées dans le centre." title="Formateurs">
    {error && <Alert tone="error"><p>{error}</p></Alert>}{message && <Alert tone="success"><p>{message}</p></Alert>}
    {formOpen && canManage && <Modal label={editingId === null ? 'Nouveau formateur' : 'Modifier le formateur'} onClose={() => setFormOpen(false)}><Panel className="management-editor"><h2>{editingId === null ? 'Nouveau formateur' : 'Modifier le formateur'}</h2>
      <form className="sp-form-grid" onSubmit={(event) => void saveTeacher(event)}>
        <label className="sp-form-field"><span className="sp-field-label">Nom complet</span><input className="sp-field" required value={form.name} onChange={(event) => setForm((v) => ({ ...v, name: event.target.value }))} /></label>
        <label className="sp-form-field"><span className="sp-field-label">E-mail</span><input className="sp-field" type="email" value={form.email} onChange={(event) => setForm((v) => ({ ...v, email: event.target.value }))} /></label>
        <p className="management-muted">Le compte de connexion et les matières associées ne sont pas modifiés par ce formulaire.</p>
        <div className="management-toolbar"><Button disabled={saving} type="submit">{saving ? 'Enregistrement…' : 'Enregistrer'}</Button><Button onClick={() => setFormOpen(false)} type="button" variant="secondary">Annuler</Button></div>
      </form></Panel></Modal>}
    <PlanningLoadState retry={reload} state={state} />
    {state.status === 'loaded' && (state.data.filters.teachers.length === 0 ? <EmptyState title="Aucun formateur n’est enregistré dans ce centre." /> :
      <div className="management-card-grid management-four-column-grid">{state.data.filters.teachers.map((teacher) => {
        const courses = state.data.courses.filter((course) => String(course.teacherId) === String(teacher.id));
        const subjects = state.data.subjectIdsByTeacher[String(teacher.id)] ?? [];
        const hours = courses.reduce((total, course) => total + courseDuration(course), 0);
        return <Panel className="management-card" key={teacher.id}>
          <div className="management-card-heading"><span aria-hidden="true" className="management-avatar">{initials(teacher.name)}</span><div><h2>{teacher.name}</h2><p>{teacher.email ?? 'Adresse e-mail non renseignée'}</p></div></div>
          <div className="management-chip-list">{subjects.map((subjectId) => { const subject = state.data.filters.subjects.find((item) => String(item.id) === String(subjectId)); return subject ? <span className="management-chip" key={subjectId}>{subject.name}</span> : null; })}
            {subjects.length === 0 && <span className="management-muted">Aucune matière associée</span>}</div>
          <div className="management-metrics"><div><span>Séances / semaine</span><strong>{courses.length}</strong></div><div><span>Heures planifiées</span><strong>{hours.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} h</strong></div></div>
          <p className="management-card-note">{teacher.profileId ? 'Compte de connexion associé' : 'Aucun compte associé'}</p>
          {canManage && <div className="management-toolbar"><Button onClick={() => openForm(teacher)} type="button" variant="secondary">Modifier</Button><Button disabled={Boolean(teacher.profileId || courses.length)} onClick={() => void removeTeacher(teacher)} type="button" variant="danger">Supprimer</Button></div>}
        </Panel>;
      })}</div>)}
  </PageFrame>;
}

export function FormationGroupsPage() {
  const { profile } = useAuth();
  const { state, reload } = usePlanningData();
  const [selectedFormationId, setSelectedFormationId] = useState('');
  const [modules, setModules] = useState<ModuleOption[]>([]);
  const [domains, setDomains] = useState<ModuleDomain[]>([]);
  const [studentCounts, setStudentCounts] = useState<Map<string, number>>(new Map());
  const [formOpen, setFormOpen] = useState(false);
  const [groupFormOpen, setGroupFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setErrorState] = useState<string | null>(null);
  const setError = (value: string | null) => {
    setErrorState(value);
    if (value) notify(value, 'error');
  };
  const [message, setMessageState] = useState<string | null>(null);
  const setMessage = (value: string | null) => {
    setMessageState(value);
    if (value) notify(value, 'success');
  };
  const [searchModules, setSearchModules] = useState('');
  const [newModuleName, setNewModuleName] = useState('');
  const [newModuleDomain, setNewModuleDomain] = useState('');
  const [formationForm, setFormationForm] = useState<FormationInput>({
    name: '',
    duration: '',
    hoursPerWeek: 5,
    description: '',
    moduleIds: [],
  });
  const [groupForm, setGroupForm] = useState<{ id?: string | number; name: string; formationId: string; teacherId: string; startsOn: string; capacity: number }>({
    name: '',
    formationId: '',
    teacherId: '',
    startsOn: isoDate(new Date()),
    capacity: 30,
  });
  const canManage = profile?.role === 'admin' || profile?.role === 'director';

  async function refreshFormations() {
    reload();
    if (profile?.centreId) {
      const [catalog, students] = await Promise.all([
        getFormationGroupData(getSupabaseClient(), profile.centreId),
        getCentreStudents(getSupabaseClient(), profile.centreId),
      ]);
      setModules(catalog.modules);
      setDomains(catalog.domains);
      setStudentCounts(
        students.reduce((counts, student) => {
          if (student.groupId !== null) {
            const key = String(student.groupId);
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          return counts;
        }, new Map<string, number>()),
      );
    }
  }

  useEffect(() => {
    let active = true;
    async function loadAuxiliaryData() {
      if (!profile?.centreId) return;
      try {
        const [catalog, students] = await Promise.all([
          getFormationGroupData(getSupabaseClient(), profile.centreId),
          getCentreStudents(getSupabaseClient(), profile.centreId),
        ]);
        if (!active) return;
        setModules(catalog.modules);
        setDomains(catalog.domains);
        setStudentCounts(
          students.reduce((counts, student) => {
            if (student.groupId !== null) {
              const key = String(student.groupId);
              counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            return counts;
          }, new Map<string, number>()),
        );
      } catch (cause) {
        if (active) setError(errorMessage(cause));
      }
    }
    void loadAuxiliaryData();
    return () => {
      active = false;
    };
  }, [profile?.centreId]);

  const formations = state.status === 'loaded' ? state.data.filters.formations : [];
  const selectedFormation = formations.find(
    (formation) => String(formation.id) === selectedFormationId,
  );
  const selectedGroups =
    state.status === 'loaded'
      ? state.data.filters.groups.filter(
          (group) => String(group.formationId) === selectedFormationId,
        )
      : [];
  const filteredModules = modules.filter((module) =>
    module.name.toLocaleLowerCase('fr').includes(searchModules.trim().toLocaleLowerCase('fr')),
  );

  function startFormationForm(formation?: (typeof formations)[number]) {
    setError(null);
    setMessage(null);
    setSearchModules('');
    setNewModuleName('');
    setNewModuleDomain('');
    setFormationForm({
      ...(formation ? { id: formation.id } : {}),
      name: formation?.name ?? '',
      duration: formation?.duration ?? '',
      hoursPerWeek: Number(formation?.hoursPerWeek ?? 5),
      description: formation?.description ?? '',
      moduleIds: formation
        ? state.status === 'loaded'
          ? (state.data.subjectIdsByFormation[String(formation.id)] ?? [])
          : []
        : [],
    });
    setFormOpen(true);
  }

  async function submitFormation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile?.centreId || !canManage) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await saveFormation(getSupabaseClient(), profile.centreId, formationForm);
      setFormOpen(false);
      setMessage('Formation enregistrée avec succès.');
      await refreshFormations();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteFormation(formationId: string | number) {
    if (
      !profile?.centreId ||
      !canManage ||
      !await confirmAction('Voulez-vous supprimer cette formation ?')
    ) {
      return;
    }
    setError(null);
    setMessage(null);
    try {
      await deleteFormation(getSupabaseClient(), profile.centreId, formationId);
      if (selectedFormationId === String(formationId)) setSelectedFormationId('');
      setMessage('Formation supprimée.');
      await refreshFormations();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function startGroupForm(
    formationId = selectedFormationId,
    group?: PlanningData['filters']['groups'][number],
  ) {
    setError(null);
    setMessage(null);
    setGroupForm({
      ...(group ? { id: group.id } : {}),
      name: group?.name ?? '',
      formationId: String(group?.formationId ?? formationId),
      teacherId: group?.teacherId == null ? '' : String(group.teacherId),
      startsOn: group?.startsOn ?? isoDate(new Date()),
      capacity: group?.capacity ?? 30,
    });
    setGroupFormOpen(true);
  }

  async function submitGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile?.centreId || !canManage) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const input = {
        name: groupForm.name,
        formationId: groupForm.formationId,
        teacherId: groupForm.teacherId || null,
        startsOn: groupForm.startsOn,
        capacity: groupForm.capacity,
      };
      if (groupForm.id !== undefined) {
        await updateGroup(getSupabaseClient(), profile.centreId, groupForm.id, input);
      } else {
        await createGroup(getSupabaseClient(), profile.centreId, input);
      }
      setGroupFormOpen(false);
      setMessage(groupForm.id !== undefined ? 'Groupe modifié avec succès.' : 'Groupe créé avec succès.');
      await refreshFormations();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteGroup(groupId: string | number) {
    if (!profile?.centreId || !canManage || !await confirmAction('Voulez-vous supprimer ce groupe ?')) {
      return;
    }
    setError(null);
    setMessage(null);
    try {
      await deleteGroup(getSupabaseClient(), profile.centreId, groupId);
      setMessage('Groupe supprimé.');
      await refreshFormations();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function handleCreateModule() {
    if (!profile?.centreId || !newModuleDomain) return;
    setSaving(true);
    setError(null);
    try {
      const module = await createModuleForCentre(
        getSupabaseClient(),
        profile.centreId,
        newModuleName,
        newModuleDomain,
      );
      setModules((current) =>
        [...current, module].sort((left, right) => left.name.localeCompare(right.name, 'fr')),
      );
      setFormationForm((current) => ({
        ...current,
        moduleIds: [...current.moduleIds, module.id],
      }));
      setNewModuleName('');
      setNewModuleDomain('');
      setMessage('Module créé et ajouté à la formation.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageFrame
      actions={
        canManage ? (
          <Button onClick={() => startFormationForm()} type="button">
            + Ajouter une formation
          </Button>
        ) : undefined
      }
      description="Créez et gérez les formations du centre, leurs modules et leurs groupes."
      title="Formations & Groupes"
    >
      <PlanningLoadState retry={reload} state={state} />
      {error && <Alert tone="error">{error}</Alert>}
      {message && <Alert tone="success">{message}</Alert>}
      {formOpen && (
        <Modal label={formationForm.id ? 'Modifier la formation' : 'Nouvelle formation'} onClose={() => setFormOpen(false)}>
        <Panel className="management-editor">
          <div className="management-editor-heading">
            <div>
              <p className="planning-progress-eyebrow">Catalogue pédagogique</p>
              <h2>{formationForm.id ? 'Modifier la formation' : 'Nouvelle formation'}</h2>
            </div>
            <button
              aria-label="Fermer le formulaire"
              className="planning-dialog-close"
              onClick={() => setFormOpen(false)}
              type="button"
            >
              ×
            </button>
          </div>
          <form
            className="management-editor-form"
            onSubmit={(event) => void submitFormation(event)}
          >
            <label className="sp-form-field">
              <span className="sp-field-label">Nom de la formation</span>
              <input
                className="sp-field"
                maxLength={150}
                onChange={(event) =>
                  setFormationForm((current) => ({ ...current, name: event.target.value }))
                }
                required
                value={formationForm.name}
              />
            </label>
            <label className="sp-form-field">
              <span className="sp-field-label">Durée</span>
              <input
                className="sp-field"
                onChange={(event) =>
                  setFormationForm((current) => ({ ...current, duration: event.target.value }))
                }
                placeholder="Ex. : 6 mois"
                value={formationForm.duration}
              />
            </label>
            <label className="sp-form-field">
              <span className="sp-field-label">Heures par semaine</span>
              <input
                className="sp-field"
                max="168"
                min="0.5"
                onChange={(event) =>
                  setFormationForm((current) => ({
                    ...current,
                    hoursPerWeek: Number(event.target.value),
                  }))
                }
                required
                step="0.5"
                type="number"
                value={formationForm.hoursPerWeek}
              />
            </label>
            <label className="sp-form-field management-editor-wide">
              <span className="sp-field-label">Description</span>
              <textarea
                className="sp-field management-textarea"
                onChange={(event) =>
                  setFormationForm((current) => ({ ...current, description: event.target.value }))
                }
                rows={3}
                value={formationForm.description}
              />
            </label>
            <div className="management-editor-wide">
              <div className="management-module-picker-heading">
                <div>
                  <strong>Modules de la formation</strong>
                  <p className="management-muted">
                    {formationForm.moduleIds.length} module(s) sélectionné(s)
                  </p>
                </div>
                <input
                  aria-label="Rechercher un module"
                  className="sp-field"
                  onChange={(event) => setSearchModules(event.target.value)}
                  placeholder="Rechercher un module"
                  type="search"
                  value={searchModules}
                />
              </div>
              <div className="management-module-options">
                {filteredModules.map((module) => {
                  const checked = formationForm.moduleIds.some(
                    (id) => String(id) === String(module.id),
                  );
                  return (
                    <label className="management-module-option" key={module.id}>
                      <input
                        checked={checked}
                        onChange={() =>
                          setFormationForm((current) => ({
                            ...current,
                            moduleIds: checked
                              ? current.moduleIds.filter((id) => String(id) !== String(module.id))
                              : [...current.moduleIds, module.id],
                          }))
                        }
                        type="checkbox"
                      />
                      {module.name}
                    </label>
                  );
                })}
                {filteredModules.length === 0 && (
                  <p className="management-muted">Aucun module dans le catalogue du centre.</p>
                )}
              </div>
              <div className="management-new-module">
                <strong>Ajouter un module au catalogue</strong>
                <div>
                  <input
                    aria-label="Nom du nouveau module"
                    className="sp-field"
                    maxLength={100}
                    onChange={(event) => setNewModuleName(event.target.value)}
                    placeholder="Nom du module"
                    value={newModuleName}
                  />
                  <select
                    aria-label="Domaine du nouveau module"
                    className="sp-field"
                    onChange={(event) => setNewModuleDomain(event.target.value)}
                    value={newModuleDomain}
                  >
                    <option value="">Choisir un domaine</option>
                    {domains.map((domain) => (
                      <option key={domain.id} value={domain.id}>
                        {domain.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    disabled={saving || !newModuleName.trim() || !newModuleDomain}
                    onClick={() => void handleCreateModule()}
                    type="button"
                    variant="secondary"
                  >
                    + Créer et sélectionner
                  </Button>
                </div>
              </div>
            </div>
            <div className="management-editor-actions management-editor-wide">
              <Button onClick={() => setFormOpen(false)} type="button" variant="secondary">
                Annuler
              </Button>
              <Button disabled={saving} type="submit">
                {saving ? 'Enregistrement…' : 'Enregistrer la formation'}
              </Button>
            </div>
          </form>
        </Panel>
        </Modal>
      )}
      {groupFormOpen && (
        <Modal label="Nouveau groupe" onClose={() => setGroupFormOpen(false)}>
        <Panel className="management-editor">
          <div className="management-editor-heading">
            <div>
              <p className="planning-progress-eyebrow">Organisation des étudiants</p>
              <h2>{groupForm.id !== undefined ? 'Modifier le groupe' : 'Nouveau groupe'}</h2>
            </div>
            <button
              aria-label="Fermer le formulaire"
              className="planning-dialog-close"
              onClick={() => setGroupFormOpen(false)}
              type="button"
            >
              ×
            </button>
          </div>
          <form className="management-editor-form" onSubmit={(event) => void submitGroup(event)}>
            <label className="sp-form-field">
              <span className="sp-field-label">Nom du groupe</span>
              <input
                className="sp-field"
                maxLength={100}
                onChange={(event) =>
                  setGroupForm((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="Ex. : Groupe A"
                required
                value={groupForm.name}
              />
            </label>
            <label className="sp-form-field">
              <span className="sp-field-label">Formation</span>
              <select
                className="sp-field"
                onChange={(event) =>
                  setGroupForm((current) => ({ ...current, formationId: event.target.value }))
                }
                required
                value={groupForm.formationId}
              >
                <option value="">Sélectionner une formation active</option>
                {formations
                  .filter((formation) => formation.active)
                  .map((formation) => (
                    <option key={formation.id} value={formation.id}>
                      {formation.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="sp-form-field">
              <span className="sp-field-label">Formateur responsable</span>
              <select
                className="sp-field"
                onChange={(event) =>
                  setGroupForm((current) => ({ ...current, teacherId: event.target.value }))
                }
                value={groupForm.teacherId}
              >
                <option value="">Aucun formateur</option>
                {state.status === 'loaded' &&
                  state.data.filters.teachers.map((teacher) => (
                    <option key={teacher.id} value={teacher.id}>
                      {teacher.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="sp-form-field">
              <span className="sp-field-label">Date de début</span>
              <input
                className="sp-field"
                onChange={(event) =>
                  setGroupForm((current) => ({ ...current, startsOn: event.target.value }))
                }
                required
                type="date"
                value={groupForm.startsOn}
              />
            </label>
            <label className="sp-form-field">
              <span className="sp-field-label">Capacité maximale</span>
              <input
                className="sp-field"
                max="500"
                min="1"
                onChange={(event) =>
                  setGroupForm((current) => ({ ...current, capacity: Number(event.target.value) }))
                }
                required
                type="number"
                value={groupForm.capacity}
              />
            </label>
            <p className="management-muted management-editor-wide">
              {groupForm.formationId
                ? (() => {
                    const formation = formations.find(
                      (item) => String(item.id) === groupForm.formationId,
                    );
                    try {
                      return `Fin calculée selon la durée de la formation : ${calculateGroupEndDate(groupForm.startsOn, formation?.duration ?? '')}.`;
                    } catch {
                      return 'La durée de la formation doit être au format « 3 mois » ou « 1 an ».';
                    }
                  })()
                : 'Choisissez une formation pour calculer automatiquement la date de fin.'}
            </p>
            <div className="management-editor-actions management-editor-wide">
              <Button onClick={() => setGroupFormOpen(false)} type="button" variant="secondary">
                Annuler
              </Button>
              <Button disabled={saving} type="submit">
                {saving ? 'Enregistrement…' : groupForm.id !== undefined ? 'Enregistrer les modifications' : 'Créer le groupe'}
              </Button>
            </div>
          </form>
        </Panel>
        </Modal>
      )}
      {state.status === 'loaded' && (
        <>
          {state.data.filters.formations.length === 0 ? (
            <EmptyState title="Aucune formation n’est enregistrée dans ce centre." />
          ) : (
            <div className="management-card-grid">
              {state.data.filters.formations.map((formation) => {
                const groups = state.data.filters.groups.filter(
                  (group) => String(group.formationId) === String(formation.id),
                );
                const subjectIds = state.data.subjectIdsByFormation[String(formation.id)] ?? [];
                return (
                  <Panel
                    className={`management-card management-formation-card${selectedFormationId === String(formation.id) ? ' is-selected' : ''}`}
                    key={formation.id}
                  >
                    <div className="management-card-heading">
                      <button
                        aria-label={`Afficher les groupes de ${formation.name}`}
                        aria-pressed={selectedFormationId === String(formation.id)}
                        className="management-icon management-icon-indigo management-formation-select"
                        onClick={() =>
                          setSelectedFormationId((current) =>
                            current === String(formation.id) ? '' : String(formation.id),
                          )
                        }
                        type="button"
                      >
                        F
                      </button>
                      <div>
                        <h2>{formation.name}</h2>
                        <p>{formation.active ? 'Formation active' : 'Formation inactive'}</p>
                      </div>
                    </div>
                    {formation.description && (
                      <p className="management-description">{formation.description}</p>
                    )}
                    <div className="management-metrics">
                      <div>
                        <span>Durée</span>
                        <strong>{formation.duration || 'Non définie'}</strong>
                      </div>
                      <div>
                        <span>Volume hebdomadaire</span>
                        <strong>{formation.hoursPerWeek ?? '—'} h</strong>
                      </div>
                      <div>
                        <span>Groupes</span>
                        <strong>{groups.length}</strong>
                      </div>
                    </div>
                    <div className="management-chip-list">
                      {subjectIds.map((subjectId) => {
                        const subject = state.data.filters.subjects.find(
                          (item) => String(item.id) === String(subjectId),
                        );
                        return subject ? (
                          <span className="management-chip" key={subjectId}>
                            {subject.name}
                          </span>
                        ) : null;
                      })}
                    </div>
                    <div className="management-group-list">
                      {groups.map((group) => (
                        <div className="management-group-row" key={group.id}>
                          <span>
                            <strong>{group.name}</strong>
                            <small>
                              {group.startsOn || 'Début non défini'} –{' '}
                              {group.endsOn || 'Fin non définie'}
                            </small>
                          </span>
                          <span
                            className={
                              group.active
                                ? 'management-status-active'
                                : 'management-status-inactive'
                            }
                          >
                            {group.active ? 'Actif' : 'Inactif'}
                          </span>
                        </div>
                      ))}
                      {groups.length === 0 && (
                        <p className="management-muted">Aucun groupe rattaché à cette formation.</p>
                      )}
                    </div>
                    {canManage && (
                      <div className="management-card-actions">
                        <Button
                          onClick={() => startFormationForm(formation)}
                          type="button"
                          variant="secondary"
                        >
                          Modifier
                        </Button>
                        <Button
                          onClick={() => void handleDeleteFormation(formation.id)}
                          type="button"
                          variant="danger"
                        >
                          Supprimer
                        </Button>
                      </div>
                    )}
                  </Panel>
                );
              })}
            </div>
          )}
          {selectedFormation && (
            <section aria-label={`Groupes de ${selectedFormation.name}`} className="space-y-3">
              <header className="planning-progress-section-heading">
                <div>
                  <p className="planning-progress-eyebrow">Formation sélectionnée</p>
                  <h2>Groupes de {selectedFormation.name}</h2>
                </div>
                {canManage && (
                  <Button onClick={() => startGroupForm(selectedFormationId)} type="button">
                    + Ajouter un groupe
                  </Button>
                )}
              </header>
              {selectedGroups.length === 0 ? (
                <EmptyState title="Aucun groupe pour cette formation." />
              ) : (
                <div className="management-card-grid management-group-grid">
                  {selectedGroups.map((group) => {
                    const count = studentCounts.get(String(group.id)) ?? 0;
                    const remaining = Math.max(0, group.capacity - count);
                    const percentage = Math.min(100, Math.round((count / group.capacity) * 100));
                    const teacher = state.data.filters.teachers.find(
                      (item) => String(item.id) === String(group.teacherId),
                    );
                    return (
                      <Panel className="management-group-card" key={group.id}>
                        <header className="management-group-card-heading">
                          <div>
                            <p className="planning-progress-eyebrow">Groupe</p>
                            <h3>{group.name}</h3>
                          </div>
                          <span
                            className={
                              remaining === 0
                                ? 'management-group-full'
                                : 'management-group-available'
                            }
                          >
                            {remaining === 0 ? 'Complet' : 'Disponible'}
                          </span>
                        </header>
                        <div className="management-group-enrollment">
                          <strong>{count}</strong>
                          <span>/ {group.capacity} étudiants</span>
                        </div>
                        <div
                          aria-label={`${group.name} occupé à ${percentage} %`}
                          aria-valuemax={100}
                          aria-valuemin={0}
                          aria-valuenow={percentage}
                          className={`management-group-progress${remaining === 0 ? ' is-full' : ''}`}
                          role="progressbar"
                        >
                          <span style={{ width: `${percentage}%` }} />
                        </div>
                        <div className="management-group-details">
                          <span>
                            <b>Formateur</b>
                            {teacher?.name ?? 'Non défini'}
                          </span>
                          <span>
                            <b>Début</b>
                            {group.startsOn ?? 'Non défini'}
                          </span>
                          <span>
                            <b>Fin</b>
                            {group.endsOn ?? 'Non définie'}
                          </span>
                          <span>
                            <b>Places restantes</b>
                            {remaining}
                          </span>
                        </div>
                        {canManage && (
                          <div className="management-card-actions">
                            <Button
                              onClick={() => startGroupForm(String(group.formationId), group)}
                              type="button"
                              variant="secondary"
                            >
                              Modifier
                            </Button>
                            <Button
                              onClick={() => void handleDeleteGroup(group.id)}
                              type="button"
                              variant="danger"
                            >
                              Supprimer le groupe
                            </Button>
                          </div>
                        )}
                      </Panel>
                    );
                  })}
                </div>
              )}
            </section>
          )}
          {state.data.filters.groups.some((group) => !group.formationId) && (
            <Panel>
              <h2 className="management-unassigned-heading">Groupes sans formation</h2>
              <div className="management-chip-list">
                {state.data.filters.groups
                  .filter((group) => !group.formationId)
                  .map((group) => (
                    <span className="management-chip" key={group.id}>
                      {group.name}
                    </span>
                  ))}
              </div>
            </Panel>
          )}
        </>
      )}
    </PageFrame>
  );
}

export function StudentsPage() {
  const { profile } = useAuth();
  const planning = usePlanningData();
  const [search, setSearch] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<StudentState>({ status: 'loading' });
  const [editingId, setEditingId] = useState<string | number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setErrorState] = useState<string | null>(null);
  const setError = (value: string | null) => {
    setErrorState(value);
    if (value) notify(value, 'error');
  };
  const [message, setMessageState] = useState<string | null>(null);
  const setMessage = (value: string | null) => {
    setMessageState(value);
    if (value) notify(value, 'success');
  };
  const [enrollmentIds, setEnrollmentIds] = useState<Record<string, Array<string | number>>>({});
  const [form, setForm] = useState<StudentRecordInput>({
    firstName: '', lastName: '', email: '', telephone: '', city: '', address: '', educationLevel: '',
  });
  const canManage = profile?.role === 'admin' || profile?.role === 'director';

  useEffect(() => {
    let active = true;
    async function load() {
      setState({ status: 'loading' });
      try {
        const students = await getCentreStudents(getSupabaseClient(), profile?.centreId ?? '');
        if (active) setState({ status: 'loaded', students });
      } catch (cause) {
        if (active) setState({ status: 'error', message: errorMessage(cause) });
      }
    }
    void load();
    return () => { active = false; };
  }, [profile?.centreId, reloadKey]);

  useEffect(() => {
    let active = true;
    if (!profile?.centreId) { setEnrollmentIds({}); return; }
    void getStudentCourseEnrollmentIds(getSupabaseClient(), profile.centreId)
      .then((ids) => { if (active) setEnrollmentIds(ids); })
      .catch((cause: unknown) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [profile?.centreId, reloadKey]);

  async function changeCourseEnrollment(student: ManagedStudent, courseId: string | number, enrolled: boolean) {
    if (!profile?.centreId || !canManage) return;
    setError(null); setMessage(null);
    try {
      await setStudentCourseEnrollment(getSupabaseClient(), profile.centreId, student.id, courseId, enrolled);
      setEnrollmentIds((current) => {
        const key = String(student.id);
        const currentIds = current[key] ?? [];
        return { ...current, [key]: enrolled
          ? (currentIds.some((id) => String(id) === String(courseId)) ? currentIds : [...currentIds, courseId])
          : currentIds.filter((id) => String(id) !== String(courseId)) };
      });
      setMessage(enrolled ? 'Étudiant inscrit au cours.' : 'Inscription au cours supprimée.');
      setReloadKey((key) => key + 1);
    } catch (cause) { setError(errorMessage(cause)); }
  }

  const visibleStudents = useMemo(() => {
    if (state.status !== 'loaded') return [];
    const normalized = search.trim().toLocaleLowerCase('fr');
    return state.students.filter((student) =>
      [student.firstName, student.lastName, student.email, student.telephone, student.city, student.groupName]
        .filter(Boolean).join(' ').toLocaleLowerCase('fr').includes(normalized),
    );
  }, [search, state]);

  function startCreate() {
    setEditingId(null);
    setForm({ firstName: '', lastName: '', email: '', telephone: '', city: '', address: '', educationLevel: '' });
    setError(null);
    setMessage(null);
    setFormOpen(true);
  }

  function startEdit(student: ManagedStudent) {
    setEditingId(student.id);
    setForm({
      firstName: student.firstName,
      lastName: student.lastName,
      email: student.email ?? '',
      telephone: student.telephone ?? '',
      city: student.city ?? '',
      address: student.address ?? '',
      educationLevel: student.educationLevel ?? '',
    });
    setError(null);
    setMessage(null);
    setFormOpen(true);
  }

  async function submitStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile?.centreId || !canManage) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      if (editingId === null) {
        await createCentreStudent(getSupabaseClient(), profile.centreId, form);
        setMessage('Étudiant créé avec succès.');
      } else {
        await updateCentreStudent(getSupabaseClient(), profile.centreId, editingId, form);
        setMessage('Dossier étudiant modifié.');
      }
      setFormOpen(false);
      setReloadKey((key) => key + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function changeStudentGroup(student: ManagedStudent, value: string) {
    if (!profile?.centreId || !canManage) return;
    try {
      await assignStudentToGroup(getSupabaseClient(), profile.centreId, student.id, value ? value : null);
      setMessage('Affectation au groupe enregistrée.');
      setError(null);
      setReloadKey((key) => key + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }


  async function removeStudent(student: ManagedStudent) {
    if (!profile?.centreId || !canManage) return;
    if (!await confirmAction(`Supprimer le dossier de ${student.firstName} ${student.lastName} ?`)) return;
    setError(null);
    setMessage(null);
    try {
      await deleteCentreStudent(getSupabaseClient(), profile.centreId, student.id);
      setMessage('Dossier étudiant supprimé.');
      setReloadKey((key) => key + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  const fields: Array<{ key: keyof StudentRecordInput; label: string; icon: string; required?: boolean; type?: string }> = [
    { key: 'firstName', label: 'Prénom', icon: '♙', required: true },
    { key: 'lastName', label: 'Nom', icon: '♙', required: true },
    { key: 'email', label: 'E-mail', icon: '✉', type: 'email' },
    { key: 'telephone', label: 'Téléphone', icon: '☎', type: 'tel' },
    { key: 'city', label: 'Ville', icon: '⌖' },
    { key: 'address', label: 'Adresse', icon: '⌂' },
    { key: 'educationLevel', label: 'Niveau d’études', icon: '▤' },
  ];

  return (
    <PageFrame
      actions={canManage ? <Button onClick={startCreate} type="button">+ Ajouter un étudiant</Button> : undefined}
      description="Dossiers étudiants du centre, groupe d’affectation et inscriptions aux cours."
      title="Étudiants"
    >
      {error && <Alert tone="error"><p>{error}</p></Alert>}
      {message && <Alert tone="success"><p>{message}</p></Alert>}
      {formOpen && canManage && (
        <Modal label={editingId === null ? 'Nouvel étudiant' : 'Modifier l’étudiant'} onClose={() => setFormOpen(false)}>
        <Panel className="management-editor">
          <header className="management-editor-heading">
            <div>
              <p className="planning-progress-eyebrow">Dossier étudiant</p>
              <h2>{editingId === null ? 'Nouvel étudiant' : 'Modifier l’étudiant'}</h2>
            </div>
            <button aria-label="Fermer le formulaire" className="planning-dialog-close" onClick={() => setFormOpen(false)} type="button">×</button>
          </header>
          <form className="sp-form-grid" onSubmit={(event) => void submitStudent(event)}>
            {fields.map((field) => (
              <label className="sp-form-field" key={field.key}>
                <span className="sp-field-label">{field.label}</span>
                <input
                  className="sp-field"
                  autoComplete="off"
                  required={field.required}
                  type={field.type ?? 'text'}
                  value={form[field.key]}
                  onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
                />
              </label>
            ))}
            <div className="management-toolbar">
              <Button disabled={saving} type="submit">{saving ? 'Enregistrement…' : 'Enregistrer'}</Button>
              <Button onClick={() => setFormOpen(false)} type="button" variant="secondary">Annuler</Button>
            </div>
          </form>
        </Panel>
        </Modal>
      )}
      <div className="management-toolbar">
        <label className="sp-form-field">
          Rechercher un étudiant
          <input className="sp-field" onChange={(event) => setSearch(event.target.value)} placeholder="Nom, e-mail, ville ou groupe" type="search" value={search} />
        </label>
        {state.status === 'loaded' && <span className="management-result-count">{visibleStudents.length} / {state.students.length} étudiants</span>}
      </div>
      {state.status === 'loading' && <Panel><LoadingState label="Chargement des étudiants…" /></Panel>}
      {state.status === 'error' && (
        <Alert tone="error">
          <p>La liste des étudiants n’a pas pu être chargée.</p>
          <p>{state.message}</p>
          <Button onClick={() => setReloadKey((key) => key + 1)} type="button" variant="secondary">Réessayer</Button>
        </Alert>
      )}
      {state.status === 'loaded' && (visibleStudents.length === 0 ? (
        <EmptyState title={search ? 'Aucun résultat pour cette recherche.' : 'Aucun étudiant enregistré dans ce centre.'} />
      ) : (
        <div className="management-card-grid management-four-column-grid management-student-grid">
          {visibleStudents.map((student) => (
            <Panel className="management-student-card" key={student.id}>
              <header className="management-student-heading">
                <span aria-hidden="true" className="management-avatar management-student-avatar">{initials(`${student.firstName} ${student.lastName}`)}</span>
                <div>
                  <h2>{student.firstName} {student.lastName}</h2>
                  <p>{student.educationLevel || 'Niveau non renseigné'}</p>
                </div>
              </header>
              <div className="management-student-details">
                {student.email && <a href={`mailto:${student.email}`}><span aria-hidden="true">✉</span>{student.email}</a>}
                {student.telephone && <a href={`tel:${student.telephone}`}><span aria-hidden="true">☎</span>{student.telephone}</a>}
                {student.city && <span><span aria-hidden="true">⌖</span>{student.city}</span>}
              </div>
              <footer className="management-student-footer">
                <span>{student.groupName || 'Non affecté'}</span>
                <span>{student.courseCount} cours</span>
              </footer>
              {canManage && planning.state.status === 'loaded' && (
                <div className="sp-form-grid">
                  <label className="sp-form-field">
                    Groupe
                    <select className="sp-field" value={student.groupId === null ? '' : String(student.groupId)} onChange={(event) => void changeStudentGroup(student, event.target.value)}>
                      <option value="">Non affecté</option>
                      {planning.state.data.filters.groups.filter((group) => group.active).map((group) => (
                        <option key={group.id} value={String(group.id)}>{group.name} · {group.formationName ?? 'Formation'}</option>
                      ))}
                    </select>
                  </label>
                  <details>
                    <summary>Gérer les inscriptions aux cours</summary>
                    <div className="sp-form-grid">
                      {planning.state.data.courses.map((course) => {
                        const enrolled = (enrollmentIds[String(student.id)] ?? []).some((id) => String(id) === String(course.id));
                        const groupMismatch = Boolean(course.groupId && String(student.groupId) !== String(course.groupId));
                        return (
                          <label className="cb" key={course.id}>
                            <input
                              type="checkbox"
                              checked={enrolled}
                              disabled={!enrolled && groupMismatch}
                              onChange={(event) => void changeCourseEnrollment(student, course.id, event.target.checked)}
                            />
                            {course.subjectName} — {course.groupName ?? 'Sans groupe'}
                          </label>
                        );
                      })}
                    </div>
                    <p className="management-muted">Les cours d’un autre groupe sont désactivés. Affectez d’abord l’étudiant au groupe correspondant.</p>
                  </details>
                </div>
              )}
              {canManage && (
                <div className="management-toolbar">
                  <Button onClick={() => startEdit(student)} type="button" variant="secondary">Modifier</Button>
                  <Button onClick={() => void removeStudent(student)} type="button" variant="danger">Supprimer</Button>
                </div>
              )}
            </Panel>
          ))}
        </div>
      ))}
    </PageFrame>
  );
}

function isoDate(date: Date): string {
  return [
    date.getFullYear(),
    `${date.getMonth() + 1}`.padStart(2, '0'),
    `${date.getDate()}`.padStart(2, '0'),
  ].join('-');
}

function formatCourseTime(occurrence: PlanningOccurrence): string {
  return `${occurrence.startsAt.slice(0, 5)} – ${occurrence.endsAt.slice(0, 5)}`;
}

export function AttendancePage() {
  const { profile } = useAuth();
  const { state: planningState, reload } = usePlanningData();
  const [date, setDate] = useState(() => isoDate(new Date()));
  const [sheet, setSheet] = useState<AttendanceSheet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setErrorState] = useState<string | null>(null);
  const setError = (value: string | null) => {
    setErrorState(value);
    if (value) notify(value, 'error');
  };
  const [message, setMessageState] = useState<string | null>(null);
  const setMessage = (value: string | null) => {
    setMessageState(value);
    if (value) notify(value, 'success');
  };
  const [revision, setRevision] = useState(0);

  const occurrences = useMemo(() => {
    if (planningState.status !== 'loaded') return [];
    const current = new Date(`${date}T12:00:00`);
    return getWeekOccurrences(
      planningState.data.courses,
      current,
      planningState.data.closedDates,
      planningState.data.cancelledOccurrences,
      planningState.data.completedOccurrences,
    )
      .filter((occurrence) => occurrence.date === date && !occurrence.cancelled)
      .filter((occurrence) => {
        const group = planningState.data.filters.groups.find(
          (item) => String(item.id) === String(occurrence.groupId),
        );
        return (
          (!group?.startsOn || date >= group.startsOn) && (!group?.endsOn || date <= group.endsOn)
        );
      });
  }, [date, planningState]);

  useEffect(() => {
    if (planningState.status !== 'loaded' || !profile?.centreId) return;
    let active = true;
    setLoading(true);
    setError(null);
    const courseIds = occurrences.map((occurrence) => occurrence.id);
    void getAttendanceSheet(getSupabaseClient(), profile.centreId, date, courseIds)
      .then((nextSheet) => {
        if (active) setSheet(nextSheet);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [date, occurrences, planningState, profile?.centreId, revision]);

  async function updateStatus(
    courseId: string | number,
    studentId: string | number,
    status: AttendanceStatus,
  ) {
    if (!profile?.centreId) {
      setError('Votre profil n’est rattaché à aucun centre.');
      return;
    }
    setError(null);
    setMessage(null);
    try {
      await saveAttendance(
        getSupabaseClient(),
        profile.centreId,
        courseId,
        studentId,
        date,
        status,
      );
      setMessage('Présence enregistrée.');
      setRevision((current) => current + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <PageFrame
      actions={
        <label className="sp-form-field management-date-field">
          Date de la séance
          <input
            className="sp-field"
            onChange={(event) => setDate(event.target.value)}
            type="date"
            value={date}
          />
        </label>
      }
      description="Consultez les séances du jour et enregistrez les présences, retards ou absences."
      title="Présences"
    >
      <PlanningLoadState retry={reload} state={planningState} />
      {message && <Alert tone="success">{message}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      {loading && (
        <Panel>
          <LoadingState label="Chargement de la feuille de présence…" />
        </Panel>
      )}
      {!loading &&
        planningState.status === 'loaded' &&
        (!sheet || sheet.courses.length === 0 ? (
          <EmptyState
            title="Aucun cours prévu à cette date."
            description={
              planningState.data.closedDates[date]
                ? `Centre fermé : ${planningState.data.closedDates[date]}`
                : 'Choisissez une autre date pour consulter les séances.'
            }
          />
        ) : (
          <div className="management-attendance-grid">
            {sheet.courses.map((courseSheet) => {
              const occurrence = occurrences.find(
                (item) => String(item.id) === String(courseSheet.courseId),
              );
              if (!occurrence) return null;
              const present = courseSheet.students.filter(
                (item) => item.status === 'present' || item.status === 'retard',
              ).length;
              return (
                <Panel className="management-attendance-course" key={courseSheet.courseId}>
                  <header className="management-attendance-heading">
                    <div>
                      <p className="planning-progress-eyebrow">
                        {formatCourseTime(occurrence)} ·{' '}
                        {occurrence.roomName || 'Salle non définie'}
                      </p>
                      <h2>{occurrence.subjectName}</h2>
                      <p>
                        {occurrence.teacherName}
                        {occurrence.groupName ? ` · ${occurrence.groupName}` : ''}
                      </p>
                    </div>
                    <span className="management-attendance-count">
                      {present} / {courseSheet.students.length} présents
                    </span>
                  </header>
                  {courseSheet.students.length === 0 ? (
                    <p className="management-muted">Aucun étudiant inscrit à ce cours.</p>
                  ) : (
                    <div className="management-attendance-list">
                      {courseSheet.students.map(({ student, status }) => (
                        <div className="management-attendance-row" key={student.id}>
                          <strong>
                            {student.firstName} {student.lastName}
                          </strong>
                          <div
                            aria-label={`Présence de ${student.firstName} ${student.lastName}`}
                            className="management-status-actions"
                          >
                            {(
                              [
                                ['present', 'Présent'],
                                ['retard', 'Retard'],
                                ['absent', 'Absent'],
                              ] as const
                            ).map(([value, label]) => (
                              <button
                                aria-pressed={status === value}
                                className={`management-status-button${status === value ? ' is-selected' : ''}`}
                                key={value}
                                onClick={() => void updateStatus(occurrence.id, student.id, value)}
                                type="button"
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Panel>
              );
            })}
          </div>
        ))}
    </PageFrame>
  );
}
