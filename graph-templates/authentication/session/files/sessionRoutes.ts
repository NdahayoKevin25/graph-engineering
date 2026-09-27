import express, { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { database } from '../config/database';
import { userTable } from '../config/schema';
import { AuthenticationRepository } from '../repository/Authentication';
import { asyncHandler } from '../middlewares/asyncHandler';
import { APIError } from '../middlewares/errorMiddleware';
import {
  clearSessionCookie,
  csrfProtection,
  destroySession,
  requireSession,
  requireTrustedOrigin,
  revokeUserSessions,
  sessionRateLimit,
  startSession,
} from '../sessions/session';

const router = express.Router();
const repository = new AuthenticationRepository();
// One generic message for every credential failure: no account enumeration.
const INVALID_CREDENTIALS = 'Invalid credentials';
const loginBody = z
  .object({ email: z.string().trim().email().max(320), password: z.string().min(1).max(1024) })
  .strict();

let dummyHash: Promise<string> | undefined;
// Unknown accounts still pay for one real bcrypt comparison from the password node's repository.
const dummyCredential = (): Promise<string> =>
  (dummyHash ??= repository.hashPassword(randomBytes(32).toString('hex')));

// Credentials are never logged: this module has no logging, and the reviewed
// error handler records only the response status.
router.post('/login', requireTrustedOrigin, sessionRateLimit, asyncHandler(async (req: Request, res: Response) => {
  const parsed = loginBody.safeParse(req.body);
  if (!parsed.success) throw new APIError(INVALID_CREDENTIALS, 401);
  const fallback = await dummyCredential();
  const user = await repository.findUserByEmail(parsed.data.email);
  if (!user) {
    await repository.comparePasswords(parsed.data.password, fallback);
    throw new APIError(INVALID_CREDENTIALS, 401);
  }
  const result = await database.transaction(async (tx) => {
    // The same per-account lock as JWT login, refresh and password reset: a reset
    // either commits first (and this re-read sees the new hash) or waits for this
    // login, whose session it then revokes.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'graph-auth:' + user.id}, 0))`);
    const [current] = await tx.select().from(userTable).where(eq(userTable.id, user.id)).limit(1);
    const valid = await repository.comparePasswords(parsed.data.password, current?.passwordHash ?? fallback);
    if (!current || !valid || current.status !== 'active' || !current.emailVerifiedAt) throw new APIError(INVALID_CREDENTIALS, 401);
    const identity = { id: current.id, email: current.email, role: current.role };
    const session = await startSession(req, res, identity, tx);
    return { identity, csrfToken: session.csrfToken };
  }, { isolationLevel: 'read committed' });
  return res.status(200).json({
    message: 'Login successful',
    data: { user: result.identity, csrfToken: result.csrfToken },
  });
}));

router.get('/me', requireSession, (req: Request, res: Response) => {
  res.status(200).json({ message: 'Session active', data: { user: req.user } });
});

router.get('/csrf', requireSession, (req: Request, res: Response) => {
  res.status(200).json({ message: 'CSRF token', data: { csrfToken: req.authSession!.csrfToken } });
});

router.post('/logout', requireSession, csrfProtection, asyncHandler(async (req: Request, res: Response) => {
  await destroySession(req, res);
  return res.status(200).json({ message: 'Logged out', data: null });
}));

router.post('/logout-all', requireSession, csrfProtection, asyncHandler(async (req: Request, res: Response) => {
  await revokeUserSessions(req.authSession!.userId);
  clearSessionCookie(res);
  return res.status(200).json({ message: 'All sessions revoked', data: null });
}));

export const sessionRoutes = router;
