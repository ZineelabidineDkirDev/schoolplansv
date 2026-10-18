import type { SupabaseClient } from '@supabase/supabase-js';
import type { StudentIdentifier } from '../../types/students';

export type StudentCourse = {
  id: StudentIdentifier;
  subject: string;
  teacher: string;
  room: string;
  roomType: string;
  roomCapacity: number | null;
  weekday: number;
  startsAt: string;
  endsAt: string;
  startsOn: string | null;
  endsOn: string | null;
};

export type StudentAttendance = {
  courseId: StudentIdentifier;
  subject: string;
  date: string;
  status: 'present' | 'retard' | 'absent';
};

export type StudentWorkspace = {
  studentFound: boolean;
  courses: StudentCourse[];
  attendance: StudentAttendance[];
  realizedSessions: { courseId: StudentIdentifier; date: string }[];
  formation: { name: string; durationMonths: number | null; hoursPerWeek: number | null } | null;
};

type Row = Record<string, unknown>;

function parseRows(value: unknown, label: string): Row[] {
  if (!Array.isArray(value))
    throw new Error(`Réponse Supabase invalide : liste ${label} attendue.`);
  return value.map((row) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`Réponse Supabase invalide : ligne ${label} inattendue.`);
    }
    return row as Row;
  });
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function identifier(value: unknown, label: string): StudentIdentifier {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) return value;
  throw new Error(`Réponse Supabase invalide : identifiant ${label} manquant.`);
}

