# Build contract

Internal integration reference for implementation. Root owns root tooling, integration tests, operations and final verification. Agents own their assigned directories and communicate changes before altering shared interfaces.

## Runtime

Node.js 24 LTS, TypeScript ESM (`type: module`), npm workspaces. Workspace names `@paper/core`, `@paper/db`, `@paper/api`, `@paper/engine`, `@paper/web`. Source exports for server packages run using `tsx`; frontend production output `apps/web/dist`. Use postgres.js (`postgres` package) raw SQL with parameterized tagged templates and SQL migrations; Drizzle schema may be provided for typed tooling. PostgreSQL 16+ production. No SQLite production substitute. Monetary API values are decimal strings, quantity integers. Date strings are ISO UTC; display IST.

## Database contract

DB package exports `sql` (postgres.js client), `migrate()` and `closeDb()`. DATABASE_URL environment. Agents may add columns but must coordinate renames. Schema names:

- users: id uuid, username text unique canonical lowercase, password_hash text, enabled boolean, created_at timestamptz.
- sessions: id text primary key (SHA256 opaque token), user_id uuid, expires_at timestamptz, created_at.
- accounts: id uuid, user_id uuid unique, starting_capital numeric default 100000, slippage_bps integer default 5, limit_validity_days integer default 5, reservation_buffer_bps integer default 200, generation integer default 0, created_at. All charges zero v1.
- instruments: symbol text primary key, name text, yahoo_symbol text, tick_size numeric default .05, active boolean default true.
- trades: id uuid, account_id uuid, symbol text, qty integer, entry_type MARKET/LIMIT, limit_price numeric nullable, target_price numeric, stop_price numeric, status PENDING/OPEN/CLOSED/CANCELLED/EXPIRED, entry_price numeric nullable, entry_at timestamptz nullable, exit_price numeric nullable, exit_at timestamptz nullable, exit_reason TARGET/STOP/MANUAL nullable, reserved_amount numeric default 0, charges numeric default 0, gross_pnl numeric nullable, net_pnl numeric nullable, initial_risk numeric nullable, setup_tag text default '', thesis text default '', review text default '', rejection_reason text nullable, inferred boolean default false, gap_fill boolean default false, expires_at timestamptz nullable, last_checked_at timestamptz nullable, created_at, updated_at, idempotency_key text nullable, generation integer default 0.
- trade_events: id bigserial, trade_id uuid, account_id uuid, type text, price numeric nullable, payload jsonb default {}, effective_at timestamptz, created_at timestamptz.
- latest_quotes: symbol text primary key, ltp numeric, market_at timestamptz, received_at timestamptz, provider text, delayed boolean default true.
- price_bars_1m: symbol text, ts timestamptz, open/high/low/close numeric, provider text, primary key(symbol,ts).
- market_sessions: date date primary key, is_open boolean, open_time text default '09:15', close_time text default '15:30', description text. Weekday default if no override; import validated NSE holiday overrides with source.
- equity_snapshots: account_id uuid, date date, equity numeric, stale boolean, primary key(account_id,date).
- engine_state: id integer primary key default 1, heartbeat_at timestamptz, status text, message text, provider text.
- notification_preferences: account_id uuid primary key, enabled boolean default false, telegram_chat_id text nullable, verified boolean default false.
- outbox: id bigserial, account_id uuid nullable (global alert only), trade_id uuid nullable, kind text, payload jsonb, dedupe_key text unique, attempts integer default 0, delivered_at timestamptz nullable, next_attempt_at timestamptz default now(), last_error text nullable.
- rate_limits: key text primary key, count integer, reset_at timestamptz.

Account then trade lock ordering; per-account ownership required for all queries. No account_id accepted as authority from client. Trade+event writes atomic. Advisory lock engine on dedicated postgres connection. Global quotes/calendars/bars shared. Cash/available/equity derive from trades; reservations never reduce equity.

## API contract for frontend

All endpoints under `/api`, JSON error `{error:{code,message}}`. Cookie session; same-origin requests (`credentials: 'include'`). Mutations require same Origin (or no Origin for CLI integration tests); JSON only. `POST /auth/register {username,password}` returns `{user:{id,username},accountId}` and cookie. `POST /auth/login` same; `GET /auth/me` same; `POST /auth/logout` 204. Username 3–30 lowercase letters/digits/_ with case-insensitive canonicalization; password 12–128 chars.

