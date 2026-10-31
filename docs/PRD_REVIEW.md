# PRD review

Reviewed: 2026-10-31. Source: [Paper Trading Simulator — PRD](reference/Paper%20Trading%20Simulator%20-%20PRD.pdf), 14 pages, dated October 31, 2026.

Source SHA-256: `05b01d75c965b4fd79767075bd526615623440131862e0f380873e978a6879a4`.

**Owner update:** The review recommendations have been accepted, with zero charges and multi-user signup/password login added for v1. This document retains the original review context. [DECISIONS.md](DECISIONS.md) and [MULTI_USER_ADDENDUM.md](MULTI_USER_ADDENDUM.md) supersede its single-user, shared-password, and default broker-charge assumptions. The source PDF is unchanged.

## Feasibility

**Doable, with the accepted requirement corrections.** The proposed stack also supports the revised multi-user scope, with explicit ownership and authorization throughout. Separate API and engine processes, transactional trade updates, pure trading rules, and PostgreSQL are a good foundation. Redis is unnecessary at the initial scale.

The app can support simulated entries/exits, a journal, risk previews, Telegram notifications, and statistics. The PRD's absolute promises about live execution and exact recovery cannot be met with delayed, unofficial quotes and one-minute candles. These promises should become explicit simulation assumptions with visible data-quality indicators.

This is a document and architecture review. No provider connectivity, current provider pricing/terms, VPS capacity, or application behavior has been validated. Provider statements in the PRD, including free access and automated login, require a focused check against current official documentation before integration.

Page references below refer to the printed PDF pages. The owner has approved these recommendations subject to the updates above; no implementation has started.

## Corrections needed before implementing the engine

### 1. Define latency against the data actually received

**PRD:** Success criteria, market data, and non-functional requirements, pp. 1, 5–6, 12–13.

Polling every 15–30 seconds does not remove an upstream delay of minutes. A delayed quote may reveal a crossing much later than it happened. Polling LTP alone also misses a target or stop crossed and reversed between polls.

**Suggested fix:** Define live-mode latency as no more than five seconds after receipt of an actionable crossing tick, under healthy operating conditions. Define Yahoo-mode processing within one configured polling interval after the relevant quote or candle becomes available, explicitly excluding upstream delay. Reconcile newly available completed one-minute candles during normal polling as well as after outages. Intraminute crossings may remain unknown until candle publication.

The dashboard should show provider, delayed/live mode, exchange timestamp, receipt time, and data quality. Keep provider connectivity separate from quote age: successful polling can return an old price. A fixed 60-second freshness test would incorrectly reject a consistently delayed provider or classify it incorrectly if receipt time is mistaken for market time.

### 2. Downtime recovery is deterministic reconstruction, not exact execution

**PRD:** Recovery and success criteria, pp. 1, 5.

One-minute OHLC cannot identify the precise crossing second, the order of high/low, or whether a stop occurred before a pending limit entry. Data may be missing or outside the provider's intraday retention window. Recovery must also preserve cash constraints across several trades, rather than replaying each trade independently against today's balance.

**Suggested fix:** Replay available data chronologically across the account. Persist a processed-data watermark and use idempotent events. Record market/event time separately from processing time, provider, and whether the fill is inferred. Use stop-first only when both exits were reachable after the trade was open. For a limit entry and possible exit in the same candle, adopt a documented conservative ordering; never award a target reached only before entry could have occurred.

If history is unavailable or incomplete, record the unresolved interval, pause affected automated decisions, and request manual reconciliation in the app. Do not silently resume as though no crossing happened. For recovery over target/stop edits, replay the rules that were effective at the historical event time using versioned events; applying today's stop retroactively would fabricate outcomes.

### 3. Separate cash, reservations, and equity

**PRD:** FR-1–3 and derived values, pp. 2, 9–11.

The detailed cash formula reserves pending limit amounts, but equity is then calculated using that reduced cash plus open positions. Merely placing a pending order would make equity fall. Pending market orders reserve nothing, so several queued orders can oversubscribe the account. Row-locking an individual trade does not prevent two different entries from spending the same cash.

**Suggested fix:** Define these separately, with fees counted once:

```text
cash_balance = starting_capital
             + sum(closed trade net P&L)
             - sum(open trade entry notional)
             - sum(open trade incurred entry charges)

reserved_cash = sum(pending order commitments, including fee/buffer policy)
available_cash = cash_balance - reserved_cash
equity = cash_balance + sum(open quantity × latest usable mark)
```

Reservations reduce buying power, not equity. Lock the account row before affordability checks and all cash-affecting operations, including fills, cancellations, exits, resets, and relevant settings updates. Use one lock order, account then trade. A repeated submission should use an idempotency key. A reset must atomically clear associated events, reservations, equity history, and old engine work or advance an account generation so pre-reset work cannot reappear.

### 4. Define queued fills, bracket validity, and changing stops

