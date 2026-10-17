import type { SupabaseClient } from '@supabase/supabase-js';

type JsonRecord = Record<string, unknown>;

export class EdgeFunctionError extends Error {
  readonly exists: boolean;

  constructor(message: string, exists = false) {
    super(message);
    this.name = 'EdgeFunctionError';
    this.exists = exists;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function responseIssue(error: Error): Promise<EdgeFunctionError> {
  if (!('context' in error) || !(error.context instanceof Response)) {
    return new EdgeFunctionError(error.message);
  }

  const response = error.context.clone();
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload)) return new EdgeFunctionError(error.message);
  return new EdgeFunctionError(
    typeof payload.error === 'string' ? payload.error : error.message,
    payload.exists === true,
  );
}

async function invoke(
  client: SupabaseClient,
  functionName: string,
  body: JsonRecord,
): Promise<JsonRecord> {
  const { data, error } = await client.functions.invoke<unknown>(functionName, { body });
  if (error) throw await responseIssue(error);
  if (!isRecord(data))
    throw new Error(`La fonction ${functionName} a renvoyé une réponse invalide.`);
  if (typeof data.error === 'string') throw new EdgeFunctionError(data.error, data.exists === true);
  return data;
}

export type AdminUserRequest =
  | {
      action: 'create_user';
      email: string;
      full_name: string;
      role: 'formateur' | 'etudiant';
      centre_id?: string;
      formateur_id?: string;
    }
  | { action: 'reset_password'; email: string }
  | { action: 'delete_user'; email: string };

export type AdminUserResponse = { email: string; password: string } | { ok: true };

export async function invokeAdminUsers(
  client: SupabaseClient,
  request: AdminUserRequest,
): Promise<AdminUserResponse> {
  const result = await invoke(client, 'admin-users', request);
  if (request.action === 'delete_user') {
    if (result.ok !== true) throw new Error('La suppression du compte n’a pas été confirmée.');
    return { ok: true };
  }
  if (typeof result.email !== 'string' || typeof result.password !== 'string') {
    throw new Error('La fonction admin-users n’a pas renvoyé les identifiants attendus.');
  }
  return { email: result.email, password: result.password };
}

type CentreDirectorRequest =
  | { action: 'list'; centre_id: string }
  | { action: 'reset'; centre_id: string; user_id: string; password: string }
  | {
      action: 'create_director';
      centre_id: string;
      director: { full_name: string; email: string; password: string };
    }
  | {
      action: 'create_centre';
      centre: {
        nom: string;
        slug: string;
        actif?: boolean;
        type_abonnement?: string | null;
        statut_abonnement?: string | null;
        date_debut?: string | null;
        date_expiration?: string | null;
        droits?: Record<string, boolean>;
      };
      director: { full_name: string; email: string; password: string };
    };

export type CentreDirector = {
  user_id: string;
  full_name: string | null;
  email: string | null;
};

export type CentreDirectorResponse =
  | { directors: CentreDirector[] }
  | { ok: true; centre_id?: string; director_user_id?: string; message?: string };

export async function invokeCentreDirectorAccess(
  client: SupabaseClient,
  request: CentreDirectorRequest,
): Promise<CentreDirectorResponse> {
  const result = await invoke(client, 'centre-director-access', request);

  if (request.action === 'list') {
    if (!Array.isArray(result.directors)) {
      throw new Error('La fonction centre-director-access a renvoyé une liste invalide.');
    }
    const directors = result.directors.map((director) => {
      if (
        !isRecord(director) ||
        typeof director.user_id !== 'string' ||
        !(typeof director.full_name === 'string' || director.full_name === null) ||
        !(typeof director.email === 'string' || director.email === null)
      ) {
        throw new Error('La fonction centre-director-access a renvoyé un directeur invalide.');
      }
      return {
        user_id: director.user_id,
        full_name: director.full_name,
        email: director.email,
      };
    });
    return { directors };
  }

  if (result.ok !== true) {
    throw new Error('La fonction centre-director-access n’a pas confirmé l’opération.');
  }
  return {
    ok: true,
    ...(typeof result.centre_id === 'string' ? { centre_id: result.centre_id } : {}),
    ...(typeof result.director_user_id === 'string'
      ? { director_user_id: result.director_user_id }
      : {}),
    ...(typeof result.message === 'string' ? { message: result.message } : {}),
  };
}
