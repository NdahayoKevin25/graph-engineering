import { and, eq, gt, inArray, lte, or } from 'drizzle-orm';
import { database } from '../config/database';
import { sessionTable } from '../config/schema';
import type { SessionRecord, SessionStore } from './sessionStore';

type Executor = typeof database;

/**
 * Durable, shared session store on the application's existing Drizzle
 * PostgreSQL connection. Rows are keyed by the HMAC of the session id; the raw
 * cookie value is never persisted. Apply the generated schema migration first.
 */
export class PostgresSessionStore implements SessionStore {
  readonly productionReady = true;

  constructor(private readonly idleTimeoutMs: number) {}

  async get(key: string): Promise<SessionRecord | null> {
    const [row] = await database
      .select()
      .from(sessionTable)
      .where(and(eq(sessionTable.id, key), gt(sessionTable.expiresAt, new Date())))
      .limit(1);
    if (!row) return null;
    return {
      userId: row.userId,
      role: row.role,
      csrfToken: row.csrfToken,
      createdAt: row.createdAt.getTime(),
      lastSeenAt: row.lastSeenAt.getTime(),
      absoluteExpiresAt: row.expiresAt.getTime(),
    };
  }

  /** Joins the caller's transaction when given one (login inserts under the account lock). */
  async set(key: string, record: SessionRecord, transaction?: unknown): Promise<void> {
    const executor = (transaction ?? database) as Executor;
    await executor.insert(sessionTable).values({
      id: key,
      userId: record.userId,
      role: record.role,
      csrfToken: record.csrfToken,
      createdAt: new Date(record.createdAt),
      lastSeenAt: new Date(record.lastSeenAt),
      expiresAt: new Date(record.absoluteExpiresAt),
    });
  }

  /** DELETE ... RETURNING: true only for the one caller whose statement removed the row. */
  async destroy(key: string, transaction?: unknown): Promise<boolean> {
    const executor = (transaction ?? database) as Executor;
    const removed = await executor
      .delete(sessionTable)
      .where(eq(sessionTable.id, key))
      .returning({ id: sessionTable.id });
    return removed.length > 0;
  }

  async touch(key: string, lastSeenAt: number): Promise<void> {
    await database
      .update(sessionTable)
      .set({ lastSeenAt: new Date(lastSeenAt) })
      .where(eq(sessionTable.id, key));
  }

  async destroyAllForUser(userId: string): Promise<void> {
    await database.delete(sessionTable).where(eq(sessionTable.userId, userId));
  }

  /** Deletes at most `limit` idle-expired or absolute-expired rows in one bounded statement. */
  async prune(now: number, limit: number): Promise<number> {
    const batch = Math.max(1, Math.min(Math.floor(limit), 10_000));
    const expired = database
      .select({ id: sessionTable.id })
      .from(sessionTable)
      .where(
        or(
          lte(sessionTable.expiresAt, new Date(now)),
          lte(sessionTable.lastSeenAt, new Date(now - this.idleTimeoutMs)),
        ),
      )
      .limit(batch);
    const removed = await database
      .delete(sessionTable)
      .where(inArray(sessionTable.id, expired))
      .returning({ id: sessionTable.id });
    return removed.length;
  }
}
