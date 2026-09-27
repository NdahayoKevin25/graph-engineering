# authentication.oauth

The engine provides an audited deterministic OAuth renderer. It emits reviewed
source and tests only: it does not register applications with providers, write
client ids or secrets, create users on its own, or authorize a deployment.
Existing custom code requires explicit reconciliation.

**What.** Sign-in with Google, GitHub, or one generic OpenID Connect provider
through the OAuth 2.0 authorization-code flow with PKCE (S256).
`GET /api/auth/oauth/:provider/start` sends the browser to the provider;
`GET /api/auth/oauth/:provider/callback` exchanges the code server-side,
verifies the email address, signs in the linked account or creates a new one,
and issues the same `access_token`/`refresh_token` cookies
`authentication.jwt` defines before redirecting to an allowlisted relative
path. `POST /api/auth/oauth/:provider/link` lets a signed-in user attach a
provider to their existing account.

**Design decisions.**

- One generic OAuth2/OIDC provider shape with ready presets for Google (OIDC,
  `openid email profile`) and GitHub (`read:user user:email`). The `oidc`
  provider takes a static HTTPS issuer, authorization endpoint, token
  endpoint and `jwksUri` as template inputs (no runtime discovery), so the
  configuration is reviewable and the rendering deterministic.
- ID token signatures are verified with `node:crypto` against the provider's
  published keys (Google: `https://www.googleapis.com/oauth2/v3/certs`;
  generic OIDC: the `jwksUri` input), with no new dependency. GitHub is OAuth2
  without ID tokens and is unchanged.
- An OAuth login may create a new account, but only for a provider-verified
  email address that no account uses yet.
- A first-time provider login is never attached to an existing account by
  default. If the verified email already belongs to an account (a password
  account or another provider), the login fails with the generic error: a
  weaker provider's "verified" email, such as a re-registered domain on
  GitHub or a self-service OIDC identity provider, must not take over that
  account. The owner signs in the usual way first and then links the
  provider: submit a form that POSTs to `/api/auth/oauth/<provider>/link`
  (trusted `Origin`, valid session). The account id is sealed into the state
  cookie, and the callback links only when the provider-verified email equals
  the account's email and the provider subject is not linked elsewhere. The
  link callback cannot rely on `req.user`, because the SameSite=Strict session
  cookies are not sent on the provider's cross-site redirect back, so it trusts
  the sealed, 10-minute state cookie and re-checks that the account is still
  active. It does not issue new tokens.
