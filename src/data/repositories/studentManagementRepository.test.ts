import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  createCentreStudent,
  deleteCentreStudent,
  updateCentreStudent,
  type StudentRecordInput,
} from './studentManagementRepository';

const input: StudentRecordInput = {
  firstName: ' Amina ',
  lastName: ' Benali ',
  email: ' amina@example.test ',
  telephone: '',
  city: ' Rabat ',
  address: '',
  educationLevel: ' Supérieur ',
};

function createClient(results: Record<string, unknown> = {}) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const from = vi.fn((table: string) => {
    const query: Record<string, any> = {};
    for (const method of ['insert', 'update', 'delete', 'select', 'eq']) {
      query[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return query;
      };
    }
    query.single = vi.fn(async () => ({ data: results[table] ?? { id: 17 }, error: null }));
    query.maybeSingle = vi.fn(async () => ({ data: results[table] ?? { id: 17 }, error: null }));
    query.then = (resolve: (value: { data: unknown; error: null }) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve({ data: results[table] ?? [], error: null }).then(resolve, reject);
    return query;
  });
  return { client: { from } as unknown as SupabaseClient, calls, from };
}

describe('student management CRUD repository', () => {
  it('creates a normalized student record scoped to the centre', async () => {
    const { client, calls } = createClient({ etudiants: { id: 17 } });
    await expect(createCentreStudent(client, 'centre-a', input)).resolves.toBe(17);
    expect(calls).toContainEqual({
      table: 'etudiants',
      method: 'insert',
      args: [{
        centre_id: 'centre-a',
        prenom: 'Amina',
        nom: 'Benali',
        email: 'amina@example.test',
        telephone: null,
        ville: 'Rabat',
        adresse: null,
        niveau_etudes: 'Supérieur',
      }],
    });
  });

  it('updates by both student id and centre id', async () => {
    const { client, calls } = createClient({ etudiants: { id: 17 } });
    await expect(updateCentreStudent(client, 'centre-a', 17, input)).resolves.toBeUndefined();
    expect(calls).toContainEqual({ table: 'etudiants', method: 'eq', args: ['centre_id', 'centre-a'] });
    expect(calls).toContainEqual({ table: 'etudiants', method: 'eq', args: ['id', 17] });
  });

  it('does not delete students who still have course enrollments', async () => {
    const { client, from } = createClient({ inscriptions: [{ cours_id: 3 }] });
    await expect(deleteCentreStudent(client, 'centre-a', 17)).rejects.toThrow(
      'retirez d’abord ses inscriptions aux cours',
    );
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('deletes only a student belonging to the active centre when no enrollments remain', async () => {
    const { client, calls } = createClient({ inscriptions: [], etudiants: { id: 17 } });
    await expect(deleteCentreStudent(client, 'centre-a', 17)).resolves.toBeUndefined();
    expect(calls).toContainEqual({ table: 'etudiants', method: 'eq', args: ['centre_id', 'centre-a'] });
    expect(calls).toContainEqual({ table: 'etudiants', method: 'eq', args: ['id', 17] });
  });

  it('rejects invalid input before writing to Supabase', async () => {
    const { client, from } = createClient();
    await expect(createCentreStudent(client, '', input)).rejects.toThrow('Sélectionnez un centre');
    await expect(
      createCentreStudent(client, 'centre-a', { ...input, firstName: ' ' }),
    ).rejects.toThrow('prénom et le nom');
    await expect(
      createCentreStudent(client, 'centre-a', { ...input, email: 'not-an-email' }),
    ).rejects.toThrow('adresse e-mail');
    expect(from).not.toHaveBeenCalled();
  });
});
