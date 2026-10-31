# Multi-user accounts and authentication

Updated: 2026-10-31. This addendum incorporates the owner's request for simple account creation and password login so each individual keeps their investments separately. It supersedes the original PRD's single-user scope, one-row account model, shared app-password hash, and global Telegram recipient. Implementation has not started.

## User experience

Engineering defaults for the requested simple flow:

1. A logged-out visitor sees **Log in** and **Create account**.
2. Create account asks for a unique username, password, and password confirmation. Use a trimmed, case-insensitive username with a canonical unique database value. Email is not required for v1.
3. Successful signup atomically creates the user and their virtual account with ₹1,00,000 starting capital, zero charges, and the agreed simulation defaults. Sign the user in and show their empty dashboard.
4. Login accepts username and password. Failed credentials return a generic message. An authenticated session opens only that user's dashboard.
5. Logout revokes the session and returns to login. Unauthenticated browser visits to private screens return to login; protected API calls return HTTP 401.

No shared portfolio, shared login password, or ability to view another user's trades is included. Each user has one virtual account in v1; multiple portfolios under the same login can be added later. All balances are simulated; no deposit, brokerage connection, or real-money transaction is introduced.

Passwords use a modern password hash such as Argon2id, replacing the single bcrypt hash in `.env`. Set a minimum of 12 characters, allow password-manager paste/autofill, and never log credentials. Use opaque server-side sessions stored in PostgreSQL, secure/httpOnly/SameSite cookies, a seven-day absolute session expiry, logout revocation, and origin/CSRF protection for state-changing requests. Rate-limit signup and login, with login failure limits by normalized username and source IP. Calibrate password hashing and request concurrency for the deployment's memory budget.

To keep signup simple, email verification, social login, and self-service emailed password recovery are deferred. A trusted server operator can perform an audited password reset through a controlled maintenance procedure, which must revoke existing sessions; do not expose an unauthenticated reset endpoint. A deployment setting can disable new registrations without disabling existing logins. No admin web interface is required for v1.

## Ownership and database changes

- Add `users` with canonical unique username, password hash, creation time, and enabled/disabled state; add persistent `sessions` referencing the user.
- Change `account` from one global row to one row per user, enforced by a unique `user_id`. Capital, slippage/fee settings, reservations, reset generation, and account-specific recovery state belong to that account.
- Add non-null `account_id` to trades, daily equity snapshots, private notification preferences, and any stored private commands/results. Trade events and notification jobs inherit their owner from the account/trade through enforced foreign keys; denormalized account references must agree through composite constraints.
- Instruments, session calendars, provider connections, market bars, and latest market quotes can remain shared. Keep their data separate from private holdings, notes, and account settings.
- Derive the account from the authenticated session. Never accept an arbitrary account/user ID from the browser as authorization. Scope all reads, writes, aggregates, exports, and event queries by the authenticated account; use ownership-aware foreign keys and consistent authorization helpers.
- An authenticated user asking for another account's trade, events, or export receives no data. Use HTTP 404 for objects outside the caller's ownership. Random or opaque IDs alone are insufficient isolation.

## Engine, API, and live updates

The three-container design remains suitable. One engine can evaluate many accounts while sharing market-data subscriptions. Deduplicate subscribed symbols across accounts; aggregate subscriptions without exposing who holds a symbol.

Lock the owning account before its trade for each cash-affecting transaction. Do not serialize unrelated users behind one global account lock. Recovery preserves chronological cash decisions within each account. Resetting one account must leave all other accounts untouched, including pending orders, journal events, snapshots, alerts, and engine work. A user's reset must not delete shared market bars required by another account.

Add these authentication routes under `/api`:

| Method | Route            | Behavior                                                                   |
| ------ | ---------------- | -------------------------------------------------------------------------- |
| POST   | `/auth/register` | Create a user and isolated account in one transaction; set session cookie. |
| POST   | `/auth/login`    | Validate username/password and issue a new session.                        |
| POST   | `/auth/logout`   | Revoke the current session and clear its cookie.                           |
| GET    | `/auth/me`       | Return the authenticated user's safe profile and account identity.         |

Registration and login are public and rate-limited; `/health` remains a minimal public health endpoint with no user information. Other private routes require a session. All existing account, trade, journal, stats, equity, and CSV routes implicitly operate on the caller's account. Place user-created notes and review fields behind the same ownership checks.

Authenticate each SSE connection and filter private trade/feed-recovery notifications by account before sending them. Public price updates may be shared, but subscribed symbols, private event payloads, and reconnect history must not leak between users. On logout, session expiry, or revocation, stop delivery on the associated SSE connections, including previously open connections. Resume event IDs only inside the authorized account.

Telegram alerts default to off. If enabled, route them only to a configured and verified recipient for that user. Never broadcast private fills or P&L to the original PRD's shared environment-variable chat ID. Provider-wide outage status can be shared; private trading events cannot.

## Charges and statistics

All charge components default to zero for every new account, so gross and net P&L are equal when fees remain zero. Slippage remains an execution-price assumption, with 0.05% default for market-like fills as previously recommended; it is not a transaction charge.

Cash, reservations, equity, win rate, drawdown, journal filters, tag statistics, and CSV exports must be calculated separately for each account. A user editing capital/settings or resetting their account has no effect on anyone else's results. Preserve fee and risk snapshots on existing trades even if account settings change later.

## Acceptance and planning impact

- Two users can register, log in, and each start with their own ₹1,00,000 and zero charges. Duplicate canonical usernames cannot create a second identity or orphan account.
- A trade, cash reservation, settings change, or reset by user A does not affect user B. User B cannot read or modify user A's objects by changing request IDs, filters, SSE replay positions, or CSV URLs.
- Anonymous requests, revoked/expired sessions, and existing SSE connections after logout cannot access private data.
- Shared symbols trigger independent fills and notifications for each owner without duplicated provider subscriptions.
- Concurrent signup, separate-account entries, and account resets remain consistent across API/engine restarts.

Include registration, login/logout, ownership schema, and isolation checks in M1. Carry ownership through all M2 engine/account operations and M3 screens. M4 statistics, exports, snapshots, and notifications must retain that isolation. Meaningful integration tests should include two-user access attempts and concurrent account operations.

This adds implementation work but does not require a different stack. Treat the original VPS capacity target as aggregate until measured. Before multi-user deployment, validate whether the selected market-data provider's current terms allow the intended access model; the PRD's personal-only assumption must be revisited for multiple logins. No signup service, external messaging, or application code has been created during this update.
