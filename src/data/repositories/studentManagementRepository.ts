import type { SupabaseClient } from '@supabase/supabase-js';
import type { StudentIdentifier } from '../../types/students';

export type StudentRecordInput = {
  firstName: string;
  lastName: string;
  email: string;
  telephone: string;
  city: string;
  address: string;
  educationLevel: string;
};

function normalize(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

function validate(centreId: string, input: StudentRecordInput): void {
  if (!centreId) throw new Error('Sélectionnez un centre avant de gérer les étudiants.');
  if (!input.firstName.trim() || !input.lastName.trim()) {
    throw new Error('Le prénom et le nom de l’étudiant sont obligatoires.');
  }
  const email = input.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('L’adresse e-mail de l’étudiant est invalide.');
  }
}

function toRow(centreId: string, input: StudentRecordInput) {
  return {
    centre_id: centreId,
    prenom: input.firstName.trim(),
    nom: input.lastName.trim(),
    email: normalize(input.email),
    telephone: normalize(input.telephone),
    ville: normalize(input.city),
    adresse: normalize(input.address),
    niveau_etudes: normalize(input.educationLevel),
  };
}

export async function createCentreStudent(
  client: SupabaseClient,
  centreId: string,
  input: StudentRecordInput,
): Promise<StudentIdentifier> {
  validate(centreId, input);
  const { data, error } = await client
    .from('etudiants')
    .insert(toRow(centreId, input))
    .select('id')
    .single();
  if (error) throw error;
  if (!data || (typeof data.id !== 'number' && typeof data.id !== 'string')) {
    throw new Error('Réponse Supabase invalide : identifiant étudiant manquant.');
  }
  return data.id;
}

export async function updateCentreStudent(
  client: SupabaseClient,
  centreId: string,
  studentId: StudentIdentifier,
  input: StudentRecordInput,
): Promise<void> {
  validate(centreId, input);
  const { data, error } = await client
    .from('etudiants')
    .update(toRow(centreId, input))
    .eq('centre_id', centreId)
    .eq('id', studentId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Étudiant introuvable dans le centre actif.');
}

export async function deleteCentreStudent(
  client: SupabaseClient,
  centreId: string,
  studentId: StudentIdentifier,
): Promise<void> {
  if (!centreId) throw new Error('Sélectionnez un centre avant de gérer les étudiants.');
  const { data: enrollments, error: enrollmentError } = await client
    .from('inscriptions')
    .select('cours_id')
    .eq('centre_id', centreId)
    .eq('etudiant_id', studentId);
  if (enrollmentError) throw enrollmentError;
  if (Array.isArray(enrollments) && enrollments.length > 0) {
    throw new Error('Impossible de supprimer cet étudiant : retirez d’abord ses inscriptions aux cours.');
  }

  const { data, error } = await client
    .from('etudiants')
    .delete()
    .eq('centre_id', centreId)
    .eq('id', studentId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Étudiant introuvable dans le centre actif.');
}