**PRD:** FR-5–8, FR-10–11 and fill rules, pp. 2–4.

`stop < entry < target` may be valid at submission and invalid after an overnight gap or slippage. A queued market order may become unaffordable. It is unclear whether a ₹ amount fixes quantity now or fixes spending at fill time. The original entry validation also conflicts with moving a stop above entry to protect a profit.

**Suggested fix:** Fix whole-share quantity at submission; show estimated cost and reserve fees plus a configurable buffer for queued market orders. At fill, recalculate cost and validate the bracket against the actual proposed fill. Cancel with a specific reason if cash or bracket checks fail; introduce an explicit rejection reason/status consistently in the schema and API. Do not silently resize or change the thesis.

For an already open trade, permit a profitable stop above original entry. Require `stop < target`, valid ticks, and an explicit rule for a level already crossed by the latest usable quote; proposed behavior is immediate engine evaluation after the edit. Reject manual exits without a usable in-session quote and explain why; alternatively, a queued manual exit must be specified as a separate behavior.

Specify slippage for market buys, manual sells, normal stops, and gap stops. Proposed defaults: adverse slippage on market buys and market-like sells; no adverse slippage on target/limit fills beyond their limit. Keep prices on valid tick increments with explicit directional rounding.

### 5. Make the execution model an explicit approximation

**PRD:** Entry/exit rules and corporate actions, pp. 4, 14.

The first received quote after 09:15 may arrive well after the actual open. Filling a stop at its exact level after a jump can understate losses. A price touching a level does not establish executable volume or queue priority. An opening-price improvement on a target needs an explicit simulated order convention.

**Suggested fix:** Use the session's actual opening price when the provider supplies it; otherwise label the first observed price as an approximation. Distinguish observed quote fills and inferred candle fills. Document that v1 assumes full fills with no liquidity/queue model. For a live quote that jumps below the stop, prefer the observed tradable reference price less configured slippage, rather than an unavailable stop price. Owner acceptance of these assumptions is needed before describing results as realistic.

The PRD's >30% overnight-move flag misses smaller splits, bonuses, dividends, and other adjustments, and may flag genuine price moves. Define an instrument-level review pause and audit event. Prefer a verified corporate-action source; without one, expose the heuristic's limitations and support manual adjustment/reconciliation. Use consistently adjusted or unadjusted history and document the choice. Dividend cash credits are not specified and should be explicitly deferred or supported before claiming complete delivery returns.

### 6. Complete the engine/API contract and durable quote path

**PRD:** Architecture, provider interface, API contract, pp. 5, 7–8, 11–12.

The API promises an immediate `OPEN` response in market hours, but only the engine may book entries. The engine holds prices only in memory, while the API must return latest quotes, feed health, and dashboard prices. `LISTEN/NOTIFY` alone is transient and cannot provide an initial snapshot or recover missed browser events. The state diagram caption counts six states, while the SQL enum has five persisted states; “order placed” is an action, not a persisted state.

**Suggested fix:** API writes a durable pending request; the worker fills it promptly. Return `PENDING`/HTTP 202 until processed, or briefly await the durable result with a timeout. Update the documented market-order response semantics accordingly. Keep manual exits in the API only if they use the same shared transaction and locking rules as engine exits, as already allowed in the architecture text.

Persist latest quotes and engine heartbeat in small shared tables, throttled if needed; retain completed bars separately. Define watched-symbol subscriptions with expiration so API restarts or closed browsers do not leave permanent subscriptions. Treat notifications as wake-up signals; read authoritative records and send an initial state snapshot on SSE connection. Resume trade events by event ID or resynchronize after reconnect. Price snapshots may replace lost price events.

Use a dedicated database connection for the engine's session advisory lock; stop processing if that connection/lock is lost. A heartbeat and readiness state should distinguish an API that is up from an engine that is actually operating.

## Additional specification details

