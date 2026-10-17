import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { assignStudentToGroup, getStudentCourseEnrollmentIds, setStudentCourseEnrollment } from './studentAssignmentRepository';

type Result = { data: unknown; error: null | Error };

function createClient(options: {
  single?: Record<string, unknown>;
  lists?: Record<string, unknown[]>;
} = {}) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const from = vi.fn((table: string) => {
    const query: Record<string, (...args: unknown[]) => unknown> = {};
    for (const method of ['select', 'eq', 'update', 'insert', 'delete']) {
      query[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return query;
      };
    }
    query.maybeSingle = vi.fn(async () => ({
      data: options.single?.[table] ?? null,
      error: null,
    }));
    query.then = (resolve: (value: Result) => unknown) =>
      Promise.resolve({ data: options.lists?.[table] ?? [], error: null }).then(resolve);
    return query;
  });
  return { client: { from } as unknown as SupabaseClient, calls, from };
}

describe('student assignment repository', () => {
  it('assigns a student to an active group within the same centre', async () => {
    const { client, calls } = createClient({
      single: {
        etudiants: { id: 12, groupe_id: null },
        groupes: { id: 4, capacite: 20, formation_id: 2 },
      },
      lists: { etudiants: [{ id: 12 }, { id: 13 }] },
    });
    await expect(assignStudentToGroup(client, 'centre-a', 12, 4)).resolves.toBeUndefined();
    expect(calls).toContainEqual({ table: 'groupes', method: 'eq', args: ['centre_id', 'centre-a'] });
    expect(calls).toContainEqual({ table: 'etudiants', method: 'update', args: [{ groupe_id: 4 }] });
    expect(calls).toContainEqual({ table: 'etudiants', method: 'eq', args: ['centre_id', 'centre-a'] });
  });

  it('refuses assignment when the group is full', async () => {
    const { client, calls } = createClient({
      single: {
        etudiants: { id: 12, groupe_id: null },
        groupes: { id: 4, capacite: 2, formation_id: 2 },
      },
      lists: { etudiants: [{ id: 12 }, { id: 13 }, { id: 14 }] },
    });
    await expect(assignStudentToGroup(client, 'centre-a', 12, 4)).rejects.toThrow(
      'capacité maximale',
    );
    expect(calls.some((call) => call.method === 'update')).toBe(false);
  });

  it('requires group assignment before enrolling in a group course', async () => {
    const { client, calls } = createClient({
      single: {
        etudiants: { id: 12, groupe_id: 5 },
        cours: { id: 8, groupe_id: 4 },
      },
    });
    await expect(setStudentCourseEnrollment(client, 'centre-a', 12, 8, true)).rejects.toThrow(
      'Affectez d’abord l’étudiant au groupe',
    );
    expect(calls.some((call) => call.table === 'inscriptions' && call.method === 'insert')).toBe(false);
  });

  it('adds a course enrollment with centre scope when the student belongs to its group', async () => {
    const { client, calls } = createClient({
      single: {
        etudiants: { id: 12, groupe_id: 4 },
        cours: { id: 8, groupe_id: 4 },
      },
    });
    await expect(setStudentCourseEnrollment(client, 'centre-a', 12, 8, true)).resolves.toBeUndefined();
    expect(calls).toContainEqual({
      table: 'inscriptions',
      method: 'insert',
      args: [{ centre_id: 'centre-a', cours_id: 8, etudiant_id: 12 }],
    });
  });

  it('loads persisted course enrollment IDs grouped by student', async () => {
    const { client } = createClient({ lists: { inscriptions: [
      { etudiant_id: 12, cours_id: 8 },
      { etudiant_id: 12, cours_id: 9 },
      { etudiant_id: 13, cours_id: 8 },
    ] } });
    await expect(getStudentCourseEnrollmentIds(client, 'centre-a')).resolves.toEqual({
      '12': [8, 9],
      '13': [8],
    });
  });

  it('does not duplicate an existing course enrollment', async () => {
    const { client, calls } = createClient({
      single: {
        etudiants: { id: 12, groupe_id: 4 },
        cours: { id: 8, groupe_id: 4 },
        inscriptions: { etudiant_id: 12 },
      },
    });
    await expect(setStudentCourseEnrollment(client, 'centre-a', 12, 8, true)).resolves.toBeUndefined();
    expect(calls.some((call) => call.table === 'inscriptions' && call.method === 'insert')).toBe(false);
  });

  it('removes a course enrollment using all three identifiers', async () => {
    const { client, calls } = createClient({
      single: {
        etudiants: { id: 12, groupe_id: 4 },
        cours: { id: 8, groupe_id: 4 },
      },
    });
    await expect(setStudentCourseEnrollment(client, 'centre-a', 12, 8, false)).resolves.toBeUndefined();
    expect(calls).toContainEqual({ table: 'inscriptions', method: 'delete', args: [] });
    expect(calls).toContainEqual({ table: 'inscriptions', method: 'eq', args: ['centre_id', 'centre-a'] });
    expect(calls).toContainEqual({ table: 'inscriptions', method: 'eq', args: ['cours_id', 8] });
    expect(calls).toContainEqual({ table: 'inscriptions', method: 'eq', args: ['etudiant_id', 12] });
  });
});
