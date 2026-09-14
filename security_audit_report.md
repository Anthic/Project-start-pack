# 🔐 Backend Security & Architecture Audit Report
### Starter-Pack · Node.js / TypeScript / Prisma / PostgreSQL / Express
> Audit role: **Senior Staff Software Engineer & Security Architect**
> Standard applied: Auth0 / Google / Stripe engineering bar
> Date: 2026-09-14

---

## 1. Executive Summary

The starter-pack backend is a functional, early-stage Express/Prisma/TypeScript monolith. The core happy paths (register → OTP verify → login → logout) work, but the codebase has **multiple Critical and High security vulnerabilities** that would be exploitable in a production environment. Tokens (both access and refresh) are stored in plain text in the database, which is a fundamental design flaw that renders the entire revocation model insecure. Secrets are hardcoded directly in `.env` and committed with real API keys. The `resetPassword` flow has no OTP/token verification gate — any authenticated user can reset any email's password. The payment module is entirely commented out, so PCI/webhook security cannot be assessed in a live state. Architectural gaps (no rate limiting, no input validation on most endpoints, no correlation IDs, no structured logging beyond winston) make this code unsuitable for production without significant rework.

---

## 2. Critical Bugs (with file:line references)

### BUG-1 — `resetPassword` has NO OTP verification gate
**File:** [`auth.service.ts:301-324`](file:///d:/starter-pack/src/app/modules/Auth/auth.service.ts#L301-L324)
**Route:** [`auth.routes.ts:12`](file:///d:/starter-pack/src/app/modules/Auth/auth.routes.ts#L12)

```ts
// auth.routes.ts:12
router.patch("/reset-password", auth(), AuthController.resetPassword);
```

`/reset-password` requires only a valid JWT (`auth()` with no role restriction). Anyone who holds a valid JWT (even a regular user) can call `PATCH /api/v1/auth/reset-password` with any email in `req.user.email` and a new password, and it will silently succeed. There is **no check that the user previously requested a password-reset OTP, nor that the OTP was validated**. The OTP fields are cleared afterward (line 320-321), but they are never *checked* here first.

**Failure scenario:** Attacker logs in, gets a valid access token, calls `/reset-password` with a new password → their own account password changes. This is benign for self. However, combined with BUG-4 (IDOR), it becomes dangerous.

---

### BUG-2 — Syntax error in `jwtHelpers.generateToken`
**File:** [`jwtHelpers.ts:12`](file:///d:/starter-pack/src/utils/jwtHelpers.ts#L12)

```ts
expiresIn:  expiresIn ? "30d" : "2h",,  // <-- double comma (syntax error)
```

A trailing double comma on line 12 is a TypeScript syntax error that will prevent compilation. The `expiresIn` argument is also **completely ignored** — regardless of what is passed in `config.jwt.expires_in`, the token always expires in `"30d"` or `"2h"` based only on whether the string is truthy. The configured `EXPIRES_IN=1d` from `.env` is silently discarded.

---

### BUG-3 — Dead code check after `findUniqueOrThrow` in `loginUser`
**File:** [`auth.service.ts:130-138`](file:///d:/starter-pack/src/app/modules/Auth/auth.service.ts#L130-L138)

```ts
const userData = await prisma.user.findUniqueOrThrow({ ... });  // throws if not found
if (!userData) {   // <-- this is UNREACHABLE
  throw new ApiError(404, "User not found");
}
```

`findUniqueOrThrow` throws a `PrismaClientKnownRequestError` (P2025) if no record is found. The `if (!userData)` guard on line 136 can never be true. The real error thrown by Prisma will propagate as an unhandled exception and produce an inconsistent error message, leaking model info via `globalErrorHandler.ts:174`.

---

### BUG-4 — IDOR on `updateUser` — user can update ANY user's profile
**File:** [`user.service.ts:221-248`](file:///d:/starter-pack/src/app/modules/User/user.service.ts#L221-L248)
**Route:** [`user.routes.ts:15`](file:///d:/starter-pack/src/app/modules/User/user.routes.ts#L15)

```ts
// user.routes.ts:15
router.patch("/update-user", auth(), singleUpload, UserController.updateUser);

// user.controller.ts:33
const userId = req.user?.id;   // <-- taken from JWT, looks OK...

// user.service.ts:226
const updateUser = await prisma.user.update({
  where: { id: userId },
  data: { ...payload },       // <-- spreads the ENTIRE req.body
});
```

The `userId` is taken from the JWT (line 33 of controller) which is fine. But the entire `payload` (from `req.body`) is spread directly into the Prisma `data` field on line 229. A user could send `{"role": "ADMIN", "isVerified": true, "stripeCustomerId": "cus_attacker", "status": "ACTIVE"}` in the request body and Prisma will silently write all of those fields. This is a **mass assignment / privilege escalation vulnerability**.

---

### BUG-5 — `allUsers` endpoint is completely unauthenticated
**File:** [`user.routes.ts:23`](file:///d:/starter-pack/src/app/modules/User/user.routes.ts#L23)

```ts
router.get("/", UserController.allUsers);  // no auth middleware!
```

Any unauthenticated actor can retrieve a paginated list of all users (names, emails, phone numbers, roles, status) without any authorization check.

---

### BUG-6 — `logOutUser` uses `req.body.email` (client-supplied), not JWT
**File:** [`auth.controller.ts:101`](file:///d:/starter-pack/src/app/modules/Auth/auth.controller.ts#L101)

```ts
const email = req.body.email;  // attacker-controlled
const result = await AuthServices.logOutUser(email);
```

The route IS protected by `auth()`, but then the service uses the email from `req.body` instead of `req.user.email`. An authenticated user can log out *any other user's account* by supplying a different email in the body.

---

## 3. Security Vulnerabilities

| # | Severity | Vulnerability | Location | Exploit Summary | Fix Direction |
|---|----------|--------------|----------|-----------------|---------------|
| S-1 | 🔴 **CRITICAL** | Real Stripe secret keys committed to `.env` | [`.env:15`](file:///d:/starter-pack/.env#L15) | `sk_test_...` & webhook secret visible in repo. If repo is public or key leaks, full Stripe account access. | Move to a secret manager (AWS Secrets Manager, Doppler, Vault); never commit real keys. Rotate immediately. |
| S-2 | 🔴 **CRITICAL** | JWT secrets hardcoded in `.env` with weak entropy | [`.env:7-10`](file:///d:/starter-pack/.env#L7-L10) | `JWT_SECRET=47b869b98c8f1d3f1e5e6b7193c8c0f6` is a fixed 32-char hex string, publicly visible. Anyone can forge tokens. | Generate 64+ byte random secrets via `openssl rand -hex 64`; store in secret manager; rotate. |
| S-3 | 🔴 **CRITICAL** | `accessToken` & `refreshToken` stored in plain text in DB | [`schema.prisma:46-47`](file:///d:/starter-pack/prisma/schema.prisma#L46-L47) | If DB is breached, attacker gets all active session tokens immediately. Tokens are opaque session-like but stored as plaintext JWTs. | Store only a hash (SHA-256) of tokens in DB; compare hashes. Or eliminate DB storage and use short-TTL JWTs + blocklist. |
| S-4 | 🔴 **CRITICAL** | Mass-assignment in `updateUser` (see BUG-4) | [`user.service.ts:229`](file:///d:/starter-pack/src/app/modules/User/user.service.ts#L229) | User can self-escalate to ADMIN role. | Use an allowlist DTO (e.g., `{ firstName, lastName, phoneNumber, address, dateOfBirth, image }`) before passing to Prisma. |
| S-5 | 🔴 **CRITICAL** | Logout uses client-supplied email (see BUG-6) | [`auth.controller.ts:101`](file:///d:/starter-pack/src/app/modules/Auth/auth.controller.ts#L101) | Forced logout of any user. | Use `req.user.email` derived from verified JWT. |
| S-6 | 🟠 **HIGH** | `resetPassword` has no OTP gate (see BUG-1) | [`auth.routes.ts:12`](file:///d:/starter-pack/src/app/modules/Auth/auth.routes.ts#L12) | Any valid session can change password. | Require explicit OTP verification before accepting a password reset. |
| S-7 | 🟠 **HIGH** | No rate limiting on any endpoint | [`app.ts`](file:///d:/starter-pack/src/app.ts) / all routes | Login, OTP, forgot-password endpoints are unlimited → brute-force / credential stuffing. | Add `express-rate-limit` with per-IP and per-email limiters on auth endpoints. |
| S-8 | 🟠 **HIGH** | OTP is generated using `Math.random()` (not cryptographic) | [`auth.service.ts:158`](file:///d:/starter-pack/src/app/modules/Auth/auth.service.ts#L158), [`auth.service.ts:283`](file:///d:/starter-pack/src/app/modules/Auth/auth.service.ts#L283) | `Math.random()` is not a CSPRNG; OTPs are predictable in some environments. | Use `crypto.randomInt(100000, 999999)` (built-in Node.js) instead. |
| S-9 | 🟠 **HIGH** | OTP compared with `!==` (timing attack) | [`auth.service.ts:24`](file:///d:/starter-pack/src/app/modules/Auth/auth.service.ts#L24) | String equality is not constant-time; timing oracle can enumerate valid OTPs. | Use `crypto.timingSafeEqual(Buffer.from(user.otp), Buffer.from(otp))`. |
| S-10 | 🟠 **HIGH** | `forgetPassword` leaks user existence (enumeration) | [`auth.service.ts:279-281`](file:///d:/starter-pack/src/app/modules/Auth/auth.service.ts#L279-L281) | HTTP 404 returned when email doesn't exist → attacker can enumerate registered emails. | Always return HTTP 200 with a generic message regardless of whether the email exists. |
| S-11 | 🟠 **HIGH** | `verifyUserByOTP` leaks user existence | [`auth.service.ts:20-22`](file:///d:/starter-pack/src/app/modules/Auth/auth.service.ts#L20-L22) | Returns 404 if email not found — enumeration. | Return 400 "Invalid OTP or email" generically. |
| S-12 | 🟠 **HIGH** | Access token stored in DB AND sent in response body (dual-channel) | [`auth.service.ts:68-69`](file:///d:/starter-pack/src/app/modules/Auth/auth.service.ts#L68-L69), [`auth.controller.ts:13`](file:///d:/starter-pack/src/app/modules/Auth/auth.controller.ts#L13) | Token is in cookie (good) AND in JSON body (risky — JS accessible, XSS risk). Pick one channel. | Use httpOnly cookie only; don't return raw token in response body. |
| S-13 | 🟡 **MEDIUM** | `allUsers` endpoint unauthenticated (see BUG-5) | [`user.routes.ts:23`](file:///d:/starter-pack/src/app/modules/User/user.routes.ts#L23) | PII leak (email, phone, DOB, address) without auth. | Add `auth(UserRole.ADMIN)` middleware. |
| S-14 | 🟡 **MEDIUM** | `globalErrorHandler` exposes raw `error` object | [`globalErrorHandler.ts:230`](file:///d:/starter-pack/src/app/middlewares/globalErrorHandler.ts#L230) | `err: error` is sent verbatim in all environments. In production this leaks internal details even without the stack trace. | Remove `err: error` from the response; log it server-side only. |
| S-15 | 🟡 **MEDIUM** | Health endpoint leaks internal info | [`app.ts:70-71`](file:///d:/starter-pack/src/app.ts#L70-L71) | `requestHeaders` and `responseHeaders` exposed — leaks internal IPs, tokens, auth headers from request, server fingerprint. | Remove headers from health check response. |
| S-16 | 🟡 **MEDIUM** | Refresh token is never rotated | [`auth.service.ts:103-122`](file:///d:/starter-pack/src/app/modules/Auth/auth.service.ts#L103-L122) | Refresh token used to get new access token but old refresh token remains valid indefinitely. No reuse detection. | Rotate refresh token on every use; implement reuse detection (detect old refresh = session theft). |
| S-17 | 🟡 **MEDIUM** | `sameSite: "none"` set even in non-production | [`auth.controller.ts:16`](file:///d:/starter-pack/src/app/modules/Auth/auth.controller.ts#L16) | `SameSite=None` requires `Secure`; in dev (HTTP), this is a config mismatch. Also increases CSRF surface for cross-site endpoints. | Use `SameSite: "strict"` or `"lax"` unless cross-origin cookies are strictly required. |
| S-18 | 🟡 **MEDIUM** | Password minimum length is only 6 characters | [`user.service.ts:21`](file:///d:/starter-pack/src/app/modules/User/user.service.ts#L21) | Industry minimum is 8-12 characters. | Enforce minimum 8 characters; add NIST 800-63B compliant policy. |
| S-19 | 🟡 **MEDIUM** | No input validation on login, OTP, forgot-password endpoints | [`auth.routes.ts`](file:///d:/starter-pack/src/app/modules/Auth/auth.routes.ts), [`auth.validation.ts`](file:///d:/starter-pack/src/app/modules/Auth/auth.validation.ts) | No Zod schema on login, forgot-password, or OTP — malformed input goes into services. | Add Zod schemas + `validateRequest` middleware for all auth routes. |
| S-20 | 🟡 **MEDIUM** | `createSocialUser` does not verify the social token | [`user.service.ts:91`](file:///d:/starter-pack/src/app/modules/User/user.service.ts#L91) | Endpoint blindly trusts `req.body.email` — anyone can POST with any email and get tokens for that account. | Verify Google/OAuth `id_token` server-side before trusting email. |
| S-21 | 🟢 **LOW** | `TokenExpiredError` handling is partially commented out | [`globalErrorHandler.ts:129-138`](file:///d:/starter-pack/src/app/middlewares/globalErrorHandler.ts#L129-L138) | JWT expiry errors may fall through to the generic handler and leak information. | Uncomment and test the `TokenExpiredError` block. |
| S-22 | 🟢 **LOW** | Wrong HTTP status codes on success responses | [`auth.controller.ts:68,80,94,113`](file:///d:/starter-pack/src/app/modules/Auth/auth.controller.ts#L68) | Profile fetch, forget-password, reset-password, logout all return `201 Created` instead of `200 OK`. | Use correct status codes (200 for reads/updates, 201 only for resource creation). |

---

## 4. Authentication Deep-Dive Findings

### 4.1 Password Handling ✅ / ⚠️

| Check | Status | Detail |
|-------|--------|--------|
| Algorithm | ✅ bcrypt | [`passwordHelpers.ts:6`](file:///d:/starter-pack/src/utils/passwordHelpers.ts#L6) — correct |
| Salt | ✅ bcrypt internal | Auto-generated per hash |
| Cost factor | ⚠️ Falls back to 12 | `config.password.password_salt` is `undefined` if `PASSWORD_SALT` not set in `.env` — it defaults to 12 which is fine, but the config key is `password_salt` (a rounds integer, not actually a salt string — misleading naming) |
| Min length | ❌ 6 chars | Should be 8+ per NIST |
| Policy | ❌ None | No complexity, no breached-password check (Have I Been Pwned API) |

### 4.2 Session/Token Design ⚠️

- **JWT with HS256** is used — acceptable for monolith, but HS256 relies on secret confidentiality (S-2 above).
- **Token expiry:** The `expiresIn` config is completely ignored due to BUG-2. All tokens use `"30d"` (if `expiresIn` truthy) or `"2h"` — this is a **30-day access token**, which is far too long. Access tokens should be 15m–1h.
- **No `alg: none` confusion protection** beyond using the typed `jwt.sign` with explicit algorithm — this is fine.
- **Tokens stored in DB:** Anti-pattern. Storing raw JWTs in DB ties revocation to DB reads on every request (already doing this in `auth.ts:44`), but storing plain-text tokens means a DB breach = all sessions compromised.

### 4.3 Refresh Token Flow ❌

- Refresh tokens are stored in DB (plain text — S-3).
- On refresh, the old refresh token is **not rotated** (S-16) — the same refresh token remains valid indefinitely after use.
- No reuse detection: if a refresh token is stolen and used by an attacker first, the legitimate user's next use still works (no alarm, no revocation).
- Compare to Auth0: refresh token rotation + reuse detection + absolute lifetime + idle timeout.

### 4.4 MFA/2FA ⚠️

- OTP-based email verification exists for account creation.
- OTP is 6-digit numeric (acceptable range).
- **No MFA for login** — only for registration verification and password reset.
- No TOTP (Google Authenticator), no backup codes, no rate limit on OTP attempts.
- OTP TTL is 5 minutes — acceptable.
- OTP comparison is not timing-safe (S-9).

### 4.5 Brute-Force Protection ❌

- **Zero rate limiting** on login, OTP verify, or forgot-password endpoints.
- No account lockout policy.
- No CAPTCHA trigger.
- A 6-digit OTP with no rate limiting = 1,000,000 possible values, guessable in <17 minutes at 1,000 req/s.

### 4.6 Credential Stuffing / Enumeration ❌

- `forgetPassword` returns 404 if email not found (S-10).
- `verifyUserByOTP` returns 404 if email not found (S-11).
- `loginUser` uses `findUniqueOrThrow` — throws P2025 which is caught and returns "Record not found for the model: User" (BUG-3 + S-14), leaking existence.
- Registration returns "User already exists" on duplicate email — enumeration.
- **All three flows must be fixed** to return generic responses.

### 4.7 OAuth/SSO ❌

- `/create-social-user` accepts arbitrary `email`, `name`, `image`, `provider` from the request body with **zero verification** of the OAuth token (S-20).
- No state parameter, no PKCE — these would live on the frontend, but the backend provides no defense.
- Redirect URI validation: N/A (no OAuth redirect in backend).

### 4.8 Password Reset Flow ❌

- OTP is sent but **never verified before reset** (BUG-1 / S-6).
- Token entropy is Math.random-based (S-8).
- OTP is single-use (cleared after any successful verify or reset) — ✅.
- Expiry is 5 minutes — ✅.
- User enumeration via 404 — ❌ (S-10).

### 4.9 Logout ✅ / ⚠️

- Logout **does** invalidate server-side by nulling `accessToken` and `refreshToken` in DB — this is the correct approach for stateful token revocation.
- Cookie is cleared — ✅.
- **But:** logout uses `req.body.email` instead of `req.user.email` (BUG-6), allowing forced logout of others.

### 4.10 Multi-Device / Session Management ❌

- Only **one** `accessToken` and `refreshToken` stored per user row → second login overwrites the first → single-session only by design.
- No session listing, no per-device revocation.
- Compare to Auth0/Google: maintain a `sessions` table with device fingerprint, last-seen, created-at, per-session revocation.

---

## 5. Authorization Analysis

### Access Control Model

- Ad-hoc role-based: `auth(UserRole.ADMIN, UserRole.USER)` role strings passed to middleware.
- Role is taken from JWT payload (`verifiedUser.role`) — ✅ server-side.
- Role is **not re-verified against DB** on each request — if role changes in DB, old JWT still carries old role until expiry (30 days!).

### IDOR & Object-Level Permissions

- `updateUser` takes `userId` from JWT — ✅ for self-update. But mass-assignment allows privilege escalation (BUG-4).
- `updateStatus/:id` is admin-only — ✅ role check, but no check that `id` is a valid user before updating.
- `allUsers` — no auth at all (BUG-5).
- `logOutUser` — IDOR via body email (BUG-6).
- No systematic IDOR protection at object level beyond auth middleware.

### Privilege Escalation

- **Horizontal:** `updateUser` mass-assignment allows sending `{"role": "ADMIN"}` → instant privilege escalation (BUG-4 / S-4).
- **Vertical:** Same issue — regular user becomes admin.
- Admin endpoints (`/update-status`) — properly role-gated ✅, but the user object is not re-fetched from DB to verify current role.

---

## 6. Error Handling Analysis

### Consistency ⚠️

- Global error handler exists and handles Prisma/Zod/ApiError types — ✅ good structure.
- But: `err: error` is sent in the response in all environments (S-14) — this leaks internal error objects.
- `TypeError` and `ReferenceError` are mapped to `400 Bad Request` — incorrect; these are server bugs that should be 500.
- `TokenExpiredError` handling is partially commented out (S-21).

### Stack Trace Leakage ⚠️

- Stack trace is suppressed in production (`config.env !== "production"`) — ✅.
- But raw `error` object still leaks (S-14).
- Prisma model names leak via P2025 error message: `"Record not found for the model: User"` in all environments.

### Logging ✅ / ⚠️

- Winston logger is imported and used for request logging in `app.ts`.
- No correlation/request ID attached to logs — debugging in production will be very hard.
- No evidence of PII redaction in logs.

### Fail-Safe Behavior ⚠️

- Auth middleware catches errors and calls `next(err)` — fails closed ✅.
- But the `auth()` call with no roles (`router.patch("/reset-password", auth(), ...)`) fails to enforce any specific role — any authenticated user passes.

---

## 7. Payment System Analysis

> **Status: Entire payment module is commented out.**

Both [`payment.service.ts`](file:///d:/starter-pack/src/app/modules/Payment/payment.service.ts) and [`payment.controller.ts`](file:///d:/starter-pack/src/app/modules/Payment/payment.controller.ts) consist exclusively of commented-out code. The Stripe webhook route in `app.ts` is also commented out.

**What can be assessed from the dead code:**

| Check | Status | Detail |
|-------|--------|--------|
| PCI scope | ✅ (design intent) | Code delegates to Stripe Checkout — no raw card data touched |
| Webhook signature verification | ✅ (design intent) | `stripe.webhooks.constructEvent` was used — correct approach |
| Idempotency | ❌ No idempotency keys | Payment creation has no `idempotencyKey` header — double-charge risk on retry |
| Replay protection | ⚠️ Partial | No timestamp/nonce check beyond Stripe's own 5-min window |
| Async processing | ❌ | Webhook handler processes synchronously — if it's slow, Stripe will retry → duplicate processing |
| Currency | ✅ | Amount in cents (integer) — correct |
| Refund auth checks | ❌ Not implemented | No refund/dispute flow |
| Reconciliation | ❌ Not implemented | No ledger or reconciliation job |

**Real keys in `.env`:** Stripe `sk_test_*` and `STRIPE_WEBHOOK_SECRET` are committed in the repo (S-1). **These must be rotated immediately.**

---

## 8. Webhooks Analysis

> **Status: Webhook handler is commented out** (`app.ts:25-29`).

From the dead code analysis:
- `stripe.webhooks.constructEvent()` was the intended signature verification — ✅ correct approach.
- Webhook processing is **synchronous** inside the handler — must be moved to a queue (BullMQ, SQS) for production. If DB is slow, Stripe will retry and cause duplicates.
- Webhook route requires `express.raw()` body parser (was correctly placed before JSON middleware in comments).
- No idempotency tracking for duplicate event IDs.
- No IP allowlisting (Stripe's webhook IP ranges).

---

## 9. General Backend Architecture Gaps vs. Big-Tech Standards

| Gap | Current State | Big-Tech Standard |
|-----|--------------|-------------------|
| **Secrets management** | Real keys in `.env` committed to repo | AWS Secrets Manager / Vault / Doppler with no-secrets-in-code policy |
| **Rate limiting** | None | `express-rate-limit` per-route with Redis store for distributed rate limiting |
| **Input validation** | Only `changePassword` has a Zod schema | Zod schemas on every route, validated by middleware before controller |
| **Correlation IDs** | None | `x-request-id` header propagated through all logs, errors, responses |
| **Structured logging** | Winston basic setup | JSON structured logs with `requestId`, `userId`, `latency`, PII redacted |
| **Token storage** | Plain text JWTs in DB | Hashed token reference or eliminate DB storage entirely |
| **Single session** | One token per user row | Sessions table: per-device, per-session revocation |
| **CORS** | Hardcoded localhost origins | Config-driven from environment, reviewed for each environment |
| **Dependency audit** | Unknown | `npm audit` in CI, Dependabot/Snyk alerts |
| **Health check** | Leaks headers | Returns only `{ status: "ok", uptime }` without internal info |
| **DB connection pooling** | Prisma default | Explicit `connectionLimit` + PgBouncer in production |
| **Env separation** | `.env` file only | `.env.development`, `.env.staging`, `.env.production` with strict promotion gates |
| **N+1 queries** | Not detected — limited routes | Prisma `include` used thoughtfully; add query logging in dev |
| **Layering** | Controller → Service → Prisma | Acceptable; no repository layer but Prisma acts as ORM |
| **Admin isolation** | Role middleware only | Separate admin subdomain/service, IP allowlisting, MFA enforced for admins |

---

## 10. Prioritized Roadmap

| # | Issue | Severity | Effort | Fix First? |
|---|-------|----------|--------|------------|
| R-1 | Rotate all committed secrets (Stripe, JWT) immediately | 🔴 CRITICAL | S | **Immediately** |
| R-2 | Fix `resetPassword` — require OTP verification (BUG-1 / S-6) | 🔴 CRITICAL | S | Sprint 1 |
| R-3 | Fix mass-assignment in `updateUser` — allowlist DTO (BUG-4 / S-4) | 🔴 CRITICAL | S | Sprint 1 |
| R-4 | Fix logout to use `req.user.email` not `req.body.email` (BUG-6 / S-5) | 🔴 CRITICAL | S | Sprint 1 |
| R-5 | Fix `jwtHelpers` syntax error & honor configured `expiresIn` (BUG-2) | 🔴 CRITICAL | S | Sprint 1 |
| R-6 | Stop storing plain-text tokens in DB; store SHA-256 hash (S-3) | 🔴 CRITICAL | M | Sprint 1 |
| R-7 | Add rate limiting on login, OTP, forgot-password (S-7) | 🟠 HIGH | S | Sprint 1 |
| R-8 | Replace `Math.random()` OTP with `crypto.randomInt` (S-8) | 🟠 HIGH | S | Sprint 1 |
| R-9 | Use `crypto.timingSafeEqual` for OTP comparison (S-9) | 🟠 HIGH | S | Sprint 1 |
| R-10 | Fix user-enumeration in `forgetPassword`, `verifyOTP`, login (S-10, S-11) | 🟠 HIGH | S | Sprint 1 |
| R-11 | Authenticate `/users` endpoint (BUG-5 / S-13) | 🟠 HIGH | S | Sprint 1 |
| R-12 | Verify social OAuth token server-side before trusting email (S-20) | 🟠 HIGH | M | Sprint 2 |
| R-13 | Rotate refresh token on each use + reuse detection (S-16) | 🟠 HIGH | M | Sprint 2 |
| R-14 | Remove `err: error` from global error response (S-14) | 🟡 MEDIUM | S | Sprint 2 |
| R-15 | Add correlation/request IDs to all logs | 🟡 MEDIUM | S | Sprint 2 |
| R-16 | Add Zod validation schemas to all auth & user routes (S-19) | 🟡 MEDIUM | M | Sprint 2 |
| R-17 | Remove header leak from `/health` endpoint (S-15) | 🟡 MEDIUM | S | Sprint 2 |
| R-18 | Move from single-token-per-user to sessions table | 🟡 MEDIUM | L | Sprint 3 |
| R-19 | Fix incorrect `201` status codes on non-creation responses (S-22) | 🟢 LOW | S | Sprint 3 |
| R-20 | Add `npm audit` + Dependabot to CI pipeline | 🟢 LOW | S | Sprint 3 |
| R-21 | Re-enable & harden Stripe webhook handler with async queue | 🟡 MEDIUM | L | Sprint 3 |
| R-22 | Add MFA (TOTP) for login, enforced for admin accounts | 🟡 MEDIUM | L | Sprint 4 |
| R-23 | Implement breached-password check (HIBP API) on registration | 🟢 LOW | S | Sprint 4 |

---

## Appendix — Files Reviewed

| File | Lines |
|------|-------|
| [`src/app.ts`](file:///d:/starter-pack/src/app.ts) | 91 |
| [`src/config/index.ts`](file:///d:/starter-pack/src/config/index.ts) | 50 |
| [`src/app/middlewares/auth.ts`](file:///d:/starter-pack/src/app/middlewares/auth.ts) | 58 |
| [`src/app/middlewares/globalErrorHandler.ts`](file:///d:/starter-pack/src/app/middlewares/globalErrorHandler.ts) | 236 |
| [`src/app/middlewares/validateRequest.ts`](file:///d:/starter-pack/src/app/middlewares/validateRequest.ts) | — |
| [`src/app/modules/Auth/auth.service.ts`](file:///d:/starter-pack/src/app/modules/Auth/auth.service.ts) | 378 |
| [`src/app/modules/Auth/auth.controller.ts`](file:///d:/starter-pack/src/app/modules/Auth/auth.controller.ts) | 128 |
| [`src/app/modules/Auth/auth.routes.ts`](file:///d:/starter-pack/src/app/modules/Auth/auth.routes.ts) | 31 |
| [`src/app/modules/Auth/auth.validation.ts`](file:///d:/starter-pack/src/app/modules/Auth/auth.validation.ts) | 10 |
| [`src/app/modules/User/user.service.ts`](file:///d:/starter-pack/src/app/modules/User/user.service.ts) | 354 |
| [`src/app/modules/User/user.controller.ts`](file:///d:/starter-pack/src/app/modules/User/user.controller.ts) | 88 |
| [`src/app/modules/User/user.routes.ts`](file:///d:/starter-pack/src/app/modules/User/user.routes.ts) | 26 |
| [`src/app/modules/Payment/payment.service.ts`](file:///d:/starter-pack/src/app/modules/Payment/payment.service.ts) | 375 (all commented) |
| [`src/app/modules/Payment/payment.controller.ts`](file:///d:/starter-pack/src/app/modules/Payment/payment.controller.ts) | 79 (all commented) |
| [`src/utils/jwtHelpers.ts`](file:///d:/starter-pack/src/utils/jwtHelpers.ts) | 32 |
| [`src/utils/passwordHelpers.ts`](file:///d:/starter-pack/src/utils/passwordHelpers.ts) | 15 |
| [`prisma/schema.prisma`](file:///d:/starter-pack/prisma/schema.prisma) | 65 |
| [`.env`](file:///d:/starter-pack/.env) | 21 |
| [`src/errors/ApiErrors.ts`](file:///d:/starter-pack/src/errors/ApiErrors.ts) | 15 |

---

---

# 🚀 PART II — Advanced Production-Grade Improvements

> Beyond the critical security fixes, the following items represent what separates a **hobby project** from a **battle-hardened, scalable SaaS backend** that can handle real traffic, real attackers, and real on-call incidents.

---

## ADV-1 — 🏛️ Advanced Architecture Patterns

### ADV-1.1 Repository Pattern (Data Access Layer)
**Current:** Services call Prisma directly — business logic and DB queries are tangled.

```
Controller → Service (business logic + DB queries mixed) ← BAD
```

**Target:**
```
Controller → Service (business logic only)
                └→ Repository (DB queries only)
                       └→ Prisma / DB driver
```

**Why:** Swapping Prisma for another ORM, or mocking DB in tests, requires touching every service file. A repository layer isolates the change to one place.

```ts
// src/app/modules/User/user.repository.ts
export class UserRepository {
  async findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  }
  async findById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  }
  async create(data: Prisma.UserCreateInput) {
    return prisma.user.create({ data });
  }
}
```

---

### ADV-1.2 CQRS (Command Query Responsibility Segregation)
Separate read operations (queries) from write operations (commands). For high-traffic apps, read replicas can serve queries while the primary DB handles writes.

```ts
// commands/RegisterUserCommand.ts
// queries/GetUserProfileQuery.ts
```

Enables easy addition of read replicas, event sourcing, and audit logging.

---

### ADV-1.3 Domain-Driven Design (DDD) Boundaries
Group code by **domain capability**, not technical layer:

```
src/
  domains/
    identity/          ← auth, users, sessions, MFA
    billing/           ← payments, subscriptions, invoices
    notifications/     ← email, push, SMS
  shared/
    infrastructure/    ← DB, cache, queue, email clients
    kernel/            ← base classes, value objects
```

---

### ADV-1.4 Event-Driven Architecture with BullMQ
**Current:** Registration = Stripe API call + DB write + Email send — all synchronous in one request. One failure = entire registration fails.

**Target:**
```ts
// Registration handler:
const user = await userRepo.create(data);
await eventBus.emit('user.registered', { userId: user.id });
res.status(201).json({ success: true }); // responds immediately

// Background workers:
eventBus.on('user.registered', sendWelcomeEmail);    // retries on failure
eventBus.on('user.registered', createStripeCustomer); // retries on failure
```

**Stack:** BullMQ + Redis. Each worker has retry logic, dead-letter queue, and monitoring.

---

## ADV-2 — 🔐 Advanced Security Hardening

### ADV-2.1 Helmet.js — HTTP Security Headers
```ts
import helmet from 'helmet';
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"] } },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
```
Protects against: XSS, Clickjacking, MIME sniffing, information leakage.

---

### ADV-2.2 Advanced Rate Limiting Strategy
Not just one global limit — tiered limits per sensitivity:

```ts
// Tier 1: Login (most sensitive)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max: 5,                     // 5 attempts
  keyGenerator: (req) => `login:${req.body.email}:${req.ip}`, // per email+IP
  store: new RedisStore({ client: redis }),
});

// Tier 2: OTP
const otpLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 3 });

// Tier 3: General API
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 100 });

// Tier 4: Public endpoints
const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
```

---

### ADV-2.3 TOTP-Based MFA (Google Authenticator)
```ts
import speakeasy from 'speakeasy';
import qrcode from 'qrcode';

// Setup MFA
const secret = speakeasy.generateSecret({ name: 'YourApp' });
// Store secret.base32 (encrypted) in DB
// Return QR code URL to user

// Verify MFA on login
const isValid = speakeasy.totp.verify({
  secret: user.mfaSecret,
  encoding: 'base32',
  token: req.body.totpCode,
  window: 1, // 30-second window tolerance
});
```

**Also add:** Backup codes (one-time use), MFA recovery flow, enforcement for admin accounts.

---

### ADV-2.4 Audit Log System
Every sensitive action leaves a trace:

```prisma
model AuditLog {
  id          String   @id @default(cuid())
  userId      String?
  action      String   // "USER_LOGIN" | "PASSWORD_RESET" | "ROLE_CHANGE" | "PAYMENT_INITIATED"
  resource    String?  // "User:abc123"
  ipAddress   String?
  userAgent   String?
  metadata    Json?    // before/after state for mutations
  riskScore   Int      @default(0)
  createdAt   DateTime @default(now())

  @@index([userId])
  @@index([action])
  @@index([createdAt])
  @@map("audit_logs")
}
```

**Log these events minimum:** login success/failure, password change, role change, account deletion, payment initiated, admin actions, export of user data.

---

### ADV-2.5 Account Lockout & Intelligent Throttling
```prisma
model LoginAttempt {
  id          String    @id @default(cuid())
  identifier  String    // email or IP
  attempts    Int       @default(0)
  lockedUntil DateTime?
  lastAttempt DateTime  @default(now())

  @@unique([identifier])
  @@map("login_attempts")
}
```

```ts
// Progressive lockout: 5 fails → 15min, 10 fails → 1hr, 20 fails → 24hr
const getLockDuration = (attempts: number) => {
  if (attempts >= 20) return 24 * 60 * 60 * 1000;
  if (attempts >= 10) return 60 * 60 * 1000;
  if (attempts >= 5)  return 15 * 60 * 1000;
  return null;
};
```

---

### ADV-2.6 Content Security Policy (CSP) & CORS Hardening
```ts
// CORS from config, not hardcoded
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') ?? [];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new ApiError(403, 'Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
}));
```

---

### ADV-2.7 Request Signing for Sensitive Operations
For critical operations (large payments, account deletion), require the client to sign the request payload with a user-derived key — prevents replay attacks even if the auth token is stolen.

---

### ADV-2.8 Bot Protection & CAPTCHA Integration
- Integrate **Cloudflare Turnstile** or **hCaptcha** on registration, login, forgot-password.
- Verify CAPTCHA token server-side before proceeding.
- Apply **fingerprinting** (device fingerprint via `fingerprintjs`) to detect credential stuffing bots.

---

## ADV-3 — 📦 Advanced Session Management

### ADV-3.1 Proper Sessions Table (Multi-Device Support)
```prisma
model Session {
  id           String    @id @default(cuid())
  userId       String
  tokenHash    String    @unique  // SHA-256 of refresh token
  deviceName   String?            // "Chrome on Windows"
  deviceType   String?            // "web" | "mobile" | "desktop"
  ipAddress    String?
  userAgent    String?
  lastSeenAt   DateTime  @default(now())
  expiresAt    DateTime
  isRevoked    Boolean   @default(false)
  createdAt    DateTime  @default(now())

  user         User      @relation(fields: [userId], references: [id])

  @@index([userId])
  @@index([tokenHash])
  @@map("sessions")
}
```

**Enables:**
- User can see all active devices
- User can revoke individual sessions ("Sign out of this device")
- Admin can revoke all sessions for a user
- Automatic cleanup of expired sessions

---

### ADV-3.2 Refresh Token Rotation + Reuse Detection
```ts
const rotateRefreshToken = async (oldToken: string, sessionId: string) => {
  const session = await sessionRepo.findByTokenHash(sha256(oldToken));

  if (!session || session.isRevoked) {
    // REUSE DETECTED — old token was used again
    // Revoke ALL sessions for this user immediately
    await sessionRepo.revokeAllForUser(session.userId);
    throw new ApiError(401, 'Security violation detected. All sessions revoked.');
  }

  const newRefreshToken = crypto.randomBytes(64).toString('hex');
  await sessionRepo.rotate(sessionId, sha256(newRefreshToken));
  return newRefreshToken;
};
```

---

## ADV-4 — 🗄️ Database & Infrastructure

### ADV-4.1 Database Migrations Strategy
```
prisma/
  migrations/
    20260914_initial/
    20260915_add_sessions_table/
    20260916_add_audit_logs/
  seeds/
    development.seed.ts
    test.seed.ts
```

- Never run `prisma db push` in production (destroys migration history).
- Always use `prisma migrate deploy` in CI/CD.
- Have rollback SQL scripts for each migration.

---

### ADV-4.2 Read Replica for Analytics/Admin Queries
```ts
// prisma.ts
const prisma = new PrismaClient();
const readReplica = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_READ_URL } },
});

// Use replica for read-heavy admin queries
const users = await readReplica.user.findMany({ ... });
```

---

### ADV-4.3 Redis Architecture
```
Redis usage map:
├── Rate Limiting    → key: "rl:login:{ip}:{email}"   TTL: 15min
├── OTP Storage      → key: "otp:{email}"              TTL: 5min  (replace DB columns!)
├── Session Blocklist→ key: "blocked:{jti}"            TTL: token expiry
├── User Cache       → key: "user:{id}"                TTL: 5min
├── Job Queues       → BullMQ (email, stripe, notifications)
└── Pub/Sub          → Real-time notifications (optional)
```

---

### ADV-4.4 Soft Delete Pattern
```prisma
// Never hard-delete users — soft delete with audit trail
model User {
  // ...
  deletedAt DateTime?  // null = active
  deletedBy String?    // who deleted

  @@index([deletedAt])
}
```

```ts
// All queries filter deleted by default
const users = await prisma.user.findMany({
  where: { deletedAt: null }  // enforce everywhere
});
```

---

### ADV-4.5 Database-Level Encryption (Column Encryption)
Encrypt sensitive fields at the application layer before storing:
- `phoneNumber` — encrypt with AES-256-GCM
- `dateOfBirth` — encrypt
- `address` — encrypt
- Use Prisma middleware or custom encryption helper

```ts
// prisma-middleware/encryption.middleware.ts
prisma.$use(async (params, next) => {
  if (params.model === 'User' && params.action === 'create') {
    params.args.data.phoneNumber = encrypt(params.args.data.phoneNumber);
  }
  return next(params);
});
```

---

## ADV-5 — 📊 Observability & Monitoring

### ADV-5.1 Structured Logging with Correlation IDs
```ts
// middleware/requestId.middleware.ts
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] as string || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});

// Every log includes requestId, userId, method, path, duration
logger.info('Login attempt', {
  requestId: req.requestId,
  userId: req.user?.id,
  email: req.body.email, // NOT password
  ip: req.ip,
  userAgent: req.headers['user-agent'],
  duration: Date.now() - req.startTime,
});
```

---

### ADV-5.2 Prometheus Metrics + Grafana Dashboard
```ts
import promClient from 'prom-client';

const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
});

const loginAttempts = new promClient.Counter({
  name: 'auth_login_attempts_total',
  help: 'Total login attempts',
  labelNames: ['result'], // 'success' | 'failure' | 'locked'
});

// Expose metrics endpoint (internal only, not public)
app.get('/internal/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});
```

**Alert on:** login failure rate spike, P95 response time > 500ms, DB connection pool exhaustion, error rate > 1%.

---

### ADV-5.3 Distributed Tracing (OpenTelemetry)
```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-otlp-http';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: process.env.OTEL_ENDPOINT }),
  instrumentations: [getNodeAutoInstrumentations()],
});
sdk.start();
```

Every request gets a trace that shows: Express middleware time → service time → Prisma query time → external API time. Instantly pinpoints bottlenecks.

---

### ADV-5.4 Deep Health Check Endpoint
```ts
app.get('/health', async (req, res) => {
  const checks = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`.then(() => 'ok').catch(() => 'error'),
    redis.ping().then(() => 'ok').catch(() => 'error'),
  ]);

  const [db, cache] = checks.map(c => c.status === 'fulfilled' ? c.value : 'error');
  const healthy = db === 'ok' && cache === 'ok';

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    checks: { database: db, cache },
    version: process.env.npm_package_version,
    uptime: Math.floor(process.uptime()),
  });
});
```

---

## ADV-6 — 🧪 Testing Strategy

### ADV-6.1 Testing Pyramid
```
              /\
             /E2E\          ← 5%  — Playwright (user flows)
            /------\
           / Integ. \       ← 25% — Supertest (API routes + DB)
          /----------\
         /    Unit    \     ← 70% — Vitest (services, utils, validators)
        /--------------\
```

### ADV-6.2 Test Infrastructure Setup
```ts
// vitest.config.ts
export default defineConfig({
  test: {
    globalSetup: './tests/setup/global.setup.ts',   // start test DB
    setupFiles: './tests/setup/each.setup.ts',       // seed + clean between tests
    coverage: { provider: 'v8', thresholds: { lines: 80 } },
  },
});

// tests/setup/each.setup.ts
beforeEach(async () => {
  await prisma.$transaction([
    prisma.session.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.user.deleteMany(),
  ]);
});
```

### ADV-6.3 Contract Testing (Pact)
If you ever split into microservices, use Pact to verify that the consumer (frontend) and provider (backend) agree on the API contract, without end-to-end tests.

### ADV-6.4 Load Testing (k6)
```js
// tests/load/login.load.test.js
import http from 'k6/http';
export const options = {
  stages: [
    { duration: '30s', target: 100 },   // ramp up
    { duration: '1m',  target: 100 },   // sustain
    { duration: '10s', target: 0 },     // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],   // 95% of requests < 500ms
    http_req_failed: ['rate<0.01'],     // < 1% error rate
  },
};
```

---

## ADV-7 — 🔄 CI/CD Pipeline & DevSecOps

### ADV-7.1 Full CI Pipeline (GitHub Actions)
```yaml
# .github/workflows/ci.yml
jobs:
  security:
    steps:
      - run: npm audit --audit-level=high
      - run: npx snyk test
      - run: npx gitleaks detect   # check for leaked secrets in git history

  quality:
    steps:
      - run: npx eslint . --max-warnings 0
      - run: npx tsc --noEmit       # type check without building
      - run: npx prettier --check .

  test:
    steps:
      - run: npm run test:unit
      - run: npm run test:integration
      - run: npm run test:coverage  # fail if < 80% coverage

  build:
    needs: [security, quality, test]
    steps:
      - run: npm run build
      - run: docker build -t app:${{ github.sha }} .
      - run: docker scout cves app:${{ github.sha }}  # container vulnerability scan
```

---

### ADV-7.2 Pre-commit Hooks (Husky + lint-staged)
```json
// package.json
{
  "lint-staged": {
    "*.ts": ["eslint --fix", "prettier --write"],
    "*.prisma": ["prisma format"]
  },
  "husky": {
    "hooks": {
      "pre-commit": "lint-staged",
      "commit-msg": "commitlint --edit",
      "pre-push": "npm run test:unit"
    }
  }
}
```

---

### ADV-7.3 Semantic Versioning + Changelog
```
feat: add TOTP-based MFA for login        → minor version bump (1.1.0)
fix: fix OTP timing attack vulnerability  → patch version bump (1.0.1)
feat!: breaking change in auth API        → major version bump (2.0.0)
```

Use `semantic-release` to auto-publish changelogs and tag releases from commit messages.

---

### ADV-7.4 Container Security
```dockerfile
# Dockerfile — production hardened
FROM node:20-alpine AS builder
# ... build steps

FROM node:20-alpine AS production
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser                          # ← never run as root
COPY --chown=appuser:appgroup ...
EXPOSE 8000
HEALTHCHECK --interval=30s CMD wget -qO- http://localhost:8000/health || exit 1
CMD ["node", "dist/server.js"]
```

---

## ADV-8 — 📧 Advanced Email & Notifications

### ADV-8.1 Email Queue with Retry (BullMQ)
```ts
// queues/email.queue.ts
const emailQueue = new Queue('email', { connection: redis });

// Producer
await emailQueue.add('send-otp', { to, subject, html }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 100,
  removeOnFail: 500,
});

// Worker
const emailWorker = new Worker('email', async (job) => {
  await emailSender(job.data.subject, job.data.to, job.data.html);
}, { connection: redis });

emailWorker.on('failed', (job, err) => {
  logger.error('Email job failed', { jobId: job.id, error: err.message });
});
```

---

### ADV-8.2 Multi-Channel Notifications
```ts
// notifications/notification.service.ts
interface NotificationChannel {
  send(userId: string, message: string): Promise<void>;
}

class EmailNotificationChannel implements NotificationChannel { ... }
class PushNotificationChannel implements NotificationChannel { ... }  // Firebase FCM
class SMSNotificationChannel implements NotificationChannel { ... }   // Twilio

class NotificationService {
  async notify(userId: string, event: NotificationEvent) {
    const prefs = await this.getUserPreferences(userId);
    const channels = this.getChannels(prefs);
    await Promise.allSettled(channels.map(c => c.send(userId, event.message)));
  }
}
```

---

## ADV-9 — 📁 File Upload & Storage

### ADV-9.1 Cloud Storage (S3/Cloudflare R2)
**Current:** Files stored in local `uploads/` folder — lost on server restart/redeploy.

```ts
// helpars/storage/s3.uploader.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import multerS3 from 'multer-s3';

export const upload = multer({
  storage: multerS3({
    s3: new S3Client({ region: config.aws.region }),
    bucket: config.aws.bucketName,
    key: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `uploads/${req.user.id}/${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new ApiError(400, 'Invalid file type'));
  },
});
```

### ADV-9.2 File Validation (MIME Type, not just Extension)
```ts
import { fileTypeFromBuffer } from 'file-type';

// Don't trust file.mimetype — check actual file bytes
const type = await fileTypeFromBuffer(file.buffer);
if (!['image/jpeg', 'image/png', 'image/webp'].includes(type?.mime ?? '')) {
  throw new ApiError(400, 'Invalid file content');
}
```

### ADV-9.3 Presigned URLs for Private Files
```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';

// Return presigned URL (valid 1 hour) instead of public S3 URL
const url = await getSignedUrl(s3, new GetObjectCommand({
  Bucket: config.aws.bucketName,
  Key: fileKey,
}), { expiresIn: 3600 });
```

---

## ADV-10 — 🌐 API Design & Documentation

### ADV-10.1 API Versioning Strategy
```ts
// Current: /api/v1/...
// When breaking changes arrive: /api/v2/... (v1 still runs for 6 months)

app.use('/api/v1', v1Router);
app.use('/api/v2', v2Router); // new version runs alongside

// Deprecation header on v1 responses
app.use('/api/v1', (req, res, next) => {
  res.setHeader('Deprecation', 'version="v1", date="2027-01-01"');
  res.setHeader('Sunset', 'Sat, 01 Jan 2027 00:00:00 GMT');
  next();
});
```

---

### ADV-10.2 OpenAPI / Swagger Documentation
```ts
// Auto-generate from route definitions
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

/**
 * @swagger
 * /api/v1/auth/login:
 *   post:
 *     summary: Authenticate user
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 *       429:
 *         description: Too many requests
 */
```

---

### ADV-10.3 Consistent Pagination & Response Envelope
```ts
// Standardize ALL paginated responses
interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
    nextCursor?: string;  // cursor-based pagination for large datasets
  };
  links: {
    self: string;
    next: string | null;
    prev: string | null;
  };
}
```

---

## ADV-11 — 🏭 Production Operations

### ADV-11.1 Graceful Shutdown
```ts
// server.ts
const server = app.listen(config.port);

const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  // 1. Stop accepting new connections
  server.close(async () => {
    // 2. Wait for in-flight requests to complete (max 30s)
    await new Promise(resolve => setTimeout(resolve, 30000));

    // 3. Close DB connections
    await prisma.$disconnect();

    // 4. Close Redis connections
    await redis.quit();

    // 5. Close BullMQ workers
    await emailWorker.close();

    logger.info('Graceful shutdown complete');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM')); // Docker stop
process.on('SIGINT', () => shutdown('SIGINT'));   // Ctrl+C
```

---

### ADV-11.2 Environment Configuration Validation (Zod)
```ts
// config/env.validation.ts
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(64, 'JWT_SECRET must be at least 64 characters'),
  REFRESH_TOKEN_SECRET: z.string().min(64),
  REDIS_URL: z.string().url(),
  STRIPE_SECRET_KEY: z.string().startsWith('sk_'),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_'),
  EMAIL: z.string().email(),
  APP_PASS: z.string().min(1),
});

// Validate at startup — fail fast if misconfigured
const env = EnvSchema.safeParse(process.env);
if (!env.success) {
  console.error('❌ Invalid environment variables:', env.error.format());
  process.exit(1);
}
```

---

### ADV-11.3 Feature Flags
Enable/disable features without deploying:

```ts
// features/flags.ts
const flags = {
  mfa_enabled: process.env.FEATURE_MFA === 'true',
  social_login: process.env.FEATURE_SOCIAL_LOGIN === 'true',
  payment_v2: process.env.FEATURE_PAYMENT_V2 === 'true',
};

// Usage
if (flags.mfa_enabled && user.mfaEnabled) {
  // require TOTP
}
```

For production: use **LaunchDarkly** or **Unleash** for percentage rollouts, A/B testing, per-user flags.

---

### ADV-11.4 Secrets Rotation Strategy
```
Secret Lifecycle:
1. Generate new secret → store in AWS Secrets Manager
2. Deploy with BOTH old + new secret accepted (zero-downtime rotation)
3. After all tokens with old secret expire → remove old secret
4. Schedule: JWT_SECRET rotated every 90 days, API keys every 365 days
```

---

### ADV-11.5 Dependency Security Policy
```json
// .snyk (Snyk policy)
{
  "version": "v1.19.0",
  "ignore": {},
  "patch": {},
  "failOn": "high"  // CI fails if any HIGH severity vulnerability found
}
```

Also: Pin exact versions in `package.json` (`"express": "4.18.2"` not `"^4.0.0"`) and use `npm ci` in CI (installs exactly from lockfile).

---

## ADV-12 — 🗓️ Complete Advanced Roadmap Addition

| # | Advanced Item | Category | Priority | Effort |
|---|---------------|----------|----------|--------|
| A-1 | Helmet.js security headers | Security | 🔴 High | S |
| A-2 | Environment config validation (Zod) | Reliability | 🔴 High | S |
| A-3 | Graceful shutdown | Reliability | 🔴 High | S |
| A-4 | Redis for OTP storage (replace DB columns) | Security + Perf | 🔴 High | M |
| A-5 | Tiered rate limiting per endpoint sensitivity | Security | 🔴 High | M |
| A-6 | Sessions table (multi-device, token hashing) | Security | 🔴 High | L |
| A-7 | BullMQ email queue (async, retry) | Reliability | 🟠 High | M |
| A-8 | Audit log table + service | Compliance | 🟠 High | M |
| A-9 | Account lockout with progressive backoff | Security | 🟠 High | M |
| A-10 | Repository pattern + DTO layer | Architecture | 🟠 High | L |
| A-11 | Prometheus metrics + Grafana alerts | Observability | 🟠 High | M |
| A-12 | Structured logging + Correlation IDs | Observability | 🟠 High | S |
| A-13 | S3/R2 file storage (replace local uploads/) | Reliability | 🟠 High | M |
| A-14 | Vitest unit + integration test suite | Quality | 🟠 High | L |
| A-15 | CI pipeline (audit + lint + test + build) | DevSecOps | 🟠 High | M |
| A-16 | Husky + lint-staged + commitlint | DX | 🟡 Medium | S |
| A-17 | TOTP MFA (Google Authenticator) | Security | 🟡 Medium | L |
| A-18 | OpenAPI / Swagger documentation | DX | 🟡 Medium | M |
| A-19 | OpenTelemetry distributed tracing | Observability | 🟡 Medium | M |
| A-20 | Deep health check (DB + Redis) | Reliability | 🟡 Medium | S |
| A-21 | MIME-type file validation | Security | 🟡 Medium | S |
| A-22 | Presigned URLs for private file access | Security | 🟡 Medium | M |
| A-23 | Feature flags system | Operations | 🟡 Medium | M |
| A-24 | API versioning strategy | Architecture | 🟡 Medium | M |
| A-25 | Soft-delete pattern (no hard deletes) | Reliability | 🟡 Medium | M |
| A-26 | Read replica for analytics queries | Performance | 🟢 Low | L |
| A-27 | Column-level encryption (PII fields) | Compliance | 🟢 Low | L |
| A-28 | CQRS pattern for high-traffic paths | Architecture | 🟢 Low | XL |
| A-29 | Load testing with k6 | Quality | 🟢 Low | M |
| A-30 | Secrets rotation policy (90-day cycle) | Security | 🟢 Low | M |
| A-31 | Bot protection / CAPTCHA on auth endpoints | Security | 🟢 Low | M |
| A-32 | Snyk + Dependabot CVE scanning in CI | DevSecOps | 🟢 Low | S |
| A-33 | Semantic versioning + auto-changelog | DX | 🟢 Low | S |
| A-34 | Container hardening (non-root user, healthcheck) | DevSecOps | 🟢 Low | S |
| A-35 | Multi-channel notifications (Push + SMS) | Feature | 🟢 Low | L |

---

> **Total score if all implemented:** Production-grade, enterprise-ready backend at the level of Auth0 / Stripe / GitHub's backend standards.