| Area / PRD pages                   | Gap                                                                                                                                                 | Suggested resolution                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money and schema, pp. 9–11         | PostgreSQL `numeric` does not prevent floating-point errors in TypeScript. Two decimal places and only `stop < target` are insufficient validation. | Use decimal arithmetic or integer minor units end to end and decimal strings at API boundaries. Specify tick-size rounding, positive prices, valid status-dependent fields, entry/exit fees, original risk, reservation values, fill provenance, rejection reasons, and event effective times.                                                                                                        |
| Fee edits, p. 11                   | Changing current settings could change historical outcomes if fees are recomputed. Buy-side/sell-side rules and rounding are unspecified.           | Snapshot effective fee/slippage settings at fill and store incurred fee components. Document buy/sell applicability, GST base, rounding, and simplified per-trade DP charging. Do not describe the approximation as exact broker billing.                                                                                                                                                             |
| Stats, pp. 3, 12                   | Break-even outcomes, R, zero denominators, drawdown frequency, and date filtering are undefined.                                                    | Win rate = positive net outcomes / all closed trades, showing break-even count. Expectancy = mean net P&L. Profit factor uses positive/negative net P&L. R uses immutable initial price risk × filled quantity, with net P&L as numerator. Return null for undefined ratios. Filter closed statistics by exit time; define holding time as elapsed calendar days.                                     |
| Equity history, pp. 3, 9–10        | Current trades and one-minute bars alone do not specify durable daily marks or tag-specific drawdown.                                               | Store daily IST session-close account equity, start with initial capital, use cash plus marked open holdings, label missing/stale marks, and calculate peak-to-trough drawdown on this daily curve. Label it daily mark-to-market drawdown. For tag splits, explicitly define synthetic tag equity or a labeled closed-trade cumulative P&L drawdown; do not imply account drawdown splits naturally. |
| Calendar and expiry, pp. 3, 5      | Weekdays minus holidays omit special sessions; “5 days” is ambiguous.                                                                               | Use an IST session calendar with per-date open/close overrides, including special sessions. Proposed expiry: end of the fifth eligible session, counting the submission session only if submitted before its open. Record exact `expires_at`. Update and validate the calendar annually.                                                                                                              |
| Notifications, pp. 3, 6, 13        | Sending Telegram after commit can lose alerts on a crash; retries can duplicate them.                                                               | Transactional outbox, bounded retries, deduplication keys, and recovery on restart. Report delivery failure separately from trading success; Telegram should not gate execution. Do not promise exactly-once delivery.                                                                                                                                                                                |
| Security and backup, pp. 8, 13     | Session persistence, expiry, cookie-auth write protection, proxy handling, and backup restore procedure are absent.                                 | Persist or safely sign sessions, define expiry/logout, validate write origins/CSRF, trust only the configured proxy, and persist rate-limit state if it must survive restart. Add a scheduled backup mechanism, retention, and a tested restore procedure. Same-VPS dumps do not protect against total disk loss.                                                                                     |
| Scope and milestones, pp. 2, 13–14 | Angel One is v2 in scope but M5 in the same plan; automatic fallback is listed without defining semantics.                                          | Mark M1–M4 as v1 and M5 as v2 unless live data is required initially. Prefer an explicit degraded state and configured fallback; label provider switches, reconcile gaps, and prevent delayed data being presented as live. Validate current login, historical-data access, and API terms before committing to daily unattended login.                                                                |
| VPS performance, p. 13             | 50 positions and 100 watched symbols on 1 GB is an unverified target; quote polling limits are unknown.                                             | Build images outside the production VPS, bound connections/concurrency and retention, batch requests where supported, and validate memory, provider limits, and processing latency. Recommend 2 GB RAM if available; do not promise capacity before measurement.                                                                                                                                      |

## Proposed acceptance changes

1. Every active trade is evaluated against all usable received data for its session. The UI exposes delay, stale marks, engine readiness, and unresolved history.
2. Live processing meets the five-second budget after tick receipt under healthy conditions. Delayed mode states its upstream delay and candle publication limitations.
3. Restart never loses committed orders or applies a fill/exit twice. Recovery replays available history using documented conservative assumptions; unavailable intervals are flagged rather than fabricated.
4. Pending reservations reduce buying power but preserve equity. Concurrent requests cannot overspend. Reset, cancellation, expiry, and retries remain consistent under engine activity.
5. Statistical definitions are documented, charges and initial risk remain stable after settings/stop edits, and daily equity persists across restarts.

## Suggested implementation sequence when authorized

1. Resolve the owner decisions and run a bounded provider feasibility check: NSE quotes, exchange timestamps, candle availability/retention, instrument mapping, batching, and rate/error behavior. If this fails, choose another data source or revise the data promise before building the engine.
2. M1: monorepo, database schema/migrations, sessions/login, calendar and instruments, Compose and health reporting. Keep the PRD's general folder layout.
3. M2: decimal trading rules, account reservations and locking, worker lifecycle, idempotent commands, polling/candle reconciliation, fills/exits/expiry, and recovery. Recovery belongs here because it affects correctness, rather than first appearing in M4.
4. M3: responsive dashboard, order preview/form, pending/open positions, quote quality, event detail, and reconnecting SSE.
5. M4: journal/CSV, defined stats and equity history, Telegram outbox, backups and restore verification, deployment and capacity checks.
6. M5/v2: Angel One provider after validating current account requirements and supported authentication, followed by provider-switch and recovery checks.

Before release, verify the consequential cases: concurrent buys and reset; duplicate submits; manual-vs-auto exit races; opening gaps and invalid pending brackets; same-candle ambiguity; recovery across edits, days, and competing reservations; missing/late/out-of-order data; changes in fees/settings; lock loss; and database restore. No tests or implementation were added during this review.

## Readiness

The review is complete and the local repository is ready for a later implementation phase. The owner decisions are collected in [DECISIONS.md](DECISIONS.md). No remote access is needed until the owner is ready to share a destination repository.
