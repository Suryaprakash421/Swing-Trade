# Owner decisions

Review date: 2026-10-31. Updated following the owner's approval of the review recommendations, selection of zero charges, and request for signup/login with separate investments per user.

**Status: requirements updated; implementation remains paused as originally requested.**

## Approved decisions

| Decision                 | Approved direction                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data source              | Yahoo for a clearly labeled delayed-data v1; Angel One in v2. Validate provider feasibility before integration.                                                                                                                         |
| Historical recovery      | Conservative replay of available candles, inferred-fill labels, and explicit unresolved-history handling. No promise of exact historical execution.                                                                                     |
| Queued orders            | Fix whole-share quantity at submission; reserve estimated cost plus a configurable price buffer. Cancel with a recorded reason if actual cost exceeds available cash or the fill violates `stop < entry < target`.                      |
| Starting capital         | ₹1,00,000 independently for each new user; configurable per virtual account.                                                                                                                                                            |
| Charges                  | Zero charges by default: brokerage, STT, exchange/SEBI fees, stamp duty, GST, and DP charges all start at zero. No current broker rate table is required. Any future optional fee configuration must preserve historical fee snapshots. |
| Slippage                 | Remains separate from charges: retain the proposed adverse slippage for market-like fills, with the original default of 0.05%. Zero charges does not remove simulated slippage.                                                         |
| Users and authentication | Multi-user v1, replacing the single-user scope. Provide create account, password login, logout, and one isolated virtual investment account per user. See the [multi-user addendum](MULTI_USER_ADDENDUM.md).                            |
| Trading scope            | Long-only NSE cash equity delivery; no real orders; short selling later; M1–M4 are v1 and M5/Angel One is v2.                                                                                                                           |
| Engineering corrections  | Adopt the review's accounting, execution, recovery, concurrency, statistics, calendar, security, and durability corrections, with account ownership added throughout.                                                                   |

The multi-user addendum records engineering defaults for the new signup flow. The owner has not separately chosen a login identifier, password-recovery product, or user-capacity target; use the documented simple defaults without introducing an email-service dependency.

## Needed before deployment, not for local preparation

- VPS operating system, CPU/RAM/disk, and whether Docker Compose is available. Recommend at least 2 GB RAM initially, then measure. The original 50 positions / 100 watched symbols target is aggregate across users until capacity testing supports more.
- Domain/subdomain and existing reverse proxy: Nginx, Caddy, or neither.
- Approximate expected user count and whether account creation should remain open after the intended users register. These affect capacity and operational configuration, not the basic account model.
- Whether Telegram alerts should be enabled. Alerts must use a verified user-specific recipient; a shared environment-variable chat ID must not receive everyone's private activity. Credentials can be configured privately during deployment.
- Backup location, available disk, and whether an off-host backup is desired. The PRD's same-VPS backups do not cover loss of the VPS or its disk.

Repository access and deployment credentials are not needed for the local review. UI references are optional; a responsive functional interface is sufficient to begin once implementation is authorized.