export async function getStudentWorkspace(
  client: SupabaseClient,
  centreId: string,
  email: string,
): Promise<StudentWorkspace> {
  if (!centreId) throw new Error('Votre profil n’est pas rattaché à un centre.');
  if (!email.trim()) throw new Error('Votre compte ne contient pas d’adresse e-mail vérifiable.');
  const { data: student, error: studentError } = await client
    .from('etudiants')
    .select('id,groupe_id')
    .eq('centre_id', centreId)
    .ilike('email', email.trim())
    .maybeSingle();
  if (studentError) throw studentError;
  if (!student) return { studentFound: false, courses: [], attendance: [], realizedSessions: [], formation: null };
  const studentId = identifier(student.id, 'étudiant');
  let formation: StudentWorkspace['formation'] = null;
  if (student.groupe_id !== null && student.groupe_id !== undefined) {
    const { data: group, error: groupError } = await client
      .from('groupes')
      .select('id,formation_id')
      .eq('centre_id', centreId)
      .eq('id', student.groupe_id)
      .maybeSingle();
    if (groupError) throw groupError;
    if (group?.formation_id !== null && group?.formation_id !== undefined) {
      const { data: formationRow, error: formationError } = await client
        .from('formations')
        .select('id,nom,duree,heures_par_semaine')
        .eq('centre_id', centreId)
        .eq('id', group.formation_id)
        .maybeSingle();
      if (formationError) throw formationError;
      if (formationRow) {
        const durationText = String(formationRow.duree ?? '');
        const durationMatch = durationText.match(/[0-9]+(?:[.,][0-9]+)?/);
        const durationMonths = durationMatch ? Number(durationMatch[0].replace(',', '.')) : null;
        const hoursPerWeek = typeof formationRow.heures_par_semaine === 'number'
          ? formationRow.heures_par_semaine
          : Number.isFinite(Number(formationRow.heures_par_semaine)) && formationRow.heures_par_semaine !== null
            ? Number(formationRow.heures_par_semaine)
            : null;
        formation = {
          name: text(formationRow.nom, 'Ma formation'),
          durationMonths: durationMonths !== null && Number.isFinite(durationMonths) ? durationMonths : null,
          hoursPerWeek: hoursPerWeek !== null && Number.isFinite(hoursPerWeek) ? hoursPerWeek : null,
        };
      }
    }
  }

  const [enrollmentsResult, attendanceResult] = await Promise.all([
    client
      .from('inscriptions')
      .select('cours_id')
      .eq('centre_id', centreId)
      .eq('etudiant_id', studentId),
    client
      .from('presences')
      .select('cours_id,date,statut')
      .eq('centre_id', centreId)
      .eq('etudiant_id', studentId)
      .order('date', { ascending: false }),
  ]);
  if (enrollmentsResult.error) throw enrollmentsResult.error;
  if (attendanceResult.error) throw attendanceResult.error;
  const courseIds = [
    ...new Set(
      parseRows(enrollmentsResult.data, 'inscriptions').map((row) =>
        identifier(row.cours_id, 'cours inscrit'),
      ),
    ),
  ];
  const attendanceRows = parseRows(attendanceResult.data, 'présences');
  const realizedResult = courseIds.length
    ? await client.from('seances_realisees').select('cours_id,date').in('cours_id', courseIds)
    : { data: [], error: null };
  const realizedSessions = parseRows(realizedResult.error ? [] : realizedResult.data, 'séances réalisées')
    .filter(row => typeof row.date === 'string')
    .map(row => ({ courseId: identifier(row.cours_id, 'cours de séance réalisée'), date: row.date as string }));
  const attendanceCourseIds = [
    ...new Set(attendanceRows.map((row) => identifier(row.cours_id, 'cours de présence'))),
  ];

  const [coursesResult, attendanceCoursesResult] = await Promise.all([
    courseIds.length
      ? client
          .from('cours')
          .select('id,matiere_id,formateur_id,salle_id,jour,debut,fin,valable_du,valable_au')
          .eq('centre_id', centreId)
          .in('id', courseIds)
      : Promise.resolve({ data: [], error: null }),
    attendanceCourseIds.length
      ? client
          .from('cours')
          .select('id,matiere_id')
          .eq('centre_id', centreId)
          .in('id', attendanceCourseIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (coursesResult.error) throw coursesResult.error;
  if (attendanceCoursesResult.error) throw attendanceCoursesResult.error;

  const courseRows = parseRows(coursesResult.data, 'cours');
  const presenceCourseRows = parseRows(attendanceCoursesResult.data, 'cours de présence');
  const subjectIds = [
    ...new Set(
      [...courseRows, ...presenceCourseRows]
        .map((row) => row.matiere_id)
        .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number'),
    ),
  ];
  const teacherIds = [
    ...new Set(
      courseRows
        .map((row) => row.formateur_id)
        .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number'),
    ),
  ];
  const roomIds = [
    ...new Set(
      courseRows
        .map((row) => row.salle_id)
        .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number'),
    ),
  ];
  const [subjectsResult, teachersResult, roomsResult] = await Promise.all([
    subjectIds.length
      ? client.from('matieres').select('id,nom').in('id', subjectIds)
      : Promise.resolve({ data: [], error: null }),
    teacherIds.length
      ? client.from('formateurs').select('id,nom').eq('centre_id', centreId).in('id', teacherIds)
      : Promise.resolve({ data: [], error: null }),
    roomIds.length
      ? client.from('salles').select('id,nom,type,capacite').eq('centre_id', centreId).in('id', roomIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (subjectsResult.error) throw subjectsResult.error;
  if (teachersResult.error) throw teachersResult.error;
  if (roomsResult.error) throw roomsResult.error;
  const namesById = (data: unknown, label: string) =>
    new Map(
      parseRows(data, label).map((row) => [
        String(identifier(row.id, `${label} associé`)),
        text(row.nom, ''),
      ]),
    );
  const subjects = namesById(subjectsResult.data, 'matières');
  const teachers = namesById(teachersResult.data, 'formateurs');
  const rooms = namesById(roomsResult.data, 'salles');
  const roomDetails = new Map(
    parseRows(roomsResult.data, 'salles').map((row) => [
      String(identifier(row.id, 'salle associée')),
      {
        type: text(row.type, ''),
        capacity: typeof row.capacite === 'number' && Number.isFinite(row.capacite) ? row.capacite : null,
      },
    ]),
  );
  const subjectByCourse = new Map(
    presenceCourseRows.map((row) => [
      String(identifier(row.id, 'cours de présence')),
      row.matiere_id === null || row.matiere_id === undefined
        ? 'Cours'
        : (subjects.get(String(row.matiere_id)) ?? 'Cours'),
    ]),
  );
  const courses = courseRows.map((row) => ({
    id: identifier(row.id, 'cours'),
    subject:
      row.matiere_id === null || row.matiere_id === undefined
        ? 'Cours'
        : (subjects.get(String(row.matiere_id)) ?? 'Cours'),
    teacher:
      row.formateur_id === null || row.formateur_id === undefined
        ? ''
        : (teachers.get(String(row.formateur_id)) ?? ''),
    room:
      row.salle_id === null || row.salle_id === undefined
        ? ''
        : (rooms.get(String(row.salle_id)) ?? ''),
    roomType:
      row.salle_id === null || row.salle_id === undefined
        ? ''
        : (roomDetails.get(String(row.salle_id))?.type ?? ''),
    roomCapacity:
      row.salle_id === null || row.salle_id === undefined
        ? null
        : (roomDetails.get(String(row.salle_id))?.capacity ?? null),
    weekday: typeof row.jour === 'number' ? row.jour : 0,
    startsAt: text(row.debut, ''),
    endsAt: text(row.fin, ''),
    startsOn: typeof row.valable_du === 'string' ? row.valable_du : null,
    endsOn: typeof row.valable_au === 'string' ? row.valable_au : null,
  }));
  const attendance = attendanceRows.map((row): StudentAttendance => {
    const courseId = identifier(row.cours_id, 'cours de présence');
    const status = row.statut;
    if (
      typeof row.date !== 'string' ||
      (status !== 'present' && status !== 'retard' && status !== 'absent')
    ) {
      throw new Error('Réponse Supabase invalide : date ou statut de présence inattendu.');
    }
    return {
      courseId,
      subject: subjectByCourse.get(String(courseId)) ?? 'Cours',
      date: row.date,
      status,
    };
  });

  return {
    studentFound: true,
    courses,
    attendance,
    realizedSessions,
    formation,
  };
}
