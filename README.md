# Paperlane

A self-hosted NSE equity paper trading journal. Create an account, practise long-only swing trades with targets and stops, and review the results. Every user has a separate virtual portfolio starting at ₹1,00,000. All transaction charges default to zero; simulated slippage is configured separately.

Paperlane never places real orders. Yahoo quotes are delayed and unofficial. Fills reconstructed from candles are estimates and are labeled accordingly; missing history is surfaced for review. In delayed mode, trading actions use the quoted market timeline: their simulated event time can precede the wall-clock time at which you submitted or processed them.

## Run locally with Docker

Requirements: Docker Engine with Compose v2. A 2 GB RAM VPS is recommended initially; actual capacity depends on active symbols and users.

```sh
cp .env.example .env
```

Set `DB_PASSWORD` in `.env` to a long random URL-safe value. Set the same password inside `DATABASE_URL` if you will also run host-side npm commands. For local HTTP, keep `APP_ORIGIN=http://localhost:3000` and `COOKIE_SECURE=false`.

```sh
docker compose up -d --build
```

Open **http://localhost:3000** and choose **Create account**. No shared/default password is installed. The database stays private to the Compose network, and the application port binds only to localhost.

```sh
docker compose logs -f api engine
docker compose down
```

The named database volume survives `docker compose down`. Do not add `--volumes` unless you intend to erase all users and trades.

## Development

Node.js **24 LTS**, npm workspaces, and PostgreSQL **16+** are required. Configure `.env` with a reachable local `DATABASE_URL`. For Vite development set `APP_ORIGIN=http://localhost:5173` and `COOKIE_SECURE=false`, then:

```sh
npm ci
npm run migrate
npm run dev
```

The development tooling starts the API, engine, and Vite web client; open **http://localhost:5173**. Vite forwards `/api` to the API on port 3000.

If Docker or a system PostgreSQL server is unavailable, the optional local development runner starts a persistent PostgreSQL 16 instance bound to loopback. After `npm ci`, run this in a separate terminal:

```sh
node --import tsx scripts/dev-db.ts
```

Set `.env` to `DATABASE_URL=postgresql://paperlane:local-development-only@127.0.0.1:55432/papertrade`, then run the migration/development commands above. Its data is stored under `.local/postgres`, excluded from Git and Docker images. The fixed local password and optional embedded binary are for development only; production uses the Compose database with your own random password. Stop the runner with Ctrl+C.

For a production web build served by the API, set `APP_ORIGIN=http://localhost:3000` for local HTTP or your actual HTTPS origin for deployment:

```sh
npm run build
npm run start:api
```

Run `npm run start:engine` in a second terminal. The API and worker share PostgreSQL; neither needs Redis. Both require the same database configuration. The worker takes a dedicated advisory lock so only one engine processes trades.

```sh
npm run typecheck
npm test
```

## Features

- Username/password signup, login/logout, persistent sessions, and account ownership checks throughout the API and live event stream.
- Separate cash, buying-power reservations, positions, journal, settings, and statistics per user.
- Market and limit entries, queued orders outside market hours, target/stop exits, manual exit, cancellation, configurable expiry, and an audit timeline.
- Decimal monetary calculations, zero transaction charges, opening-gap rules, conservative candle recovery, and visible delayed/stale/inferred data states.
- Dashboard, responsive order form, journal filters and CSV export, equity curve, expectancy, R multiples, and drawdown.
- Optional verified per-user Telegram alerts through a retrying outbox. No private activity is broadcast to a global chat.
- Three-container deployment, HTTPS proxy guidance, nightly backup script, disposable restore verification, and operator password reset.

## Operations and requirements

- [Deployment and HTTPS](docs/DEPLOYMENT.md)
- [Backups, restores, imports, and password recovery](docs/OPERATIONS.md)
- [Approved owner decisions](docs/DECISIONS.md)
- [Multi-user requirements](docs/MULTI_USER_ADDENDUM.md)
- [PRD review and accepted corrections](docs/PRD_REVIEW.md)
- [Original PRD](docs/reference/Paper%20Trading%20Simulator%20-%20PRD.pdf)

The reviewed 2026 NSE calendar is bundled, including the January 15 election amendment. November 8 Muhurat trading remains blocked until its special-session times are reviewed. Import reviewed calendars for subsequent years; the engine prevents execution against unknown calendar years or unresolved special sessions. The bundled instrument seed supports startup; the engine refreshes the NSE equity list when available. Validate the provider's current data access and permitted multi-user usage for your deployment. Angel One live data is a later release, as agreed.

Source repository: [Suryaprakash421/Swing-Trade](https://github.com/Suryaprakash421/Swing-Trade). See [verification notes](docs/VERIFICATION.md) for the checks actually run. CI validates PostgreSQL behavior, browser flows, and the Docker build on every push.