- Opt-in risk: `linkVerifiedEmailToExistingAccount` lists providers whose
  first-time login may attach to an existing account with the same verified
  email (only if that account's own email is verified). Enable it only for a
  provider whose email verification you trust with the whole account.
- It extends `authentication.jwt` rather than replacing it: after a successful
  callback it issues the same access/refresh token pair, persisting the
  refresh token hash in `refresh_tokens` under the same per-account lock.

**Requires.** `authentication.jwt` already applied (normally through
`authentication.password`), which provides `src/utils/tokens.ts`,
`refreshTokenTable` and `src/services/authIdentity.ts`. It also requires an
application-owned `src/services/oauthAccountDirectory.ts`:

```ts
export async function findAccountByEmail(email: string): Promise<{ id: string; emailVerified: boolean } | null>;
export async function createAccountForVerifiedEmail(email: string): Promise<{ id: string }>;
```

`createAccountForVerifiedEmail` receives only provider-verified addresses and
must store the account as email-verified so `resolveAuthenticationIdentity`
accepts it. The renderer refuses to run without these files.

**Configure via.** Inputs `providers` (default `["google", "github"]`),
`postLoginRedirects` (exact relative paths, default `["/"]`),
`linkVerifiedEmailToExistingAccount` (default `[]`) and `oidc` (`issuer`,
`authorizationEndpoint`, `tokenEndpoint` and `jwksUri`, all HTTPS) when the
generic provider is enabled. Environment variables, all required with no
defaults: `OAUTH_REDIRECT_BASE_URL`, plus `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`,
`GITHUB_OAUTH_CLIENT_ID`/`_SECRET` or `OIDC_CLIENT_ID`/`_SECRET` for each
enabled provider. Register exactly
`<OAUTH_REDIRECT_BASE_URL>/api/auth/oauth/<provider>/callback` with each
provider.

**Produces.** `src/config/oauthProviders.ts`, `src/services/oauthService.ts`,
`src/routes/oauthRoutes.ts` (mounted at `/api/auth`), an `oauth_accounts`
table (`provider` + `provider_subject` unique, one link per user and provider)
appended to `schema.ts`, the environment bindings in `helpers.ts`, and
`tests/authenticationOauth.test.ts`.

**Test.** `npm test -- authenticationOauth` checks the RFC 7636 S256 vector,
state/nonce binding and rejection, the redirect allowlist, the server-side
token request, the streamed 64 KiB response limit, ID token signature
verification (valid RS256 and ES256, tampered payload or signature, `alg:
none`, HS256 keyed with the public key, missing or unknown `kid`, bad key
material including RSA exponents 1 and 3, a genuine signature under a
mislabeled `alg`, the unknown-`kid` refetch limit, a fetch in flight across a
cache reset, the cache lifetime, and an oversized or non-HTTPS key set), ID token claim checks,
GitHub primary-and-verified email selection, ASCII-only emails, the refusal to
attach a first-time login to an existing account, the authenticated link flow,
token issuance, and the routes through Express with `supertest` (state cookie
set and cleared with exact attributes on success and failure, auth cookies,
303 redirect target, generic rejection). The OIDC claim test runs only when
Google or `oidc` is enabled, and so do the seven ID token signature tests, so
the test count depends on the selected providers (26 with all three).

**Security.**

- No implicit flow. `state`, PKCE verifier and OIDC `nonce` are 32 random
  bytes sealed with an HMAC into a `__Host-graph_oauth` cookie that is
  httpOnly, Secure, SameSite=Lax and valid for 10 minutes. The callback clears
  it, then rejects a missing, forged, expired or mismatched state (constant-time
  comparison) before any provider request.
- Redirect URIs are fixed per provider from configuration; requests never
  choose one. A `returnTo` value is used only if it exactly equals an
  allowlisted relative path, so there is no open redirect.
- The token exchange runs server-side over HTTPS with the client secret only in
  the POST body. Secrets are never logged, put in a URL, or returned to the
  browser. Provider requests use global `fetch` with a 10-second timeout, no
  redirect following and a 64 KiB response limit enforced while the body
  streams (reading stops and the stream is cancelled once it is passed, even
  without a `content-length`), and every failure returns
  the same generic `OAuth sign-in failed`.
- Google and generic OIDC: the ID token's signature is verified before any of
  its claims are read. Keys come only from the provider's fixed HTTPS
  `jwks_uri` (the token's `jku`, `jwk` and `x5c` headers are ignored), fetched
  through the same bounded request as other provider calls, and are built with
  `crypto.createPublicKey({ key: jwk, format: "jwk" })` from the JWK's public
  members only. Only RS256 (RSA keys of at least 2048 bits with public
  exponent 65537; Node accepts `e = 1`, under which signatures are trivially
  forged) and ES256 (P-256) are accepted. The key, not the header, selects the
  verification algorithm; as defence in depth the header's `alg` must also
  match it and any `alg` the JWK declares; `alg: none`, HMAC algorithms, a missing or unknown `kid`, a
  `crit` header, unusable key material and a signature mismatch all fail with
  the generic error. Keys are cached in memory for the response's
  `Cache-Control` `max-age`, clamped to between 5 minutes and 1 hour (5
  minutes when absent). An unknown `kid` refetches a still-fresh key set at
  most once a minute, and concurrent refetches share one request, so a flood
  of unknown `kid`s cannot hammer the provider; a failed fetch fails the
  sign-in rather than using expired keys. `resetOAuthKeyCache()` drops the
  cache, for example after a provider reports a key compromise; a key set
  fetched before the reset is discarded when it arrives. Then the
  issuer, audience, `azp`, expiry, issued-at and nonce are checked and
  `email_verified` must be `true`. GitHub: the email
  must be both primary and verified according to `/user/emails`. Addresses must
  be printable ASCII, checked before lower-casing, so Unicode look-alikes and
  case mappings onto ASCII (such as the Kelvin sign) are rejected rather than
  normalized into another person's address.
- No automatic cross-provider takeover: see the linking design decision above.
- Identity comes only from the provider. Accounts are keyed by provider and
  provider subject id, never by anything the client sends.

**Not covered.** OIDC discovery (the endpoints and `jwksUri` are static
inputs), signing algorithms other than RS256 and ES256, a key cache shared
between processes, generic OAuth2 providers without OIDC ID tokens, provider
token storage or API access on the user's behalf, account unlinking, and
signing in with an unverified email.
