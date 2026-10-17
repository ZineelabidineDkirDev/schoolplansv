import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  createCentreRoom, deleteCentreRoom, updateCentreRoom,
  createCentreTeacher, deleteCentreTeacher, updateCentreTeacher,
} from './directoryCrudRepository';

function clientFor(options: { singles?: Record<string, unknown>; lists?: Record<string, unknown[]> } = {}) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const from = vi.fn((table: string) => {
    const query: Record<string, (...args: unknown[]) => unknown> = {};
    for (const method of ['select', 'insert', 'update', 'delete', 'eq']) {
      query[method] = (...args: unknown[]) => { calls.push({ table, method, args }); return query; };
    }
    query.single = vi.fn(async () => ({ data: options.singles?.[table] ?? { id: 7 }, error: null }));
    query.maybeSingle = vi.fn(async () => ({ data: options.singles?.[table] ?? { id: 7 }, error: null }));
    query.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: options.lists?.[table] ?? [], error: null }).then(resolve);
    return query;
  });
  return { client: { from } as unknown as SupabaseClient, calls, from };
}

describe('directory CRUD repository', () => {
  it('creates and updates rooms scoped to the centre', async () => {
    const { client, calls } = clientFor({ singles: { salles: { id: 7 } } });
    await expect(createCentreRoom(client, 'c1', { name: ' Salle A ', type: 'Informatique', capacity: 20 })).resolves.toBe(7);
    await expect(updateCentreRoom(client, 'c1', 7, { name: 'Salle B', type: '', capacity: null })).resolves.toBeUndefined();
    expect(calls).toContainEqual({ table: 'salles', method: 'eq', args: ['centre_id', 'c1'] });
    expect(calls).toContainEqual({ table: 'salles', method: 'insert', args: [{ centre_id: 'c1', nom: 'Salle A', type: 'Informatique', capacite: 20 }] });
  });

  it('refuses to delete a room assigned to a course', async () => {
    const { client, calls } = clientFor({ lists: { cours: [{ id: 1 }] } });
    await expect(deleteCentreRoom(client, 'c1', 7)).rejects.toThrow('utilisée par un ou plusieurs cours');
    expect(calls.some((call) => call.table === 'salles' && call.method === 'delete')).toBe(false);
  });

  it('validates room capacity before any write', async () => {
    const { client, from } = clientFor();
    await expect(createCentreRoom(client, 'c1', { name: 'A', type: '', capacity: 0 })).rejects.toThrow('nombre entier positif');
    expect(from).not.toHaveBeenCalled();
  });

  it('creates and updates teacher identity fields without changing profile linkage', async () => {
    const { client, calls } = clientFor({ singles: { formateurs: { id: 9 } } });
    await expect(createCentreTeacher(client, 'c1', { name: ' Fatima ', email: ' fatima@example.test ' })).resolves.toBe(9);
    await expect(updateCentreTeacher(client, 'c1', 9, { name: 'Fatima B.', email: '' })).resolves.toBeUndefined();
    expect(calls).toContainEqual({ table: 'formateurs', method: 'insert', args: [{ centre_id: 'c1', nom: 'Fatima', email: 'fatima@example.test' }] });
    expect(calls).toContainEqual({ table: 'formateurs', method: 'update', args: [{ nom: 'Fatima B.', email: null }] });
  });

  it('protects a teacher linked to a login profile', async () => {
    const { client, calls } = clientFor({ singles: { formateurs: { id: 9, profile_id: 'profile-1' } } });
    await expect(deleteCentreTeacher(client, 'c1', 9)).rejects.toThrow('compte de connexion');
    expect(calls.some((call) => call.table === 'formateurs' && call.method === 'delete')).toBe(false);
  });

  it('protects a teacher assigned to courses', async () => {
    const { client, calls } = clientFor({ singles: { formateurs: { id: 9, profile_id: null } }, lists: { cours: [{ id: 1 }] } });
    await expect(deleteCentreTeacher(client, 'c1', 9)).rejects.toThrow('des cours lui sont attribués');
    expect(calls.some((call) => call.table === 'formateurs' && call.method === 'delete')).toBe(false);
  });

  it('validates teacher email before writing', async () => {
    const { client, from } = clientFor();
    await expect(createCentreTeacher(client, 'c1', { name: 'Fatima', email: 'bad' })).rejects.toThrow('adresse e-mail');
    expect(from).not.toHaveBeenCalled();
  });
});
