import { useEffect, useMemo, useState, type FormEvent, type MouseEvent } from 'react';
import { Alert, Button, EmptyState, LoadingState, PageHeader, Panel, confirmAction, notify } from '../../components/ui';
import {
  addDays,
  formatTime,
  getMonday,
  getRoomAvailability,
  getWeekOccurrences,
  matchesPlanningFilters,
  toDateKey,
} from '../../business/planning/planningSchedule';
import { calculateFormationProgress } from '../../business/planning/planningProgress';
import {
  deletePlanningClosure,
  deletePlanningCourse,
  getPlanningData,
  markPlanningOccurrenceCompleted,
  savePlanningClosure,
  savePlanningCourse,
  setPlanningOccurrenceCancelled,
} from '../../data/repositories/planningRepository';
import { getSupabaseClient } from '../../data/supabase/client';
import type {
  PlanningCourseInput,
  PlanningData,
  PlanningFilters,
  PlanningOccurrence,
} from '../../types/planning';
import type { StudentIdentifier } from '../../types/students';
import { useAuth } from '../auth/AuthProvider';

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: PlanningData };

type PlanningRole = 'admin' | 'director' | 'super_admin' | 'formateur' | 'etudiant';

type EditorState = {
  courseId?: StudentIdentifier;
  occurrenceDate: string;
  groupId: string;
  subjectId: string;
  date: string;
  startsAt: string;
  endsAt: string;
  roomId: string;
  teacherId: string;
  recurring: boolean;
  cancelled: boolean;
  completed: boolean;
};

const DAY_NAMES = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const OPENING_HOUR = 8;
const GRID_HOURS = 11;
const START_TIMES = Array.from({ length: 22 }, (_, index) =>
  formatTime(OPENING_HOUR * 60 + index * 30),
);
const END_TIMES = Array.from({ length: 22 }, (_, index) =>
  formatTime(OPENING_HOUR * 60 + (index + 1) * 30),
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur inattendue est survenue.';
}

function getPlanningRole(role: string): PlanningRole | null {
  return role === 'admin' || role === 'director' || role === 'super_admin' || role === 'formateur' || role === 'etudiant'
    ? role
    : null;
}

function toDayLabel(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  return parsed.toLocaleDateString('fr-FR', { day: 'numeric', month: '2-digit' });
}

function toWeekLabel(monday: Date): string {
  const saturday = addDays(monday, 5);
  const start = monday.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  const end = saturday.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  return `Semaine du ${start} au ${end} ${saturday.getFullYear()}`;
}

function getDomainClass(domainName: string | null): string {
  const normalized = domainName?.toLocaleLowerCase('fr') ?? '';
  if (normalized.includes('bureautique')) return 'planning-domain-office';
  if (normalized.includes('data') || normalized.includes('it')) return 'planning-domain-data';
  if (normalized.includes('math')) return 'planning-domain-math';
  return 'planning-domain-language';
}

function CourseCard({
  occurrence,
  onSelect,
  disabled,
}: {
  occurrence: PlanningOccurrence;
  onSelect: (occurrence: PlanningOccurrence) => void;
  disabled: boolean;
}) {
  const top = ((occurrence.startsAtMinutes - OPENING_HOUR * 60) / 60) * 56;
  const height = ((occurrence.endsAtMinutes - occurrence.startsAtMinutes) / 60) * 56 - 3;
  const stateClass = occurrence.cancelled
    ? ' planning-course-cancelled'
    : occurrence.completed
      ? ' planning-course-completed'
      : '';

  return (
    <button
      aria-label={`${occurrence.subjectName}, ${formatTime(occurrence.startsAtMinutes)} à ${formatTime(occurrence.endsAtMinutes)}, ${occurrence.teacherName}${occurrence.cancelled ? ', séance annulée' : ''}`}
      className={`planning-course ${getDomainClass(occurrence.domainName)}${stateClass}`}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(occurrence);
      }}
      style={{ height: `${Math.max(height, 26)}px`, top: `${Math.max(top, 0)}px` }}
      type="button"
    >
      <b>{occurrence.subjectName}</b>
      <small>
        {formatTime(occurrence.startsAtMinutes)} – {formatTime(occurrence.endsAtMinutes)}
      </small>
      <small>{occurrence.teacherName}</small>
      {occurrence.roomName && <small>{occurrence.roomName}</small>}
      {occurrence.cancelled && <span className="planning-state-label">Annulée</span>}
      {!occurrence.cancelled && occurrence.completed && (
        <span className="planning-state-label">Réalisée</span>
      )}
    </button>
  );
}

function occurrenceKey(occurrence: PlanningOccurrence): string {
  return `${occurrence.id}|${occurrence.date}`;
}

