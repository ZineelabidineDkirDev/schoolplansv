import type { SupabaseClient } from '@supabase/supabase-js';
import { validatePlanningCourse, type PlanningActor } from '../../business/planning/planningRules';
import type { StudentIdentifier } from '../../types/students';
import type {
  PlanningCourse,
  PlanningCourseInput,
  PlanningData,
  PlanningGroup,
  PlanningRoom,
} from '../../types/planning';

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Réponse Supabase invalide : ${name} attendu.`);
  }
  return value as Record<string, unknown>;
}

function rows(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`Réponse Supabase invalide : liste ${name} attendue.`);
  return value.map((row) => record(row, name));
}

function identifier(value: unknown, name: string): StudentIdentifier {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) return value;
  throw new Error(`Réponse Supabase invalide : identifiant ${name} manquant.`);
}

function optionalIdentifier(value: unknown): StudentIdentifier | null {
  return value === null || value === undefined ? null : identifier(value, 'associé');
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`Réponse Supabase invalide : ${name} manquant.`);
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function optionalHours(value: unknown): number | string | null {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value ?? null;
  }
  throw new Error('Réponse Supabase invalide : volume horaire de formation attendu.');
}

function optionalNumberOrText(value: unknown): number | string | null {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value ?? null;
  }
  throw new Error('Réponse Supabase invalide : valeur de formation attendue.');
}

function uniqueOptions<T extends { id: StudentIdentifier; name: string }>(options: T[]): T[] {
  return [...new Map(options.map((option) => [String(option.id), option])).values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'fr'),
  );
}

export async function getPlanningData(
  client: SupabaseClient,
  centreId: string,
  profileId: string,
  role: 'admin' | 'director' | 'super_admin' | 'formateur' | 'etudiant',
  email = '',
): Promise<PlanningData> {
  if (!centreId) {
    throw new Error(
      role === 'super_admin'
        ? 'Sélectionnez un centre avant d’ouvrir le planning.'
        : 'Votre profil n’est rattaché à aucun centre.',
    );
  }

  let studentCourseIds: StudentIdentifier[] | null = null;
  if (role === 'etudiant') {
    if (!email.trim()) {
      throw new Error('Votre compte ne contient pas d’adresse e-mail vérifiable.');
    }
    const { data: student, error: studentError } = await client
      .from('etudiants')
      .select('id')
      .eq('centre_id', centreId)
      .ilike('email', email.trim())
      .maybeSingle();
    if (studentError) throw studentError;
    if (!student) {
      studentCourseIds = [];
    } else {
      const { data: enrollments, error: enrollmentsError } = await client
        .from('inscriptions')
        .select('cours_id')
        .eq('centre_id', centreId)
        .eq('etudiant_id', student.id);
      if (enrollmentsError) throw enrollmentsError;
      studentCourseIds = [...new Set((enrollments ?? [])
        .map((row) => row.cours_id)
        .filter((id): id is StudentIdentifier => typeof id === 'string' || typeof id === 'number'))];
    }
  }

  let teacherId: StudentIdentifier | null = null;
  if (role === 'formateur') {
    const { data, error } = await client
      .from('formateurs')
      .select('id')
      .eq('profile_id', profileId)
      .eq('centre_id', centreId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return {
        courses: [],
        filters: { formations: [], groups: [], subjects: [], teachers: [], rooms: [] },
        subjectIdsByFormation: {},
        subjectIdsByTeacher: {},
        closedDates: {},
        cancelledOccurrences: new Set(),
        completedOccurrences: new Set(),
      };
    }
    teacherId = identifier(record(data, 'formateur').id, 'formateur');
  }

  let coursesQuery = client
    .from('cours')
    .select('id,matiere_id,formateur_id,salle_id,groupe_id,jour,debut,fin,valable_du,valable_au')
    .eq('centre_id', centreId);
  if (teacherId !== null) coursesQuery = coursesQuery.eq('formateur_id', teacherId);
  if (studentCourseIds !== null) {
    coursesQuery = studentCourseIds.length
      ? coursesQuery.in('id', studentCourseIds)
      : coursesQuery.in('id', ['__no_student_courses__']);
  }

  let teachersQuery = client
    .from('formateurs')
    .select('id,nom,email,profile_id')
    .eq('centre_id', centreId);
  if (teacherId !== null) teachersQuery = teachersQuery.eq('id', teacherId);

  const [
    coursesResult,
    subjectsResult,
    domainsResult,
    teachersResult,
    roomsResult,
    groupsResult,
    formationsResult,
    formationSubjectsResult,
    teacherSubjectsResult,
    cancellationsResult,
    closuresResult,
    completedResult,
  ] = await Promise.all([
    coursesQuery,
    client.from('matieres').select('id,nom,domaine_id'),
    client.from('domaines').select('id,nom'),
    teachersQuery,
    client.from('salles').select('id,nom,type,capacite').eq('centre_id', centreId),
    client
      .from('groupes')
      .select('id,nom,formation_id,formateur_id,capacite,actif,date_debut,date_fin')
      .eq('centre_id', centreId),
    client
      .from('formations')
      .select('id,nom,duree,heures_par_semaine,heures_totales,description,actif')
      .eq('centre_id', centreId)
      .order('nom'),
    client.from('formation_matieres').select('formation_id,matiere_id'),
    client.from('formateur_matieres').select('formateur_id,matiere_id'),
    client.from('annulations').select('cours_id,date').eq('centre_id', centreId),
    client.from('fermetures').select('date,libelle').eq('centre_id', centreId),
    client.from('seances_realisees').select('cours_id,date').eq('centre_id', centreId),
  ]);

  const results = [
    coursesResult,
    subjectsResult,
    domainsResult,
    teachersResult,
    roomsResult,
    groupsResult,
    formationsResult,
    formationSubjectsResult,
    teacherSubjectsResult,
    cancellationsResult,
    closuresResult,
    completedResult,
  ];
  const failure = results.find((result) => result.error);
  if (failure?.error) throw failure.error;

  const subjects = rows(subjectsResult.data, 'matières');
  const domainsById = new Map(
    rows(domainsResult.data, 'domaines').map((domain) => [
      String(identifier(domain.id, 'domaine')),
      text(domain.nom, 'nom de domaine'),
    ]),
  );
  const subjectById = new Map(
    subjects.map((subject) => [
      String(identifier(subject.id, 'matière')),
      {
        name: text(subject.nom, 'nom de matière'),
        domainName:
          subject.domaine_id === null || subject.domaine_id === undefined
            ? null
            : (domainsById.get(String(subject.domaine_id)) ?? null),
      },
    ]),
  );
  const teacherById = new Map(
    rows(teachersResult.data, 'formateurs').map((teacher) => [
      String(identifier(teacher.id, 'formateur')),
      text(teacher.nom, 'nom du formateur'),
    ]),
  );
  const roomById = new Map(
    rows(roomsResult.data, 'salles').map((room) => [
      String(identifier(room.id, 'salle')),
      text(room.nom, 'nom de salle'),
    ]),
  );
  const formations = rows(formationsResult.data, 'formations').map((formation) => ({
    id: identifier(formation.id, 'formation'),
    name: text(formation.nom, 'nom de formation'),
    totalHours: optionalHours(formation.heures_totales),
    duration: optionalText(formation.duree),
    hoursPerWeek: optionalNumberOrText(formation.heures_par_semaine),
    description: optionalText(formation.description),
    active: formation.actif === true,
  }));
  const formationById = new Map(formations.map((formation) => [String(formation.id), formation]));
  const groups: PlanningGroup[] = rows(groupsResult.data, 'groupes').map((group) => {
    const formationId = optionalIdentifier(group.formation_id);
    return {
      id: identifier(group.id, 'groupe'),
      name: text(group.nom, 'nom de groupe'),
      formationId,
      formationName: formationId ? (formationById.get(String(formationId))?.name ?? null) : null,
      teacherId: optionalIdentifier(group.formateur_id),
      capacity: typeof group.capacite === 'number' && group.capacite > 0 ? group.capacite : 30,
      active: group.actif === true,
      startsOn: optionalText(group.date_debut),
      endsOn: optionalText(group.date_fin),
    };
  });
  const groupById = new Map(groups.map((group) => [String(group.id), group]));

  const subjectIdsByFormation: Record<string, StudentIdentifier[]> = {};
  for (const link of rows(formationSubjectsResult.data, 'matières des formations')) {
    const id = String(identifier(link.formation_id, 'formation'));
    const subjectsForFormation = subjectIdsByFormation[id] ?? [];
    subjectsForFormation.push(identifier(link.matiere_id, 'matière'));
    subjectIdsByFormation[id] = subjectsForFormation;
  }
  const subjectIdsByTeacher: Record<string, StudentIdentifier[]> = {};
  for (const link of rows(teacherSubjectsResult.data, 'matières des formateurs')) {
    const id = String(identifier(link.formateur_id, 'formateur'));
    const subjectsForTeacher = subjectIdsByTeacher[id] ?? [];
    subjectsForTeacher.push(identifier(link.matiere_id, 'matière'));
    subjectIdsByTeacher[id] = subjectsForTeacher;
  }
  const courses: PlanningCourse[] = rows(coursesResult.data, 'cours').map((course) => {
    const subjectId = identifier(course.matiere_id, 'matière du cours');
    const courseTeacherId = identifier(course.formateur_id, 'formateur du cours');
    const groupId = optionalIdentifier(course.groupe_id);
    const group = groupId ? groupById.get(String(groupId)) : undefined;
    const subject = subjectById.get(String(subjectId));
    const teacherName = teacherById.get(String(courseTeacherId));
    if (!subject) throw new Error(`Matière introuvable pour le cours ${String(course.id)}.`);
    if (!teacherName) throw new Error(`Formateur introuvable pour le cours ${String(course.id)}.`);

    return {
      id: identifier(course.id, 'cours'),
      subjectId,
      teacherId: courseTeacherId,
      roomId: optionalIdentifier(course.salle_id),
      groupId,
      weekday: Number(course.jour),
      startsAt: text(course.debut, 'heure de début'),
      endsAt: text(course.fin, 'heure de fin'),
      startsOn: optionalText(course.valable_du),
      endsOn: optionalText(course.valable_au),
      subjectName: subject.name,
      domainName: subject.domainName,
      teacherName,
      roomName: course.salle_id === null ? null : (roomById.get(String(course.salle_id)) ?? null),
      groupName: group?.name ?? null,
      formationId: group?.formationId ?? null,
    };
  });
  const rooms: PlanningRoom[] = rows(roomsResult.data, 'salles').map((room) => ({
    id: identifier(room.id, 'salle'),
    name: text(room.nom, 'nom de salle'),
    type: optionalText(room.type),
    capacity:
      typeof room.capacite === 'number' && Number.isFinite(room.capacite) ? room.capacite : null,
  }));

  const filteredTeachers = rows(teachersResult.data, 'formateurs').map((teacher) => ({
    id: identifier(teacher.id, 'formateur'),
    name: text(teacher.nom, 'nom du formateur'),
    email: optionalText(teacher.email),
    profileId: optionalText(teacher.profile_id),
  }));

  const closedDates: Record<string, string> = {};
  for (const closure of rows(closuresResult.data, 'fermetures')) {
    closedDates[text(closure.date, 'date de fermeture')] = optionalText(closure.libelle) ?? 'Fermé';
  }

  return {
    courses,
    filters: {
      formations,
      groups,
      subjects: uniqueOptions(
        [...subjectById].map(([id, subject]) => ({
          id,
          name: subject.name,
          domainName: subject.domainName,
        })),
      ),
      teachers: filteredTeachers,
      rooms,
    },
    subjectIdsByFormation,
    subjectIdsByTeacher,
    closedDates,
    cancelledOccurrences: new Set(
      rows(cancellationsResult.data, 'annulations').map(
        (cancellation) =>
          `${identifier(cancellation.cours_id, 'cours annulé')}|${text(cancellation.date, 'date annulée')}`,
      ),
    ),
    completedOccurrences: new Set(
      rows(completedResult.data, 'séances réalisées').map(
        (completed) =>
          `${identifier(completed.cours_id, 'cours réalisé')}|${text(completed.date, 'date réalisée')}`,
      ),
    ),
  };
}

function assertClosureManager(actor: PlanningActor): string {
  if (!actor.centreId) throw new Error('Votre profil n’est pas rattaché à un centre.');
  if (actor.role !== 'admin' && actor.role !== 'director') {
    throw new Error('La gestion des jours fermés est réservée à l’administration.');
  }
  return actor.centreId;
}

function validateClosureDate(date: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error('La date de fermeture est invalide.');
  const parsedDate = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new Error('La date de fermeture est invalide.');
  }
}

export async function savePlanningClosure(
  client: SupabaseClient,
  actor: PlanningActor,
  date: string,
  label: string,
): Promise<void> {
  const centreId = assertClosureManager(actor);
  validateClosureDate(date);
  const normalizedLabel = label.trim() || 'Fermé';
  if (normalizedLabel.length > 40) {
    throw new Error('Le motif de fermeture ne peut pas dépasser 40 caractères.');
  }

  const { error } = await client
    .from('fermetures')
    .upsert(
      { date, libelle: normalizedLabel, centre_id: centreId },
      { onConflict: 'centre_id,date' },
    );
  if (error) throw error;
}

export async function deletePlanningClosure(
  client: SupabaseClient,
  actor: PlanningActor,
  date: string,
): Promise<void> {
  const centreId = assertClosureManager(actor);
  validateClosureDate(date);
  const { error } = await client
    .from('fermetures')
    .delete()
    .eq('date', date)
    .eq('centre_id', centreId);
  if (error) throw error;
}

export async function savePlanningCourse(
  client: SupabaseClient,
  data: PlanningData,
  actor: PlanningActor,
  input: PlanningCourseInput,
): Promise<void> {
  if (!actor.centreId) throw new Error('Votre profil n’est pas rattaché à un centre.');
  const validated = validatePlanningCourse(input, data, actor);
  const payload = {
    matiere_id: input.subjectId,
    formateur_id: validated.teacherId,
    salle_id: validated.roomId,
    groupe_id: validated.group.id,
    jour: (new Date(`${input.date}T12:00:00`).getDay() + 6) % 7,
    debut: input.startsAt,
    fin: input.endsAt,
    valable_du: validated.startsOn,
    valable_au: validated.endsOn,
  };

  if (input.courseId !== undefined) {
    let query = client
      .from('cours')
      .update(payload)
      .eq('id', input.courseId)
      .eq('centre_id', actor.centreId);
    if (actor.role === 'formateur') query = query.eq('formateur_id', actor.teacherId);
    const { data: updated, error } = await query.select('id').maybeSingle();
    if (error) {
      if (error.code === '23P01') {
        throw new Error('Conflit : ce créneau est déjà occupé (salle ou formateur).');
      }
      throw error;
    }
    if (!updated) throw new Error('La séance n’a pas été modifiée : elle est introuvable.');
    return;
  }

  const { error } = await client.from('cours').insert({ ...payload, centre_id: actor.centreId });
  if (error) {
    if (error.code === '23P01') {
      throw new Error('Conflit : ce créneau est déjà occupé (salle ou formateur).');
    }
    throw error;
  }
}

export async function deletePlanningCourse(
  client: SupabaseClient,
  actor: PlanningActor,
  courseId: StudentIdentifier,
): Promise<void> {
  if (!actor.centreId) throw new Error('Votre profil n’est pas rattaché à un centre.');
  let query = client.from('cours').delete().eq('id', courseId).eq('centre_id', actor.centreId);
  if (actor.role === 'formateur') {
    if (!actor.teacherId) throw new Error('Votre compte formateur n’est pas relié à une fiche.');
    query = query.eq('formateur_id', actor.teacherId);
  }
  const { error } = await query;
  if (error) throw error;
}

export async function setPlanningOccurrenceCancelled(
  client: SupabaseClient,
  actor: PlanningActor,
  courseId: StudentIdentifier,
  date: string,
  cancelled: boolean,
): Promise<void> {
  if (!actor.centreId) throw new Error('Votre profil n’est pas rattaché à un centre.');
  let courseQuery = client
    .from('cours')
    .select('id')
    .eq('id', courseId)
    .eq('centre_id', actor.centreId);
  if (actor.role === 'formateur') {
    if (!actor.teacherId) throw new Error('Votre compte formateur n’est pas relié à une fiche.');
    courseQuery = courseQuery.eq('formateur_id', actor.teacherId);
  }
  const { data, error: lookupError } = await courseQuery.maybeSingle();
  if (lookupError) throw lookupError;
  if (!data) throw new Error('La séance ne vous est pas attribuée ou est introuvable.');

  if (cancelled) {
    const { error } = await client
      .from('annulations')
      .insert({ cours_id: courseId, date, centre_id: actor.centreId });
    if (error) throw error;
    return;
  }
  const { error } = await client
    .from('annulations')
    .delete()
    .eq('cours_id', courseId)
    .eq('date', date)
    .eq('centre_id', actor.centreId);
  if (error) throw error;
}

export async function markPlanningOccurrenceCompleted(
  client: SupabaseClient,
  actor: PlanningActor,
  courseId: StudentIdentifier,
  date: string,
): Promise<void> {
  if (actor.role !== 'formateur' || !actor.teacherId) {
    throw new Error('Action réservée au formateur auquel cette séance est attribuée.');
  }
  if (!actor.centreId) throw new Error('Votre profil n’est pas rattaché à un centre.');

  const { data, error: lookupError } = await client
    .from('cours')
    .select('id')
    .eq('id', courseId)
    .eq('centre_id', actor.centreId)
    .eq('formateur_id', actor.teacherId)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (!data) throw new Error('Ce cours ne vous est pas attribué.');

  const { error } = await client
    .from('seances_realisees')
    .upsert(
      { cours_id: courseId, date, centre_id: actor.centreId },
      { onConflict: 'cours_id,date' },
    );
  if (error) throw error;
}
