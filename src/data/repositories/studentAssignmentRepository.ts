import type { SupabaseClient } from '@supabase/supabase-js';
import type { StudentIdentifier } from '../../types/students';

function requireCentre(centreId: string): string {
  if (!centreId.trim()) throw new Error('Sélectionnez un centre avant de gérer les affectations.');
  return centreId;
}

async function ensureStudent(client: SupabaseClient, centreId: string, studentId: StudentIdentifier) {
  const { data, error } = await client
    .from('etudiants')
    .select('id, groupe_id')
    .eq('centre_id', centreId)
    .eq('id', studentId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Étudiant introuvable dans le centre actif.');
  return data as { id: StudentIdentifier; groupe_id: StudentIdentifier | null };
}

export async function assignStudentToGroup(
  client: SupabaseClient,
  centreIdValue: string,
  studentId: StudentIdentifier,
  groupId: StudentIdentifier | null,
): Promise<void> {
  const centreId = requireCentre(centreIdValue);
  await ensureStudent(client, centreId, studentId);

  if (groupId !== null) {
    const { data: group, error } = await client
      .from('groupes')
      .select('id, capacite, formation_id')
      .eq('centre_id', centreId)
      .eq('id', groupId)
      .eq('actif', true)
      .maybeSingle();
    if (error) throw error;
    if (!group) throw new Error('Sélectionnez un groupe actif de ce centre.');

    const { data: otherStudents, error: countError } = await client
      .from('etudiants')
      .select('id')
      .eq('centre_id', centreId)
      .eq('groupe_id', groupId);
    if (countError) throw countError;
    const currentCount = Array.isArray(otherStudents)
      ? otherStudents.filter((student) => String((student as { id: StudentIdentifier }).id) !== String(studentId)).length
      : 0;
    const capacity = Number((group as { capacite?: number | null }).capacite);
    if (Number.isFinite(capacity) && capacity > 0 && currentCount >= capacity) {
      throw new Error('Ce groupe a atteint sa capacité maximale.');
    }
  }

  const { data, error } = await client
    .from('etudiants')
    .update({ groupe_id: groupId })
    .eq('centre_id', centreId)
    .eq('id', studentId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('L’affectation du groupe n’a pas été enregistrée.');
}

export async function setStudentCourseEnrollment(
  client: SupabaseClient,
  centreIdValue: string,
  studentId: StudentIdentifier,
  courseId: StudentIdentifier,
  enrolled: boolean,
): Promise<void> {
  const centreId = requireCentre(centreIdValue);
  const student = await ensureStudent(client, centreId, studentId);

  const { data: course, error: courseError } = await client
    .from('cours')
    .select('id, groupe_id')
    .eq('centre_id', centreId)
    .eq('id', courseId)
    .maybeSingle();
  if (courseError) throw courseError;
  if (!course) throw new Error('Cours introuvable dans le centre actif.');

  const courseGroupId = (course as { groupe_id: StudentIdentifier | null }).groupe_id;
  if (enrolled && courseGroupId && String(student.groupe_id) !== String(courseGroupId)) {
    throw new Error('Affectez d’abord l’étudiant au groupe de ce cours.');
  }

  if (enrolled) {
    const { data: existing, error: existingError } = await client
      .from('inscriptions')
      .select('etudiant_id')
      .eq('centre_id', centreId)
      .eq('cours_id', courseId)
      .eq('etudiant_id', studentId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) return;

    const { error } = await client.from('inscriptions').insert({
      centre_id: centreId,
      cours_id: courseId,
      etudiant_id: studentId,
    });
    if (error) throw error;
    return;
  }

  const { error } = await client
    .from('inscriptions')
    .delete()
    .eq('centre_id', centreId)
    .eq('cours_id', courseId)
    .eq('etudiant_id', studentId);
  if (error) throw error;
}

export async function getStudentCourseEnrollmentIds(
  client: SupabaseClient,
  centreIdValue: string,
): Promise<Record<string, StudentIdentifier[]>> {
  const centreId = requireCentre(centreIdValue);
  const { data, error } = await client
    .from('inscriptions')
    .select('etudiant_id,cours_id')
    .eq('centre_id', centreId);
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('Réponse Supabase invalide : inscriptions attendues.');
  const result: Record<string, StudentIdentifier[]> = {};
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as { etudiant_id?: StudentIdentifier; cours_id?: StudentIdentifier };
    if (row.etudiant_id === undefined || row.cours_id === undefined) continue;
    const key = String(row.etudiant_id);
    result[key] ??= [];
    if (!result[key].some((id) => String(id) === String(row.cours_id))) result[key].push(row.cours_id);
  }
  return result;
}
