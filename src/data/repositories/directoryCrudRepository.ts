import type { SupabaseClient } from '@supabase/supabase-js';
import type { StudentIdentifier } from '../../types/students';

export type RoomInput = { name: string; type: string; capacity: number | null };
export type TeacherInput = { name: string; email: string };

function centre(value: string): string {
  if (!value.trim()) throw new Error('Sélectionnez un centre avant de gérer ces données.');
  return value;
}
function required(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new Error(`Le champ ${label} est obligatoire.`);
  return result;
}
function validateRoom(input: RoomInput): RoomInput {
  const name = required(input.name, 'nom de salle');
  const type = input.type.trim();
  if (input.capacity !== null && (!Number.isInteger(input.capacity) || input.capacity < 1)) {
    throw new Error('La capacité doit être un nombre entier positif.');
  }
  return { name, type, capacity: input.capacity };
}
function validateTeacher(input: TeacherInput): TeacherInput {
  const name = required(input.name, 'nom du formateur');
  const email = input.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('L’adresse e-mail du formateur est invalide.');
  }
  return { name, email };
}

export async function createCentreRoom(client: SupabaseClient, centreIdValue: string, input: RoomInput): Promise<StudentIdentifier> {
  const centreId = centre(centreIdValue);
  const room = validateRoom(input);
  const { data, error } = await client.from('salles').insert({
    centre_id: centreId, nom: room.name, type: room.type || null, capacite: room.capacity,
  }).select('id').single();
  if (error) throw error;
  if (!data || (typeof data.id !== 'number' && typeof data.id !== 'string')) throw new Error('Identifiant de salle manquant dans la réponse.');
  return data.id;
}

export async function updateCentreRoom(client: SupabaseClient, centreIdValue: string, roomId: StudentIdentifier, input: RoomInput): Promise<void> {
  const centreId = centre(centreIdValue);
  const room = validateRoom(input);
  const { data, error } = await client.from('salles').update({
    nom: room.name, type: room.type || null, capacite: room.capacity,
  }).eq('centre_id', centreId).eq('id', roomId).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Salle introuvable dans le centre actif.');
}

export async function deleteCentreRoom(client: SupabaseClient, centreIdValue: string, roomId: StudentIdentifier): Promise<void> {
  const centreId = centre(centreIdValue);
  const { data: courses, error: lookupError } = await client.from('cours').select('id').eq('centre_id', centreId).eq('salle_id', roomId);
  if (lookupError) throw lookupError;
  if (Array.isArray(courses) && courses.length) throw new Error('Impossible de supprimer cette salle : elle est utilisée par un ou plusieurs cours.');
  const { data, error } = await client.from('salles').delete().eq('centre_id', centreId).eq('id', roomId).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Salle introuvable dans le centre actif.');
}

export async function createCentreTeacher(client: SupabaseClient, centreIdValue: string, input: TeacherInput): Promise<StudentIdentifier> {
  const centreId = centre(centreIdValue);
  const teacher = validateTeacher(input);
  const { data, error } = await client.from('formateurs').insert({
    centre_id: centreId, nom: teacher.name, email: teacher.email || null,
  }).select('id').single();
  if (error) throw error;
  if (!data || (typeof data.id !== 'number' && typeof data.id !== 'string')) throw new Error('Identifiant de formateur manquant dans la réponse.');
  return data.id;
}

export async function updateCentreTeacher(client: SupabaseClient, centreIdValue: string, teacherId: StudentIdentifier, input: TeacherInput): Promise<void> {
  const centreId = centre(centreIdValue);
  const teacher = validateTeacher(input);
  const { data, error } = await client.from('formateurs').update({
    nom: teacher.name, email: teacher.email || null,
  }).eq('centre_id', centreId).eq('id', teacherId).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Formateur introuvable dans le centre actif.');
}

export async function deleteCentreTeacher(client: SupabaseClient, centreIdValue: string, teacherId: StudentIdentifier): Promise<void> {
  const centreId = centre(centreIdValue);
  const { data: teacher, error: teacherError } = await client.from('formateurs').select('id,profile_id').eq('centre_id', centreId).eq('id', teacherId).maybeSingle();
  if (teacherError) throw teacherError;
  if (!teacher) throw new Error('Formateur introuvable dans le centre actif.');
  if ((teacher as { profile_id?: string | null }).profile_id) {
    throw new Error('Impossible de supprimer ce formateur : un compte de connexion lui est associé.');
  }
  const { data: courses, error: coursesError } = await client.from('cours').select('id').eq('centre_id', centreId).eq('formateur_id', teacherId);
  if (coursesError) throw coursesError;
  if (Array.isArray(courses) && courses.length) throw new Error('Impossible de supprimer ce formateur : des cours lui sont attribués.');
  const { error } = await client.from('formateur_matieres').delete().eq('formateur_id', teacherId);
  if (error) throw error;
  const { data, error: deleteError } = await client.from('formateurs').delete().eq('centre_id', centreId).eq('id', teacherId).select('id').maybeSingle();
  if (deleteError) throw deleteError;
  if (!data) throw new Error('Le formateur n’a pas été supprimé.');
}