function isCourseFilterMatch(
  occurrence: PlanningOccurrence,
  groups: PlanningData['filters']['groups'],
  filters: PlanningFilters,
): boolean {
  return matchesPlanningFilters(occurrence, groups, filters, occurrence.date);
}

export function PlanningPage({ view = 'planning' }: { view?: 'planning' | 'sessions' }) {
  const { profile, permissions, session } = useAuth();
  const isStudent = profile?.role === 'etudiant';
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<PageState>({ status: 'loading' });
  const [week, setWeek] = useState(() => getMonday(new Date()));
  const [selectedDay, setSelectedDay] = useState(() => Math.min((new Date().getDay() + 6) % 7, 5));
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [closureDialogOpen, setClosureDialogOpen] = useState(false);
  const [closureDate, setClosureDate] = useState('');
  const [closureLabel, setClosureLabel] = useState('');
  const [closureError, setClosureError] = useState<string | null>(null);
  const [closureMessage, setClosureMessage] = useState<string | null>(null);
  const [filters, setFilters] = useState<PlanningFilters>({
    formationId: '',
    groupId: '',
    subjectId: '',
    teacherId: '',
  });

  useEffect(() => {
    let active = true;
    async function loadPlanning() {
      setState({ status: 'loading' });
      const role = profile ? getPlanningRole(profile.role) : null;
      if (!role) {
        setState({ status: 'error', message: 'Votre rôle ne peut pas consulter le planning.' });
        return;
      }
      try {
        const data = await getPlanningData(
          getSupabaseClient(),
          profile?.centreId ?? '',
          profile?.id ?? '',
          role,
          session?.user.email ?? '',
        );
        if (active) setState({ status: 'loaded', data });
      } catch (error) {
        if (active) setState({ status: 'error', message: errorMessage(error) });
      }
    }

    void loadPlanning();
    return () => {
      active = false;
    };
  }, [profile?.centreId, profile?.id, profile?.role, session?.user.email, reloadKey]);

  const data = state.status === 'loaded' ? state.data : null;
  const formationProgresses = useMemo(() => {
    if (!data || !filters.formationId) return [];
    const formation = data.filters.formations.find(
      (item) => String(item.id) === filters.formationId,
    );
    if (!formation) return [];
    const progress = calculateFormationProgress(data, filters.formationId);
    return progress ? [{ formation, progress }] : [];
  }, [data, filters.formationId]);
  const allOccurrences = useMemo(
    () =>
      data
        ? getWeekOccurrences(
            data.courses,
            week,
            data.closedDates,
            data.cancelledOccurrences,
            data.completedOccurrences,
          )
        : [],
    [data, week],
  );
  const filteredOccurrences = useMemo(
    () =>
      allOccurrences.filter((occurrence) =>
        isCourseFilterMatch(occurrence, data?.filters.groups ?? [], filters),
      ),
    [allOccurrences, data?.filters.groups, filters],
  );
  const groupedByDay = useMemo(
    () =>
      DAY_NAMES.map((_, weekday) =>
        filteredOccurrences
          .filter((occurrence) => occurrence.weekday === weekday)
          .sort((left, right) => left.startsAtMinutes - right.startsAtMinutes),
      ),
    [filteredOccurrences],
  );

  const groupOptions =
    data?.filters.groups.filter(
      (group) => !filters.formationId || String(group.formationId) === filters.formationId,
    ) ?? [];
  const subjectOptions =
    data?.filters.subjects.filter(
      (subject) =>
        !filters.formationId ||
        (data?.subjectIdsByFormation[filters.formationId] ?? []).some(
          (subjectId) => String(subjectId) === String(subject.id),
        ),
    ) ?? [];
  const selectedGroup = data?.filters.groups.find((group) => String(group.id) === filters.groupId);
  const applicableEndDate =
    selectedGroup?.endsOn ??
    (filters.formationId
      ? data?.filters.groups
          .filter((group) => String(group.formationId) === filters.formationId)
          .map((group) => group.endsOn)
          .filter((date): date is string => Boolean(date))
          .sort()
          .at(-1)
      : undefined);
  const nextWeek = addDays(week, 7);
  const canMoveForward =
    !applicableEndDate ||
    getMonday(nextWeek) <= getMonday(new Date(`${applicableEndDate}T12:00:00`));

  const heading = view === 'planning' ? 'Planning' : 'Séances';
  const visibleSessions = groupedByDay.flat().filter((occurrence) => !occurrence.cancelled);
  const canManage =
    !!profile &&
    profile.role !== 'super_admin' &&
    ['admin', 'director', 'formateur'].includes(profile.role) &&
    permissions.cours === true;
  const canManageClosures =
    (profile?.role === 'admin' || profile?.role === 'director') && permissions.planning === true;
  const editorGroup = data?.filters.groups.find((group) => String(group.id) === editor?.groupId);
  const editorSubjects = data?.filters.subjects.filter((subject) =>
    editorGroup?.formationId
      ? (data.subjectIdsByFormation[String(editorGroup.formationId)] ?? []).some(
          (subjectId) => String(subjectId) === String(subject.id),
        )
      : false,
  );
  const editorTeachers = data?.filters.teachers.filter(
    (teacher) => !editorGroup?.teacherId || String(teacher.id) === String(editorGroup.teacherId),
  );
  const assignedTeacherName = data?.filters.teachers.find(
    (teacher) => String(teacher.id) === String(editorGroup?.teacherId),
  )?.name;
  const teacherId =
    profile?.role === 'formateur' ? (data?.filters.teachers[0]?.id.toString() ?? null) : null;
  const actorRole = profile && profile.role !== 'etudiant' ? getPlanningRole(profile.role) : null;
  const actor = {
    role: actorRole ?? 'super_admin',
    teacherId,
    centreId: profile?.centreId ?? null,
  } as const;

  function openCreate(date: string, startMinutes = 9 * 60) {
    if (!canManage || !data || data.closedDates[date]) return;
    const start = Math.min(Math.max(Math.ceil(startMinutes / 30) * 30, 8 * 60), 18 * 60 + 30);
    const firstGroup = data.filters.groups.find(
      (group) =>
        group.active &&
        (!filters.formationId || String(group.formationId) === filters.formationId) &&
        (!filters.groupId || String(group.id) === filters.groupId),
    );
    const subjectId = firstGroup?.formationId
      ? (data.subjectIdsByFormation[String(firstGroup.formationId)]?.[0]?.toString() ?? '')
      : '';
    setActionError(null);
    setActionMessage(null);
    setEditor({
      occurrenceDate: date,
      groupId: firstGroup?.id.toString() ?? '',
      subjectId,
      date,
      startsAt: formatTime(start),
      endsAt: formatTime(Math.min(start + 120, 19 * 60)),
      roomId: '',
      teacherId: firstGroup?.teacherId?.toString() ?? '',
      recurring: true,
      cancelled: false,
      completed: false,
    });
  }

  function openEdit(occurrence: PlanningOccurrence) {
    if (!canManage || !data) return;
    if (profile?.role === 'formateur' && String(occurrence.teacherId) !== teacherId) return;
    setActionError(null);
    setActionMessage(null);
    setEditor({
      courseId: occurrence.id,
      occurrenceDate: occurrence.date,
      groupId: occurrence.groupId?.toString() ?? '',
      subjectId: occurrence.subjectId.toString(),
      date: occurrence.date,
      startsAt: formatTime(occurrence.startsAtMinutes),
      endsAt: formatTime(occurrence.endsAtMinutes),
      roomId: occurrence.roomId?.toString() ?? '',
      teacherId: occurrence.teacherId.toString(),
      recurring: occurrence.startsOn !== occurrence.endsOn,
      cancelled: occurrence.cancelled,
      completed: occurrence.completed,
    });
  }

  function changeEditorGroup(groupId: string) {
    if (!data) return;
    const group = data.filters.groups.find((candidate) => String(candidate.id) === groupId);
    const subjectId = group?.formationId
      ? (data.subjectIdsByFormation[String(group.formationId)]?.[0]?.toString() ?? '')
      : '';
    setEditor((current) =>
      current
        ? {
            ...current,
            groupId,
            subjectId,
            teacherId: group?.teacherId?.toString() ?? '',
          }
        : current,
    );
  }

  async function performAction(action: () => Promise<void>, success: string, close = true) {
    setSaving(true);
    setActionError(null);
    setActionMessage(null);
    try {
      await action();
      setActionMessage(success);
      notify(success, 'success');
      setReloadKey((key) => key + 1);
      if (close) setEditor(null);
    } catch (error) {
      setActionError(errorMessage(error));
      notify(errorMessage(error), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function submitEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || !editor) return;
    const input: PlanningCourseInput = {
      ...(editor.courseId !== undefined ? { courseId: editor.courseId } : {}),
      groupId: editor.groupId,
      subjectId: editor.subjectId,
      date: editor.date,
      startsAt: editor.startsAt,
      endsAt: editor.endsAt,
      roomId: editor.roomId || null,
      teacherId: editor.teacherId || null,
      recurring: editor.recurring,
    };
    await performAction(
      () => savePlanningCourse(getSupabaseClient(), data, actor, input),
      editor.courseId ? 'Séance modifiée.' : 'Séance ajoutée.',
    );
  }

  async function deleteCourse() {
    if (!editor?.courseId || !await confirmAction('Supprimer ce cours ?')) return;
    await performAction(
      () => deletePlanningCourse(getSupabaseClient(), actor, editor.courseId!),
      'Cours supprimé.',
    );
  }

  async function toggleCancellation() {
    if (!editor?.courseId) return;
    const cancelling = !editor.cancelled;
    const dateLabel = editor.occurrenceDate.split('-').reverse().join('/');
    if (
      !await confirmAction(
        cancelling ? `Annuler la séance du ${dateLabel} ?` : `Rétablir la séance du ${dateLabel} ?`,
      )
    ) {
      return;
    }
    await performAction(
      () =>
        setPlanningOccurrenceCancelled(
          getSupabaseClient(),
          actor,
          editor.courseId!,
          editor.occurrenceDate,
          cancelling,
        ),
      cancelling ? 'Séance annulée.' : 'Séance rétablie.',
    );
  }

  async function completeOccurrence() {
    if (!editor?.courseId) return;
    const dateLabel = editor.occurrenceDate.split('-').reverse().join('/');
    if (!await confirmAction(`Confirmer que la séance du ${dateLabel} est terminée ?`)) return;
    await performAction(
      () =>
        markPlanningOccurrenceCompleted(
          getSupabaseClient(),
          actor,
          editor.courseId!,
          editor.occurrenceDate,
        ),
      'Séance marquée comme terminée.',
    );
  }

  function openClosureManager() {
    if (!canManageClosures) return;
    setClosureDate('');
    setClosureLabel('');
    setClosureError(null);
    setClosureMessage(null);
    setClosureDialogOpen(true);
  }

  async function submitClosure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || !canManageClosures) return;
    setSaving(true);
    setClosureError(null);
    setClosureMessage(null);
    try {
      await savePlanningClosure(getSupabaseClient(), actor, closureDate, closureLabel);
      setClosureDate('');
      setClosureLabel('');
      setClosureMessage('Jour fermé ajouté.');
      notify('Jour fermé ajouté.', 'success');
      setReloadKey((key) => key + 1);
    } catch (error) {
      setClosureError(errorMessage(error));
      notify(errorMessage(error), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function removeClosure(date: string) {
    if (!profile || !canManageClosures) return;
    if (!await confirmAction(`Retirer la fermeture du ${date.split('-').reverse().join('/')} ?`)) return;
    setSaving(true);
    setClosureError(null);
    setClosureMessage(null);
    try {
      await deletePlanningClosure(getSupabaseClient(), actor, date);
      setClosureMessage('Jour fermé retiré.');
      notify('Jour fermé retiré.', 'success');
      setReloadKey((key) => key + 1);
    } catch (error) {
      setClosureError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  function updateFilter(key: keyof PlanningFilters, value: string) {
    setFilters((current) => ({
      ...current,
      [key]: value,
      ...(key === 'formationId' ? { groupId: '', subjectId: '' } : {}),
    }));
  }

  function renderFilters() {
    if (!data) return null;
    return (
      <Panel className="planning-filter-panel">
        <div className="planning-filters">
          <label className="sp-form-field">
            Formation
            <select
              className="sp-field"
              onChange={(event) => updateFilter('formationId', event.target.value)}
              value={filters.formationId}
            >
              <option value="">Toutes les formations</option>
              {data.filters.formations.map((formation) => (
                <option key={formation.id} value={formation.id}>
                  {formation.name}
                </option>
              ))}
            </select>
          </label>
          <label className="sp-form-field">
            Groupe
            <select
              className="sp-field"
              disabled={!filters.formationId}
              onChange={(event) => updateFilter('groupId', event.target.value)}
              value={filters.groupId}
            >
              <option value="">Tous les groupes</option>
              {groupOptions.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <label className="sp-form-field">
            Formateur
            <select
              className="sp-field"
              disabled={profile?.role === 'formateur'}
              onChange={(event) => updateFilter('teacherId', event.target.value)}
              value={filters.teacherId}
            >
              <option value="">Tous les formateurs</option>
              {data.filters.teachers.map((teacher) => (
                <option key={teacher.id} value={teacher.id}>
                  {teacher.name}
                </option>
              ))}
            </select>
          </label>
          <label className="sp-form-field">
            Module
            <select
              className="sp-field"
              disabled={!filters.formationId}
              onChange={(event) => updateFilter('subjectId', event.target.value)}
              value={filters.subjectId}
            >
              <option value="">Tous les modules</option>
              {subjectOptions.map((subject) => (
                <option key={subject.id} value={subject.id}>
                  {subject.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Panel>
    );
  }

  function renderWeekToolbar() {
    return (
      <div className="planning-week-toolbar">
        <Button
          aria-label="Semaine précédente"
          onClick={() => setWeek((current) => addDays(current, -7))}
          variant="secondary"
        >
          ‹
        </Button>
        <strong>{toWeekLabel(week)}</strong>
        <Button
          aria-label="Semaine suivante"
          disabled={!canMoveForward}
          onClick={() => setWeek((current) => addDays(current, 7))}
          variant="secondary"
        >
          ›
        </Button>
        <Button onClick={() => setWeek(getMonday(new Date()))} variant="secondary">
          Aujourd’hui
        </Button>
      </div>
    );
  }

  function renderAgenda() {
    return (
      <Panel className="planning-agenda">
        <nav aria-label="Jour sélectionné" className="planning-day-chips">
          {DAY_NAMES.map((name, weekday) => {
            const date = toDateKey(addDays(week, weekday));
            return (
              <button
                aria-pressed={selectedDay === weekday}
                className={selectedDay === weekday ? 'is-selected' : ''}
                key={name}
                onClick={() => setSelectedDay(weekday)}
                type="button"
              >
                {name.slice(0, 3)} {toDayLabel(date)}
              </button>
            );
          })}
        </nav>
        {data?.closedDates[toDateKey(addDays(week, selectedDay))] && (
          <p className="planning-closed-label">
            {data.closedDates[toDateKey(addDays(week, selectedDay))]}
          </p>
        )}
        {groupedByDay[selectedDay]?.length ? (
          groupedByDay[selectedDay].map((occurrence) => (
            <article className="planning-agenda-item" key={occurrenceKey(occurrence)}>
              <div className="planning-agenda-time">
                {formatTime(occurrence.startsAtMinutes)}
                <small>{formatTime(occurrence.endsAtMinutes)}</small>
              </div>
              <div>
                <b>{occurrence.subjectName}</b>
                <small>
                  {occurrence.teacherName}
                  {occurrence.roomName ? ` · ${occurrence.roomName}` : ''}
                  {occurrence.groupName ? ` · ${occurrence.groupName}` : ''}
                </small>
              </div>
              {occurrence.cancelled && <span className="planning-state-label">Annulée</span>}
              {!occurrence.cancelled && occurrence.completed && (
                <span className="planning-state-label">Réalisée</span>
              )}
              {canManage && (
                <button
                  className="planning-action-link"
                  onClick={() => openEdit(occurrence)}
                  type="button"
                >
                  Gérer la séance
                </button>
              )}
            </article>
          ))
        ) : (
          <p className="planning-empty-day">
            Aucun cours {DAY_NAMES[selectedDay]?.toLocaleLowerCase('fr')}.
          </p>
        )}
      </Panel>
    );
  }

  function renderCalendar() {
    return (
      <div className="planning-calendar" role="region" aria-label="Calendrier hebdomadaire">
        <div className="planning-grid">
          <div className="planning-grid-corner" />
          {DAY_NAMES.map((name, weekday) => {
            const date = toDateKey(addDays(week, weekday));
            const closedLabel = data?.closedDates[date];
            return (
              <div
                className={`planning-grid-day${date === toDateKey(new Date()) ? ' is-today' : ''}${closedLabel ? ' is-closed' : ''}`}
                key={name}
              >
                <b>{name}</b>
                <small>{toDayLabel(date)}</small>
                {closedLabel && <small>{closedLabel}</small>}
              </div>
            );
          })}
          <div className="planning-time-axis">
            {Array.from({ length: GRID_HOURS }, (_, index) => (
              <span key={index}>{OPENING_HOUR + index}h</span>
            ))}
          </div>
          {DAY_NAMES.map((name, weekday) => (
            <div
              className={`planning-day-column${data?.closedDates[toDateKey(addDays(week, weekday))] ? ' is-closed' : ''}`}
              key={name}
              onClick={(event: MouseEvent<HTMLDivElement>) => {
                const date = toDateKey(addDays(week, weekday));
                const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
                const startMinutes = OPENING_HOUR * 60 + Math.floor((y / 56) * 2) * 30;
                openCreate(date, startMinutes);
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) {
                  return;
                }
                event.preventDefault();
                const date = toDateKey(addDays(week, weekday));
                openCreate(date);
              }}
              aria-label={`${name} ${toDayLabel(toDateKey(addDays(week, weekday)))}`}
              role="group"
              tabIndex={canManage ? 0 : undefined}
            >
              {groupedByDay[weekday]?.map((occurrence) => (
                <CourseCard
                  disabled={!canManage}
                  key={occurrenceKey(occurrence)}
                  occurrence={occurrence}
                  onSelect={openEdit}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderSessionList() {
    return (
      <Panel className="p-0">
        <div className="sp-table-wrap">
          <table className="sp-table planning-session-table">
            <thead>
              <tr>
                <th scope="col">Cours</th>
                <th scope="col">Horaire</th>
                <th scope="col">Formateur</th>
                <th scope="col">Domaine</th>
                <th scope="col">Salle</th>
                <th scope="col">Disponibilité de la salle</th>
              </tr>
            </thead>
            <tbody>
              {visibleSessions.length ? (
                visibleSessions.map((occurrence) => {
                  const freeSlots = occurrence.roomId
                    ? getRoomAvailability(
                        allOccurrences,
                        String(occurrence.roomId),
                        occurrence.weekday,
                      )
                    : [];
                  return (
                    <tr key={occurrenceKey(occurrence)}>
                      <td>
                        <b>{occurrence.subjectName}</b>
                        <small className="planning-table-secondary">
                          {DAY_NAMES[occurrence.weekday]}
                        </small>
                        {canManage && (
                          <button
                            className="planning-action-link"
                            onClick={() => openEdit(occurrence)}
                            type="button"
                          >
                            Gérer
                          </button>
                        )}
                      </td>
                      <td>
                        {formatTime(occurrence.startsAtMinutes)} –{' '}
                        {formatTime(occurrence.endsAtMinutes)}
                        <small className="planning-table-secondary">{occurrence.date}</small>
                      </td>
                      <td>{occurrence.teacherName}</td>
                      <td>{occurrence.domainName ?? '—'}</td>
                      <td>
                        {occurrence.roomName ?? '—'}
                        <small className="planning-table-secondary">
                          {occurrence.groupName ?? ''}
                        </small>
                      </td>
                      <td>
                        {occurrence.cancelled
                          ? 'Séance annulée'
                          : freeSlots.length
                            ? `Libre ${DAY_NAMES[occurrence.weekday]?.toLocaleLowerCase('fr')} : ${freeSlots.join(' · ')}`
                            : 'Complète ce jour-là'}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6}>Aucune séance ne correspond à ces filtres.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    );
  }

  return (
    <section aria-label={heading} className="mx-auto w-full max-w-screen-2xl space-y-4">
      <PageHeader
        actions={
          view === 'planning' && (canManage || canManageClosures) ? (
            <>
              {canManageClosures && (
                <Button onClick={openClosureManager} type="button" variant="secondary">
                  Jours fermés
                </Button>
              )}
              {canManage && (
                <Button
                  onClick={() => openCreate(toDateKey(addDays(week, selectedDay)))}
                  type="button"
                >
                  Nouvelle séance
                </Button>
              )}
            </>
          ) : undefined
        }
        description={
          view === 'planning'
            ? isStudent
              ? 'Votre calendrier de cours et de formateurs, en consultation uniquement.'
              : 'Semaine type, répétée chaque semaine, avec les séances prévues pour votre centre.'
            : 'Liste des séances prévues pendant la semaine sélectionnée.'
        }
        eyebrow={isStudent ? 'Espace étudiant' : profile?.role === 'formateur' ? 'Espace formateur' : 'Gestion du centre'}
        title={heading}
      />

      {state.status === 'loading' && (
        <Panel>
          <LoadingState label="Chargement du planning…" />
        </Panel>
      )}

      {state.status === 'error' && (
        <Alert className="space-y-2" tone="error">
          <p>Le planning n’a pas pu être chargé.</p>
          <p>{state.message}</p>
          <Button
            onClick={() => setReloadKey((key) => key + 1)}
            type="button"
            variant="secondary"
          >
            Réessayer
          </Button>
        </Alert>
      )}

      {actionMessage && <Alert tone="success">{actionMessage}</Alert>}

      {data && (
        <>
          {!isStudent && renderFilters()}
          {view === 'planning' && formationProgresses.length > 0 && (
            <section aria-label="Progression de la formation sélectionnée" className="space-y-3">
              <header className="planning-progress-section-heading">
                <div>
                  <p className="planning-progress-eyebrow">Suivi pédagogique</p>
                  <h2>Progression de la formation</h2>
                </div>
                <span>1 formation sélectionnée</span>
              </header>
              <div className="planning-progress-grid">
                {formationProgresses.map(({ formation, progress }) => (
                  <Panel className="planning-progress" key={formation.id}>
                    <div className="planning-progress-heading">
                      <div>
                        <p className="planning-progress-eyebrow">Formation</p>
                        <h3>{formation.name}</h3>
                      </div>
                      <strong>{progress.percentage} %</strong>
                    </div>
                    <div
                      aria-label={`Progression de ${formation.name} : ${progress.percentage} %`}
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={progress.percentage}
                      className="planning-progress-track"
                      role="progressbar"
                    >
                      <span style={{ width: `${progress.percentage}%` }} />
                    </div>
                    <p className="planning-progress-caption">
                      {progress.completedHours.toLocaleString('fr-FR', {
                        maximumFractionDigits: 1,
                      })}{' '}
                      h réalisées sur{' '}
                      {progress.plannedHours.toLocaleString('fr-FR', {
                        maximumFractionDigits: 1,
                      })}{' '}
                      h
                    </p>
                    <div className="planning-progress-metrics">
                      <div>
                        <span>Prévues</span>
                        <strong>
                          {progress.plannedHours.toLocaleString('fr-FR', {
                            maximumFractionDigits: 1,
                          })}{' '}
                          h
                        </strong>
                      </div>
                      <div>
                        <span>Réalisées</span>
                        <strong>
                          {progress.completedHours.toLocaleString('fr-FR', {
                            maximumFractionDigits: 1,
                          })}{' '}
                          h
                        </strong>
                      </div>
                      <div>
                        <span>Restantes</span>
                        <strong>
                          {progress.remainingHours.toLocaleString('fr-FR', {
                            maximumFractionDigits: 1,
                          })}{' '}
                          h
                        </strong>
                      </div>
                    </div>
                  </Panel>
                ))}
              </div>
            </section>
          )}
          {renderWeekToolbar()}
          {view === 'planning' ? (
            <>
              {renderAgenda()}
              <Panel className="planning-calendar-panel">{renderCalendar()}</Panel>
              <p className="planning-note">
                Semaine type, répétée chaque semaine. Les séances annulées et réalisées sont
                signalées dans le calendrier. L’administration du centre peut également gérer ses
                jours fermés.
              </p>
            </>
          ) : (
            renderSessionList()
          )}
          {visibleSessions.length === 0 && view === 'planning' && (
            <EmptyState title="Aucune séance ne correspond à ces filtres." />
          )}
        </>
      )}

      {editor && data && (
        <div className="planning-dialog-backdrop" onMouseDown={() => !saving && setEditor(null)}>
          <section
            aria-labelledby="planning-editor-title"
            aria-modal="true"
            className="planning-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="planning-dialog-heading">
              <h2 id="planning-editor-title">
                {editor.courseId ? 'Modifier une séance' : 'Ajouter une séance'}
              </h2>
              <button
                aria-label="Fermer"
                className="planning-dialog-close"
                disabled={saving}
                onClick={() => setEditor(null)}
                type="button"
              >
                ×
              </button>
            </header>
            <form className="planning-editor-form" onSubmit={submitEditor}>
              <label className="sp-form-field">
                Matière / module
                <select
                  className="sp-field"
                  onChange={(event) =>
                    setEditor((current) =>
                      current ? { ...current, subjectId: event.target.value } : current,
                    )
                  }
                  required
                  value={editor.subjectId}
                >
                  <option value="">Choisir une matière…</option>
                  {editorSubjects?.map((subject) => (
                    <option key={subject.id} value={subject.id}>
                      {subject.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="sp-form-field">
                Groupe de formation
                <select
                  className="sp-field"
                  onChange={(event) => changeEditorGroup(event.target.value)}
                  required
                  value={editor.groupId}
                >
                  <option value="">Sélectionner un groupe</option>
                  {data.filters.groups
                    .filter(
                      (group) =>
                        (group.active || String(group.id) === editor.groupId) &&
                        (profile?.role !== 'formateur' ||
                          String(group.teacherId) === String(teacherId)),
                    )
                    .map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                        {!group.active ? ' (inactif)' : ''}
                      </option>
                    ))}
                </select>
              </label>
              <label className="sp-form-field">
                Date
                <input
                  className="sp-field"
                  onChange={(event) =>
                    setEditor((current) =>
                      current ? { ...current, date: event.target.value } : current,
                    )
                  }
                  required
                  type="date"
                  value={editor.date}
                />
              </label>
              <label className="sp-form-field">
                Répétition
                <select
                  className="sp-field"
                  onChange={(event) =>
                    setEditor((current) =>
                      current
                        ? { ...current, recurring: event.target.value === 'weekly' }
                        : current,
                    )
                  }
                  value={editor.recurring ? 'weekly' : 'once'}
                >
                  <option value="weekly">Chaque semaine</option>
                  <option value="once">Ce jour seulement</option>
                </select>
              </label>
              <label className="sp-form-field">
                Début
                <select
                  className="sp-field"
                  onChange={(event) =>
                    setEditor((current) =>
                      current ? { ...current, startsAt: event.target.value } : current,
                    )
                  }
                  value={editor.startsAt}
                >
                  {START_TIMES.map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </select>
              </label>
              <label className="sp-form-field">
                Fin
                <select
                  className="sp-field"
                  onChange={(event) =>
                    setEditor((current) =>
                      current ? { ...current, endsAt: event.target.value } : current,
                    )
                  }
                  value={editor.endsAt}
                >
                  {END_TIMES.map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </select>
              </label>
              <label className="sp-form-field">
                Salle
                <select
                  className="sp-field"
                  onChange={(event) =>
                    setEditor((current) =>
                      current ? { ...current, roomId: event.target.value } : current,
                    )
                  }
                  value={editor.roomId}
                >
                  <option value="">Automatique (première salle libre)</option>
                  {data.filters.rooms.map((room) => (
                    <option key={room.id} value={room.id}>
                      {room.name}
                      {room.type ? ` · ${room.type}` : ''}
                      {room.capacity ? ` · ${room.capacity} pl.` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="sp-form-field">
                Formateur
                <select
                  className="sp-field"
                  disabled={!!editorGroup?.teacherId || profile?.role === 'formateur'}
                  onChange={(event) =>
                    setEditor((current) =>
                      current ? { ...current, teacherId: event.target.value } : current,
                    )
                  }
                  value={editorGroup?.teacherId?.toString() ?? editor.teacherId}
                >
                  <option value="">Automatique</option>
                  {editorTeachers?.map((teacher) => (
                    <option key={teacher.id} value={teacher.id}>
                      {teacher.name}
                    </option>
                  ))}
                </select>
                {editorGroup?.teacherId && (
                  <small className="planning-form-hint">
                    Formateur assigné au groupe : {assignedTeacherName ?? 'Formateur assigné'}
                  </small>
                )}
              </label>
              {actionError && (
                <Alert className="planning-form-message" tone="error">
                  {actionError}
                </Alert>
              )}
              <div className="planning-editor-actions">
                {editor.courseId !== undefined && (
                  <>
                    <Button
                      disabled={saving}
                      onClick={toggleCancellation}
                      type="button"
                      variant="secondary"
                    >
                      {editor.cancelled ? 'Rétablir cette séance' : 'Annuler cette séance'}
                    </Button>
                    {profile?.role === 'formateur' &&
                      !editor.cancelled &&
                      !editor.completed &&
                      String(editor.teacherId) === String(teacherId) && (
                        <Button
                          disabled={saving}
                          onClick={completeOccurrence}
                          type="button"
                          variant="secondary"
                        >
                          ✓ Séance terminée
                        </Button>
                      )}
                    <Button disabled={saving} onClick={deleteCourse} type="button" variant="danger">
                      Supprimer le cours
                    </Button>
                  </>
                )}
                <Button disabled={saving} type="submit">
                  {saving
                    ? 'Enregistrement…'
                    : editor.courseId
                      ? 'Enregistrer'
                      : 'Ajouter une séance'}
                </Button>
              </div>
            </form>
          </section>
        </div>
      )}

      {closureDialogOpen && (
        <div
          className="planning-dialog-backdrop"
          onMouseDown={() => !saving && setClosureDialogOpen(false)}
        >
          <section
            aria-labelledby="planning-closures-title"
            aria-modal="true"
            className="planning-dialog planning-closures-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="planning-dialog-heading">
              <h2 id="planning-closures-title">Jours fermés</h2>
              <button
                aria-label="Fermer"
                className="planning-dialog-close"
                disabled={saving}
                onClick={() => setClosureDialogOpen(false)}
                type="button"
              >
                ×
              </button>
            </header>
            <form className="planning-closure-form" onSubmit={submitClosure}>
              <label className="sp-form-field">
                Date
                <input
                  className="sp-field"
                  onChange={(event) => setClosureDate(event.target.value)}
                  required
                  type="date"
                  value={closureDate}
                />
              </label>
              <label className="sp-form-field">
                Motif
                <input
                  className="sp-field"
                  maxLength={40}
                  onChange={(event) => setClosureLabel(event.target.value)}
                  placeholder="Ex. : Fête du Trône"
                  value={closureLabel}
                />
              </label>
              <Button disabled={saving} type="submit">
                {saving ? 'Enregistrement…' : 'Ajouter'}
              </Button>
            </form>
            {closureError && <Alert tone="error">{closureError}</Alert>}
            {closureMessage && <Alert tone="success">{closureMessage}</Alert>}
            {state.status === 'error' && (
              <Alert tone="error">
                La liste des jours fermés n’a pas pu être rechargée. {state.message}
              </Alert>
            )}
            <div aria-label="Liste des jours fermés" className="planning-closure-list">
              {Object.entries(data?.closedDates ?? {})
                .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
                .map(([date, label]) => (
                  <div className="planning-closure-item" key={date}>
                    <span>
                      <b>{date.split('-').reverse().join('/')}</b> · {label}
                    </span>
                    <button
                      aria-label={`Retirer la fermeture du ${date.split('-').reverse().join('/')}`}
                      className="planning-dialog-close"
                      disabled={saving}
                      onClick={() => void removeClosure(date)}
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                ))}
              {Object.keys(data?.closedDates ?? {}).length === 0 && (
                <p className="planning-closure-empty">Aucun jour fermé.</p>
              )}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
