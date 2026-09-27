import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

// Emitted as tests/authenticationSession.test.ts. The runner supplies
// SESSION_SECRET (and the other required variables) through the environment.
const state = vi.hoisted(() => ({
  users: new Map<string, any>(),
  identities: new Map<string, any>(),
  stale: undefined as any,
  lookupId: undefined as string | undefined,
  locks: [] as string[],
  gate: undefined as Promise<void> | undefined,
  arrivals: 0,
}));
vi.mock('../src/repository/Authentication', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/repository/Authentication')>();
  // Real bcrypt hashing and comparison from authentication.password; only the database lookup is replaced.
  class FixtureRepository extends actual.AuthenticationRepository {
    async findUserByEmail(email: string): Promise<any> {
      const found = state.users.get(email.trim().toLowerCase());
      state.lookupId = found?.id;
      return found && state.stale ? state.stale : found;
    }
  }
  return { ...actual, AuthenticationRepository: FixtureRepository };
});
// Login's locked re-read runs in a transaction; this fake records the lock and serves the current row.
vi.mock('../src/config/database', () => ({
  database: {
    transaction: async (callback: (tx: any) => Promise<unknown>) =>
      callback({
        execute: async (query: any) => { state.locks.push(JSON.stringify(query?.queryChunks ?? null)); },
        select: () => ({ from: () => ({ where: () => ({ limit: async () => {
          const row = [...state.users.values()].find((user) => user.id === state.lookupId);
          return row ? [row] : [];
        } }) }) }),
      }),
  },
}));
vi.mock('../src/services/authIdentity', () => ({
  resolveAuthenticationIdentity: async (id: string) => {
    state.arrivals++;
    if (state.gate) await state.gate;
    return state.identities.get(id) ?? null;
  },
}));

import { AuthenticationRepository } from '../src/repository/Authentication';
import { errorHandler } from '../src/middlewares/errorMiddleware';
import { sessionRoutes } from '../src/routes/sessionRoutes';
import { SECRETS } from '../src/utils/helpers';
import * as sessions from '../src/sessions/session';
import { createMemorySessionStore, MemorySessionStore } from '../src/sessions/sessionStore';

const userId = '11111111-1111-4111-8111-111111111111';
const email = 'person@example.test';
const credential = ['fixture', 'pass', 'phrase', 'value'].join('-');
const origin = new URL(SECRETS.CORS_ORIGIN.split(',')[0].trim()).origin;
const NAME = sessions.SESSION_COOKIE_NAME;
const ID = /^[A-Za-z0-9_-]{43}$/;

function application() {
  const server = express();
  server.use(express.json());
  server.use(cookieParser());
  server.use('/api/session', sessionRoutes);
  server.get('/api/private', sessions.requireSession, (req, res) => { res.json({ user: req.user?.id }); });
  for (const method of ['post', 'put', 'patch', 'delete'] as const)
    server[method]('/api/private', sessions.requireSession, sessions.csrfProtection, (_req, res) => { res.json({ changed: true }); });
  server.use(errorHandler);
  return server;
}
const server = application();

function cookieLines(response: request.Response): string[] {
  const header = response.headers['set-cookie'] as unknown;
  return Array.isArray(header) ? header : typeof header === 'string' ? [header] : [];
}
function issued(response: request.Response): { line: string; id: string; cookie: string } | undefined {
  const line = cookieLines(response).find((value) => value.startsWith(`${NAME}=`) && !value.startsWith(`${NAME}=;`));
  if (!line) return undefined;
  const id = line.split(';')[0].slice(NAME.length + 1);
  return { line, id, cookie: `${NAME}=${id}` };
}
async function login(cookie?: string) {
  const call = request(server).post('/api/session/login').set('Origin', origin).send({ email, password: credential });
  const response = await (cookie ? call.set('Cookie', cookie) : call);
  expect(response.status).toBe(200);
  const session = issued(response)!;
  return { ...session, csrf: response.body.data.csrfToken as string, response };
}
const get = (cookie: string) => request(server).get('/api/private').set('Cookie', cookie);

