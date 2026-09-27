import { describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';

// A recording client: nothing connects to a database, but every statement goes through Drizzle's
// real node-postgres query path, so the exact SQL text and bound values can be inspected.
const recorded = vi.hoisted(() => [] as { text: string; values: unknown[] }[]);
const client = {
  query: vi.fn(async (query: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
    recorded.push(typeof query === 'string' ? { text: query, values: values ?? [] } : { text: query.text, values: query.values ?? values ?? [] });
    return { rows: [], rowCount: 0, fields: [], command: 'SELECT' };
  }),
};
vi.mock('../src/config/database', () => ({ database: {} }));

import { roleRepository } from '../src/repository/Roles';

const db = drizzle({ client: client as never });
const hostile = "editor'); DROP TABLE roles; --";
const userId = '11111111-1111-4111-8111-111111111111';

describe('authorization.roles repository', () => {
  it('binds every caller value as a parameter and never splices it into SQL text', async () => {
    await roleRepository.lockRoleAdministration(db);
    await roleRepository.findRoleByName(db, hostile);
    await roleRepository.insertRole(db, hostile, false);
    await roleRepository.renameRole(db, userId, hostile);
    await roleRepository.roleNamesForUser(db, hostile);
    await roleRepository.insertAssignment(db, hostile, userId);
    await roleRepository.deleteAssignment(db, hostile, userId);
    await roleRepository.userHasPermission(db, userId, hostile);
    await roleRepository.insertPermission(db, userId, hostile);
    await roleRepository.countActiveAssignments(db, userId, hostile);
    await roleRepository.insertAuditEntry(db, { actorId: userId, action: 'role.create', target: hostile, detail: null, outcome: 'succeeded', status: null });
    expect(recorded.length).toBe(11);
    for (const statement of recorded) {
      expect(statement.text).not.toContain('DROP TABLE');
      expect(statement.text).not.toContain('graph-roles:administration');
      expect(statement.values.length).toBeGreaterThan(0);
    }
    expect(recorded[0].values).toContain('graph-roles:administration');
    expect(recorded.slice(1).every((statement) => statement.values.includes(hostile))).toBe(true);
  });

  it('refuses to rename or delete built-in rows in SQL, not only in the service', async () => {
    recorded.length = 0;
    await roleRepository.renameRole(db, userId, 'editor');
    await roleRepository.deleteRole(db, userId);
    for (const statement of recorded) expect(statement.text).toMatch(/"built_in" = \$\d+/);
  });

  it('appends audit rows and reads them newest first with a bounded limit, filters and a cursor', async () => {
    recorded.length = 0;
    await roleRepository.listAuditEntries(db, { limit: 10_000 });
    await roleRepository.listAuditEntries(db, { limit: 0 });
    expect(recorded[0].text).toMatch(/from "role_audit_log" order by (?:"role_audit_log"\.)?"occurred_at" desc, (?:"role_audit_log"\.)?"id" desc limit \$1$/);
    expect(recorded.map((statement) => statement.values)).toEqual([[200], [1]]);
    recorded.length = 0;
    await roleRepository.listAuditEntries(db, { limit: 5, before: userId, outcome: 'denied', action: hostile });
    expect(recorded[0].text).not.toContain('DROP TABLE');
    expect(recorded[0].text).toMatch(/< \(select "occurred_at" from "role_audit_log" where "role_audit_log"\."id" = \$\d+\)/);
    expect(recorded[0].values).toEqual(expect.arrayContaining(['denied', hostile, userId, 5]));
    expect(Object.keys(roleRepository).filter((name) => /audit/i.test(name)).sort()).toEqual(['insertAuditEntry', 'listAuditEntries']);
  });

  it('counts only active, verified administrators', async () => {
    recorded.length = 0;
    await roleRepository.countActiveAssignments(db, userId);
    expect(recorded[0].text).toMatch(/inner join "users"/);
    expect(recorded[0].text).toMatch(/"users"\."status" = \$\d+/);
    expect(recorded[0].text).toMatch(/"users"\."email_verified_at" is not null/);
    expect(recorded[0].values).toContain('active');
  });
});
