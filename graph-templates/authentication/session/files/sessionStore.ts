/**
 * Server-side session storage contract. Keys are HMAC digests of the cookie
 * value, never the raw session id, so a leaked store cannot be replayed as
 * cookies. Implement this interface to plug in Redis or another shared store.
 */
export interface SessionRecord {
  userId: string;
  /** Role observed when the session was issued; a change forces id regeneration. */
  role: string;
  /** Per-session synchronizer token for CSRF protection. */
  csrfToken: string;
  /** Epoch milliseconds. */
  createdAt: number;
  lastSeenAt: number;
  /** Absolute expiry, fixed at login and never extended by activity. */
  absoluteExpiresAt: number;
}

export interface SessionStore {
  /** True only for shared, durable stores that are safe to run in production. */
  readonly productionReady: boolean;
  get(key: string): Promise<SessionRecord | null>;
  /** `transaction` is the caller's open database transaction, for stores that can join it. */
  set(key: string, record: SessionRecord, transaction?: unknown): Promise<void>;
  /** Atomically removes the record; resolves true only if this call removed it. */
  destroy(key: string, transaction?: unknown): Promise<boolean>;
  touch(key: string, lastSeenAt: number): Promise<void>;
  /** Server-side revocation of every session that belongs to one account. */
  destroyAllForUser(userId: string): Promise<void>;
  /** Removes up to `limit` idle-expired or absolute-expired records; resolves the number removed. */
  prune(now: number, limit: number): Promise<number>;
}

const MAX_MEMORY_SESSIONS = 50_000;

/**
 * Process-local development store. Sessions vanish on restart and are not
 * shared between instances, so it is refused when NODE_ENV=production.
 */
export class MemorySessionStore implements SessionStore {
  readonly productionReady = false;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly idleTimeoutMs: number) {}

  private expired(record: SessionRecord, now: number): boolean {
    return record.absoluteExpiresAt <= now || now - record.lastSeenAt >= this.idleTimeoutMs;
  }

  async get(key: string): Promise<SessionRecord | null> {
    const record = this.sessions.get(key);
    if (!record) return null;
    if (record.absoluteExpiresAt <= Date.now()) {
      this.sessions.delete(key);
      return null;
    }
    return { ...record };
  }

  async set(key: string, record: SessionRecord): Promise<void> {
    if (!this.sessions.has(key) && this.sessions.size >= MAX_MEMORY_SESSIONS) {
      // Evict idle-expired and absolute-expired sessions before reporting full.
      await this.prune(Date.now(), Number.POSITIVE_INFINITY);
      if (this.sessions.size >= MAX_MEMORY_SESSIONS)
        throw new Error('Memory session store is full');
    }
    this.sessions.set(key, { ...record });
  }

  async destroy(key: string): Promise<boolean> {
    return this.sessions.delete(key);
  }

  async prune(now: number, limit: number): Promise<number> {
    let removed = 0;
    for (const [key, record] of this.sessions) {
      if (removed >= limit) break;
      if (this.expired(record, now)) {
        this.sessions.delete(key);
        removed++;
      }
    }
    return removed;
  }

  async touch(key: string, lastSeenAt: number): Promise<void> {
    const record = this.sessions.get(key);
    if (record) record.lastSeenAt = lastSeenAt;
  }

  async destroyAllForUser(userId: string): Promise<void> {
    for (const [key, record] of this.sessions)
      if (record.userId === userId) this.sessions.delete(key);
  }
}

export type SessionStoreKind = 'memory' | 'postgres' | 'custom';

export function parseSessionStoreKind(value: string | undefined): SessionStoreKind {
  const kind = value ?? 'memory';
  if (kind !== 'memory' && kind !== 'postgres' && kind !== 'custom')
    throw new Error('SESSION_STORE must be one of memory, postgres or custom');
  return kind;
}

/** The configured store kind, readable without loading the session module (used by password reset). */
export function configuredSessionStoreKind(): SessionStoreKind {
  return parseSessionStoreKind(process.env.SESSION_STORE);
}

/**
 * Creates the development memory store, refusing production and warning loudly
 * otherwise. Production deployments configure SESSION_STORE=postgres or supply
 * their own shared store with configureSessionStore().
 */
export function createMemorySessionStore(
  nodeEnv: string | undefined,
  idleTimeoutMs: number,
  warn: (message: string) => void = console.warn,
): MemorySessionStore {
  if (nodeEnv === 'production')
    throw new Error(
      'Refusing to start: SESSION_STORE=memory is not allowed when NODE_ENV=production. Configure SESSION_STORE=postgres or a shared production session store.',
    );
  warn(
    '[sessions] WARNING: using the in-memory session store. Sessions are lost on restart and are not shared between processes. Development only; configure SESSION_STORE=postgres for production.',
  );
  return new MemorySessionStore(idleTimeoutMs);
}