beforeAll(async () => {
  const passwordHash = await new AuthenticationRepository().hashPassword(credential);
  state.users.set(email, { id: userId, email, passwordHash, role: 'customer', status: 'active', emailVerifiedAt: new Date() });
  state.identities.set(userId, { id: userId, email, role: 'customer', status: 'active' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  state.stale = undefined;
  state.gate = undefined;
  state.identities.set(userId, { id: userId, email, role: 'customer', status: 'active' });
});

describe('authentication.session security boundaries', () => {
  it('generates 256-bit CSPRNG session ids and stores only their HMAC', () => {
    const ids = new Set(Array.from({ length: 200 }, () => sessions.generateSessionId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(ID);
      expect(Buffer.from(id, 'base64url')).toHaveLength(32);
      const key = sessions.sessionStoreKey(id);
      expect(key).toMatch(/^[a-f0-9]{64}$/);
      expect(key).not.toContain(id);
    }
  });

  it('sets only the opaque id in an HttpOnly, Secure, SameSite=Lax, Path=/ cookie', async () => {
    const session = await login();
    expect(NAME).toBe('__Host-sid');
    expect(session.id).toMatch(ID);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(session.line).toContain(flag);
    expect(session.line).not.toContain('Domain=');
    expect(session.line).not.toContain(userId);
    expect(session.csrf).not.toBe(session.id);
    expect(JSON.stringify(session.response.body)).not.toContain(session.id);
    expect((await get(session.cookie)).body.user).toBe(userId);
  });

  it('rejects bad credentials generically, verifies with bcrypt for unknown accounts and never logs credentials', async () => {
    const logged: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args); });
    const compare = vi.spyOn(AuthenticationRepository.prototype, 'comparePasswords');
    for (const body of [
      { email, password: credential + '-wrong' },
      { email: 'missing@example.test', password: credential },
      { email, password: '' },
      { email, password: credential, role: 'admin' },
    ]) {
      const response = await request(server).post('/api/session/login').set('Origin', origin).send(body);
      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Invalid credentials');
      expect(issued(response)).toBeUndefined();
    }
    expect(compare).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logged)).not.toContain(credential);
  });

  it('regenerates the session id at login and destroys the presented session', async () => {
    const first = await login();
    const second = await login(first.cookie);
    expect(second.id).not.toBe(first.id);
    expect((await get(first.cookie)).status).toBe(401);
    expect((await get(second.cookie)).status).toBe(200);
  });

  it('rotates the id and CSRF token when the account privilege changes', async () => {
    const before = await login();
    state.identities.set(userId, { id: userId, email, role: 'admin', status: 'active' });
    const response = await get(before.cookie);
    expect(response.status).toBe(200);
    const after = issued(response)!;
    expect(after.id).not.toBe(before.id);
    expect((await get(before.cookie)).status).toBe(401);
    const stale = await request(server).post('/api/private').set('Cookie', after.cookie).set('X-CSRF-Token', before.csrf);
    expect(stale.status).toBe(403);
    const fresh = await request(server).get('/api/session/csrf').set('Cookie', after.cookie);
    expect(fresh.body.data.csrfToken).not.toBe(before.csrf);
    const changed = await request(server).post('/api/private').set('Cookie', after.cookie).set('X-CSRF-Token', fresh.body.data.csrfToken);
    expect(changed.status).toBe(200);
  });

  it('enforces the idle timeout server-side from the last activity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const idle = sessions.SESSION_IDLE_TIMEOUT_MS;
    const start = Date.parse('2030-01-01T00:00:00Z');
    vi.setSystemTime(start);
    const active = await login();
    const unused = await login();
    // Just under the limit: still valid, and this request records activity.
    vi.setSystemTime(start + idle - 1000);
    expect((await get(active.cookie)).status).toBe(200);
    // Past the limit since login but just under it since the last activity: still valid.
    vi.setSystemTime(start + 2 * idle - 2000);
    expect((await get(active.cookie)).status).toBe(200);
    // Idle past the limit since login, with no activity: rejected and cleared.
    const expired = await get(unused.cookie);
    expect(expired.status).toBe(401);
    expect(cookieLines(expired).some((line) => line.startsWith(`${NAME}=;`))).toBe(true);
    // Idle past the limit since the last activity: rejected, and stays rejected.
    vi.setSystemTime(start + 3 * idle - 1000);
    expect((await get(active.cookie)).status).toBe(401);
    vi.setSystemTime(start + 2 * idle - 1000);
    expect((await get(active.cookie)).status).toBe(401);
  });

  it('re-reads the password hash under the per-account lock at login', async () => {
    const replaced = ['earlier', 'fixture', 'pass', 'value'].join('-');
    // The unlocked lookup returns a stale row still carrying an earlier password's hash.
    state.stale = { ...state.users.get(email), passwordHash: await new AuthenticationRepository().hashPassword(replaced) };
    state.locks.length = 0;
    const stale = await request(server).post('/api/session/login').set('Origin', origin).send({ email, password: replaced });
    expect(stale.status).toBe(401);
    expect(issued(stale)).toBeUndefined();
    await login();
    expect(state.locks).toHaveLength(2);
    for (const lock of state.locks) expect(lock).toContain('graph-auth:' + userId);
  });

  it('mints at most one replacement when concurrent requests race a role change', async () => {
    const session = await login();
    state.identities.set(userId, { id: userId, email, role: 'admin', status: 'active' });
    let release!: () => void;
    state.gate = new Promise<void>((resolve) => { release = resolve; });
    state.arrivals = 0;
    const pending = [get(session.cookie).then((value) => value), get(session.cookie).then((value) => value)];
    await vi.waitFor(() => expect(state.arrivals).toBe(2));
    release();
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    const minted = responses.map(issued).filter((value) => value !== undefined);
    expect(minted).toHaveLength(1);
    expect((await get(minted[0]!.cookie)).status).toBe(200);
  });

  it('does not resurrect a session revoked while its role-change rotation was in flight', async () => {
    const session = await login();
    state.identities.set(userId, { id: userId, email, role: 'admin', status: 'active' });
    let release!: () => void;
    state.gate = new Promise<void>((resolve) => { release = resolve; });
    state.arrivals = 0;
    const pending = get(session.cookie).then((value) => value);
    await vi.waitFor(() => expect(state.arrivals).toBe(1));
    await sessions.revokeUserSessions(userId);
    release();
    const response = await pending;
    expect(response.status).toBe(401);
    expect(issued(response)).toBeUndefined();
  });

  it('enforces the absolute timeout even for a continuously active session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2031-01-01T00:00:00Z');
    vi.setSystemTime(start);
    const session = await login();
    const step = Math.floor(sessions.SESSION_IDLE_TIMEOUT_MS / 2);
    let now = start;
    while (now + step < start + sessions.SESSION_ABSOLUTE_TIMEOUT_MS) {
      now += step;
      vi.setSystemTime(now);
      expect((await get(session.cookie)).status).toBe(200);
    }
    vi.setSystemTime(start + sessions.SESSION_ABSOLUTE_TIMEOUT_MS);
    expect((await get(session.cookie)).status).toBe(401);
  });

  it('revokes one session or every session of an account server-side', async () => {
    const a = await login();
    const b = await login();
    expect((await request(server).post('/api/session/logout').set('Cookie', a.cookie)).status).toBe(403);
    const logout = await request(server).post('/api/session/logout').set('Cookie', a.cookie).set('X-CSRF-Token', a.csrf);
    expect(logout.status).toBe(200);
    expect(cookieLines(logout).some((line) => line.startsWith(`${NAME}=;`))).toBe(true);
    expect((await get(a.cookie)).status).toBe(401);
    expect((await get(b.cookie)).status).toBe(200);
    const c = await login();
    await sessions.revokeSession(sessions.sessionStoreKey(c.id));
    expect((await get(c.cookie)).status).toBe(401);
    const d = await login();
    const all = await request(server).post('/api/session/logout-all').set('Cookie', b.cookie).set('X-CSRF-Token', b.csrf);
    expect(all.status).toBe(200);
    for (const session of [b, d]) expect((await get(session.cookie)).status).toBe(401);
  });

  it('requires the session synchronizer token for every state-changing method', async () => {
    const session = await login();
    const other = await login();
    const wrong = session.csrf.slice(0, -1) + (session.csrf.endsWith('A') ? 'B' : 'A');
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      expect((await request(server)[method]('/api/private').set('Cookie', session.cookie)).status).toBe(403);
      for (const token of [wrong, other.csrf, 'short'])
        expect((await request(server)[method]('/api/private').set('Cookie', session.cookie).set('X-CSRF-Token', token)).status).toBe(403);
      expect((await request(server)[method]('/api/private').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)).status).toBe(200);
    }
    expect((await get(session.cookie)).status).toBe(200);
    expect(sessions.csrfTokenMatches(session.csrf, session.csrf)).toBe(true);
    expect(sessions.csrfTokenMatches(session.csrf, session.csrf + 'x')).toBe(false);
    for (const headers of [{}, { Origin: 'https://attacker.example' }]) {
      const response = await request(server).post('/api/session/login').set(headers).send({ email, password: credential });
      expect(response.status).toBe(403);
    }
  });

  it('refuses the memory store in production and unsafe or missing configuration', async () => {
    const secret = process.env.SESSION_SECRET!;
    expect(() => createMemorySessionStore('production', 60_000)).toThrow('NODE_ENV=production');
    const warn = vi.fn();
    expect(createMemorySessionStore('development', 60_000, warn)).toBeInstanceOf(MemorySessionStore);
    expect(warn.mock.calls[0][0]).toContain('WARNING');
    for (const env of [
      {},
      { SESSION_SECRET: 'too-short' },
      { SESSION_SECRET: 'a'.repeat(64) },
      { SESSION_SECRET: secret, NODE_ENV: 'production', SESSION_COOKIE_SECURE: 'false' },
      { SESSION_SECRET: secret, SESSION_COOKIE_SECURE: 'no' },
      { SESSION_SECRET: secret, SESSION_IDLE_TIMEOUT_SECONDS: '59' },
      { SESSION_SECRET: secret, SESSION_ABSOLUTE_TIMEOUT_SECONDS: '2592001' },
      { SESSION_SECRET: secret, SESSION_IDLE_TIMEOUT_SECONDS: '7200', SESSION_ABSOLUTE_TIMEOUT_SECONDS: '3600' },
      { SESSION_SECRET: secret, SESSION_IDLE_TIMEOUT_SECONDS: '1e3' },
      { SESSION_SECRET: secret, SESSION_STORE: 'redis' },
      { SESSION_SECRET: secret, ACCESS_TOKEN_SECRET: secret },
      { SESSION_SECRET: secret, REFRESH_TOKEN_SECRET: secret },
    ])
      expect(() => sessions.loadSessionConfiguration(env)).toThrow();
    const local = sessions.loadSessionConfiguration({ SESSION_SECRET: secret, SESSION_COOKIE_SECURE: 'false' });
    expect(local).toMatchObject({ secureCookie: false, cookieName: 'sid', store: 'memory' });
    expect(sessions.loadSessionConfiguration({ SESSION_SECRET: secret })).toMatchObject({
      secureCookie: true,
      idleTimeoutMs: sessions.DEFAULT_IDLE_TIMEOUT_SECONDS * 1000,
      absoluteTimeoutMs: sessions.DEFAULT_ABSOLUTE_TIMEOUT_SECONDS * 1000,
    });
    const store = new MemorySessionStore(60_000);
    const now = Date.now();
    const record = { userId, role: 'customer', csrfToken: 'token', createdAt: now, lastSeenAt: now, absoluteExpiresAt: now + 3_600_000 };
    await store.set('one', record);
    await store.set('two', record);
    await store.touch('one', record.lastSeenAt + 5);
    expect((await store.get('one'))?.lastSeenAt).toBe(record.lastSeenAt + 5);
    await store.destroyAllForUser(userId);
    expect(await store.get('one')).toBeNull();
    expect(await store.get('two')).toBeNull();
    await store.set('idle', { ...record, lastSeenAt: now - 61_000 });
    await store.set('lapsed', { ...record, absoluteExpiresAt: now - 1 });
    await store.set('live', record);
    expect(await store.prune(now, 10)).toBe(2);
    expect(await store.get('live')).not.toBeNull();
    expect(await store.destroy('live')).toBe(true);
    expect(await store.destroy('live')).toBe(false);
  });

  it('evicts the oldest login-limiter windows instead of refusing new addresses when full', () => {
    const next = vi.fn();
    for (let index = 0; index <= 10_000; index++)
      sessions.sessionRateLimit({ ip: `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`, socket: {} } as any, {} as any, next);
    expect(next).toHaveBeenCalledTimes(10_001);
    expect(next.mock.calls.every((call) => call.length === 0)).toBe(true);
  });
});
