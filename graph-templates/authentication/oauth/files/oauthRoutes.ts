import express, { NextFunction, Request, Response } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler';
import { authMiddleware } from '../middlewares/authMiddleware';
import { APIError } from '../middlewares/errorMiddleware';
import { ACCESS_TOKEN_TTL_MS, authCookieOptions, authenticationRateLimit, requireTrustedOrigin } from '../utils/tokens';
import { beginLink, beginLogin, completeLogin, OAUTH_STATE_COOKIE, oauthStateCookieOptions } from '../services/oauthService';

const router = express.Router();
const { maxAge: _stateLifetime, ...clearStateCookie } = oauthStateCookieOptions;
/** The exact options the state cookie is cleared with (same attributes it was set with, minus its lifetime). */
export const oauthStateClearOptions = clearStateCookie;
const noStore = (res: Response): void => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
};
const redirectToProvider = (res: Response, started: { url: string; cookie: string }, status: 302 | 303): void => {
  noStore(res);
  res.cookie(OAUTH_STATE_COOKIE, started.cookie, oauthStateCookieOptions);
  res.redirect(status, started.url);
};

router.get('/oauth/:provider/start', authenticationRateLimit, (req: Request, res: Response, next: NextFunction) => {
  let started: { url: string; cookie: string };
  try {
    started = beginLogin(req.params.provider, req.query.returnTo);
  } catch {
    next(new APIError('OAuth sign-in failed', 400));
    return;
  }
  redirectToProvider(res, started, 302);
});

// Linking a provider to an existing account requires a signed-in user and a trusted-origin POST (submit a form).
router.post('/oauth/:provider/link', requireTrustedOrigin, authenticationRateLimit, authMiddleware,
  (req: Request, res: Response, next: NextFunction) => {
    let started: { url: string; cookie: string };
    try {
      if (!req.user) throw new Error('Authentication required');
      started = beginLink(req.params.provider, req.user.id, req.query.returnTo);
    } catch {
      next(new APIError('OAuth sign-in failed', 400));
      return;
    }
    redirectToProvider(res, started, 303);
  });

router.get('/oauth/:provider/callback', authenticationRateLimit, asyncHandler(async (req: Request, res: Response) => {
  const stateCookie = req.cookies?.[OAUTH_STATE_COOKIE];
  // Single use: the transaction cookie is cleared whether or not this callback succeeds.
  res.clearCookie(OAUTH_STATE_COOKIE, oauthStateClearOptions);
  noStore(res);
  let result: Awaited<ReturnType<typeof completeLogin>>;
  try {
    result = await completeLogin(
      req.params.provider,
      { code: req.query.code, state: req.query.state, error: req.query.error },
      stateCookie,
    );
  } catch {
    throw new APIError('OAuth sign-in failed', 401);
  }
  if (result.kind === 'login') {
    res.cookie('access_token', result.accessToken, { ...authCookieOptions, maxAge: ACCESS_TOKEN_TTL_MS });
    res.cookie('refresh_token', result.refreshToken, {
      ...authCookieOptions,
      maxAge: Math.max(0, result.refreshTokenExpiresAt.getTime() - Date.now()),
    });
  }
  return res.redirect(303, result.returnTo);
}));

export const oauthRoutes = router;