`GET /account` -> `{startingCapital,cashBalance,reservedCash,availableCash,investedValue,currentValue,unrealisedPnl,realisedPnl,equity,slippageBps,limitValidityDays,reservationBufferBps,feed:{status,provider,delayed,lastHeartbeatAt,message},marketOpen:boolean}`. All money strings. `PATCH /account/settings {startingCapital?,slippageBps?,limitValidityDays?}` -> account; capital changes allowed only with no trades (otherwise use reset). `POST /account/reset {confirm:'RESET'}` -> account (only caller).

`GET /instruments?q=...` -> `{instruments:[{symbol,name,tickSize,quote:{ltp,ts,receivedAt,provider,delayed}|null}]}`. Max 25. `GET /quotes/:symbol` -> `{symbol,ltp,ts,receivedAt,provider,delayed}` or 503 if unavailable. `GET /market` -> `{open,sessionDate,opensAt,closesAt,provider,delayed}` optional.

Trade object: `{id,symbol,qty,entryType,limitPrice,targetPrice,stopPrice,status,entryPrice,entryAt,exitPrice,exitAt,exitReason,reservedAmount,charges,grossPnl,netPnl,initialRisk,setupTag,thesis,review,rejectionReason,inferred,gapFill,expiresAt,createdAt,updatedAt,quote:{ltp,ts,receivedAt,provider,delayed}|null,unrealisedPnl:string|null}`.

`GET /trades?status=&symbol=&tag=&from=&to=&exit_reason=` -> `{trades:[Trade]}`. from/to dates use IST date range, closed filtered by exit_at, others created_at. `GET /trades/:id` -> `{trade:Trade,events:[{id,type,price,payload,effectiveAt,createdAt}]}`.

`POST /trades {symbol,qty?,amount?,entryType,limitPrice?,targetPrice,stopPrice,setupTag?,thesis?}` + optional `Idempotency-Key` -> `{trade:Trade}` 202 (worker fills asynchronously). Accept qty OR amount; amount converts to fixed whole-share quantity using reference. Market quote must exist for reservation and initial bracket validation even for queued order. `PATCH /trades/:id {targetPrice?,stopPrice?,setupTag?,thesis?,review?}` -> `{trade}`. `POST /trades/:id/exit {}` -> `{trade}`; only usable market-session quote. `POST /trades/:id/cancel {}` -> `{trade}`. `GET /trades/export.csv` same journal filters -> CSV safe against formula injection.

`GET /stats?from=&to=&tag=` -> `{totalTrades,wins,losses,breakEven,winRate,averageWin,averageLoss,expectancy,profitFactor,averageR,averageHoldingDays,maxDrawdown,bestTrade,worstTrade,byTag:[{tag,totalTrades,winRate,netPnl,expectancy}]}`. winRate and maxDrawdown numeric percentages, profitFactor/averageR nullable number, monetary values strings; bestTrade/worstTrade Trade or null. `GET /stats/equity-curve` -> `{points:[{date,equity,stale}],initialCapital}`.

`GET /stream` SSE account-scoped events `price`, `trade_filled`, `trade_exited`, `trade_updated`, `feed_status`, `snapshot`; frontend may invalidate/refetch on event. API may poll DB for reliable event resume and snapshots; use LISTEN/NOTIFY as optional wakeup. Recheck session and cease stream on revocation/expiry. `GET /health` minimal unauthenticated aggregate readiness.

## UI direction

Name **Paperlane**. Calm premium trading journal, warm off-white background, dark ink typography, deep emerald primary, restrained positive/negative colors. Real sidebar/navigation desktop, bottom/navigation drawer mobile. Responsive at 375px. Dashboard / Trade / Journal / Insights / Settings; trade detail modal/drawer or page. Explicit delayed-data badge, no real money, clear pending states. No fake portfolio data; empty states helpful, unavailable data explained. Register/login thoughtfully styled with a distinct visual panel. Use lucide icons and accessible focus/labels, loading/error states, toast feedback and explicit reset confirmation. Charts with real equity data.
