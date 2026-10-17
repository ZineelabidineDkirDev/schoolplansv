import type { SupabaseClient } from '@supabase/supabase-js';
import type { StudentIdentifier } from '../../types/students';

export type FormationInput = {
  id?: StudentIdentifier;
  name: string;
  duration: string;
  hoursPerWeek: number;
  description: string;
  moduleIds: StudentIdentifier[];
};

export type GroupInput = {
  name: string;
  formationId: StudentIdentifier;
  teacherId: StudentIdentifier | null;
  startsOn: string;
  capacity: number;
};

export type ModuleOption = {
  id: StudentIdentifier;
  name: string;
  domainId: StudentIdentifier | null;
};

export type ModuleDomain = {
  id: StudentIdentifier;
  name: string;
};

export type FormationGroupData = {
  modules: ModuleOption[];
  domains: ModuleDomain[];
};

function requireCentre(centreId: string): string {
  if (!centreId.trim()) throw new Error('Votre profil n’est pas rattaché à un centre.');
  return centreId;
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function calculateGroupEndDate(startDate: string, duration: string): string {
  if (!validDate(startDate)) throw new Error('Veuillez renseigner une date de début valide.');
  const match = duration
    .trim()
    .toLocaleLowerCase('fr')
    .match(/^(\d+)\s*(mois|ans?|années?|annees?)$/);
  if (!match || Number(match[1]) < 1) {
    throw new Error('Durée invalide. Utilisez par exemple : 3 mois ou 1 an.');
  }

  const date = new Date(`${startDate}T12:00:00`);
  const day = date.getDate();
  date.setDate(1);
  if (match[2] === 'mois') date.setMonth(date.getMonth() + Number(match[1]));
  else date.setFullYear(date.getFullYear() + Number(match[1]));
  date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

async function saveFormationModules(
  client: SupabaseClient,
  formationId: StudentIdentifier,
  moduleIds: StudentIdentifier[],
): Promise<void> {
  const { data, error } = await client
    .from('formation_matieres')
    .select('matiere_id')
    .eq('formation_id', formationId);
  if (error) throw error;

  const existing = Array.isArray(data)
    ? data.map((row) => (row as { matiere_id: StudentIdentifier }).matiere_id)
    : [];
  const selected = [...new Map(moduleIds.map((id) => [String(id), id])).values()];
  const add = selected.filter((id) => !existing.some((current) => String(current) === String(id)));
  const remove = existing.filter(
    (id) => !selected.some((current) => String(current) === String(id)),
  );

  if (add.length) {
    const { error: insertError } = await client
      .from('formation_matieres')
      .insert(add.map((matiere_id) => ({ formation_id: formationId, matiere_id })));
    if (insertError) throw insertError;
  }
  if (remove.length) {
    const { error: deleteError } = await client
      .from('formation_matieres')
      .delete()
      .eq('formation_id', formationId)
      .in('matiere_id', remove);
    if (deleteError) throw deleteError;
  }
}

export async function getFormationGroupData(
  client: SupabaseClient,
  centreIdValue: string,
): Promise<FormationGroupData> {
  const centreId = requireCentre(centreIdValue);
  const [catalogResult, moduleResult, domainsResult] = await Promise.all([
    client.from('centre_matieres').select('matiere_id').eq('centre_id', centreId),
    client.from('matieres').select('id,nom,domaine_id').order('nom'),
    client.from('domaines').select('id,nom').order('nom'),
  ]);
  if (catalogResult.error) throw catalogResult.error;
  if (moduleResult.error) throw moduleResult.error;
  if (domainsResult.error) throw domainsResult.error;

  const allowedIds = new Set(
    Array.isArray(catalogResult.data)
      ? catalogResult.data.map((row) => String((row as { matiere_id: unknown }).matiere_id))
      : [],
  );
  const modules = (Array.isArray(moduleResult.data) ? moduleResult.data : [])
    .filter((row) => allowedIds.has(String((row as { id: unknown }).id)))
    .map((row) => {
      const module = row as {
        id: StudentIdentifier;
        nom: string;
        domaine_id: StudentIdentifier | null;
      };
      return { id: module.id, name: module.nom, domainId: module.domaine_id ?? null };
    });
  const domains = (Array.isArray(domainsResult.data) ? domainsResult.data : []).map((row) => {
    const domain = row as { id: StudentIdentifier; nom: string };
    return { id: domain.id, name: domain.nom };
  });
  return { modules, domains };
}

export async function createModuleForCentre(
  client: SupabaseClient,
  centreIdValue: string,
  nameValue: string,
  domainId: StudentIdentifier,
): Promise<ModuleOption> {
  const centreId = requireCentre(centreIdValue);
  const name = nameValue.trim();
  if (!name || name.length > 100 || !domainId) {
    throw new Error('Saisissez un nom de module et choisissez un domaine.');
  }
  const codeBase =
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('en')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'module';
  const { data, error } = await client
    .from('matieres')
    .insert({
      nom: name,
      code: `${codeBase}-${Math.random().toString(36).slice(2, 8)}`,
      domaine_id: domainId,
      icone: 'book',
    })
    .select('id,nom,domaine_id')
    .single();
  if (error) throw error;
  if (!data) throw new Error('Le module a été créé sans renvoyer son identifiant.');
  const module = data as {
    id: StudentIdentifier;
    nom: string;
    domaine_id: StudentIdentifier | null;
  };
  const { error: associationError } = await client
    .from('centre_matieres')
    .insert({ centre_id: centreId, matiere_id: module.id });
  if (associationError) {
    throw new Error(
      `Module créé, mais association au centre impossible : ${associationError.message}`,
    );
  }
  return { id: module.id, name: module.nom, domainId: module.domaine_id ?? null };
}

export async function saveFormation(
  client: SupabaseClient,
  centreIdValue: string,
  input: FormationInput,
): Promise<StudentIdentifier> {
  const centreId = requireCentre(centreIdValue);
  const name = input.name.trim();
  const duration = input.duration.trim();
  const description = input.description.trim();
  if (!name || name.length > 150)
    throw new Error('Le nom de la formation est obligatoire (150 caractères maximum).');
  if (
    !Number.isFinite(input.hoursPerWeek) ||
    input.hoursPerWeek < 0.5 ||
    input.hoursPerWeek > 168
  ) {
    throw new Error('Saisissez un nombre d’heures hebdomadaires valide, entre 0,5 et 168.');
  }

  const payload = {
    nom: name,
    duree: duration || null,
    heures_par_semaine: input.hoursPerWeek,
    description: description || null,
  };
  let formationId = input.id;
  if (formationId === undefined) {
    const { data, error } = await client
      .from('formations')
      .insert({ ...payload, actif: true, centre_id: centreId })
      .select('id')
      .single();
    if (error) throw error;
    if (!data) throw new Error('La formation a été enregistrée sans renvoyer son identifiant.');
    formationId = (data as { id: StudentIdentifier }).id;
  } else {
    const { data, error } = await client
      .from('formations')
      .update(payload)
      .eq('id', formationId)
      .eq('centre_id', centreId)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Formation introuvable dans ce centre.');
  }
  await saveFormationModules(client, formationId, input.moduleIds);
  return formationId;
}

export async function deleteFormation(
  client: SupabaseClient,
  centreIdValue: string,
  formationId: StudentIdentifier,
): Promise<void> {
  const centreId = requireCentre(centreIdValue);
  const { error } = await client
    .from('formations')
    .delete()
    .eq('id', formationId)
    .eq('centre_id', centreId);
  if (error) throw error;
}

export async function createGroup(
  client: SupabaseClient,
  centreIdValue: string,
  input: GroupInput,
): Promise<void> {
  const centreId = requireCentre(centreIdValue);
  const name = input.name.trim();
  if (!name || name.length > 100)
    throw new Error('Le nom du groupe est obligatoire (100 caractères maximum).');
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 500) {
    throw new Error('La capacité doit être comprise entre 1 et 500 étudiants.');
  }
  if (!input.formationId) throw new Error('Veuillez sélectionner une formation.');

  const { data: formation, error: formationError } = await client
    .from('formations')
    .select('duree')
    .eq('id', input.formationId)
    .eq('centre_id', centreId)
    .eq('actif', true)
    .maybeSingle();
  if (formationError) throw formationError;
  if (!formation) throw new Error('Sélectionnez une formation active de ce centre.');
  const endDate = calculateGroupEndDate(
    input.startsOn,
    (formation as { duree: string | null }).duree ?? '',
  );
  const { error } = await client.from('groupes').insert({
    nom: name,
    formation_id: input.formationId,
    formateur_id: input.teacherId,
    date_debut: input.startsOn,
    date_fin: endDate,
    actif: true,
    capacite: input.capacity,
    centre_id: centreId,
  });
  if (error) throw error;
}

export async function deleteGroup(
  client: SupabaseClient,
  centreIdValue: string,
  groupId: StudentIdentifier,
): Promise<void> {
  const centreId = requireCentre(centreIdValue);
  const { error } = await client
    .from('groupes')
    .delete()
    .eq('id', groupId)
    .eq('centre_id', centreId);
  if (error) throw error;
}


export async function updateGroup(
  client: SupabaseClient,
  centreIdValue: string,
  groupId: StudentIdentifier,
  input: GroupInput,
): Promise<void> {
  const centreId = requireCentre(centreIdValue);
  const name = input.name.trim();
  if (!name || name.length > 100) {
    throw new Error('Le nom du groupe est obligatoire (100 caractères maximum).');
  }
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 500) {
    throw new Error('La capacité doit être comprise entre 1 et 500 étudiants.');
  }
  if (!input.formationId) throw new Error('Veuillez sélectionner une formation.');

  const { data: formation, error: formationError } = await client
    .from('formations')
    .select('duree')
    .eq('id', input.formationId)
    .eq('centre_id', centreId)
    .eq('actif', true)
    .maybeSingle();
  if (formationError) throw formationError;
  if (!formation) throw new Error('Sélectionnez une formation active de ce centre.');

  const endDate = calculateGroupEndDate(
    input.startsOn,
    (formation as { duree: string | null }).duree ?? '',
  );
  const { data, error } = await client
    .from('groupes')
    .update({
      nom: name,
      formation_id: input.formationId,
      formateur_id: input.teacherId,
      date_debut: input.startsOn,
      date_fin: endDate,
      capacite: input.capacity,
    })
    .eq('id', groupId)
    .eq('centre_id', centreId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Groupe introuvable dans ce centre.');
}
