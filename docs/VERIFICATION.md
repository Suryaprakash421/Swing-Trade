# Implementation verification

The implementation uses Node.js 24 LTS, TypeScript 7, Fastify 5, React 19, Vite 8, and PostgreSQL 16. Dependency versions are pinned and `package-lock.json` is committed for repeatable installs.

## Completed locally

- Server and frontend TypeScript checks.
- Production frontend build.
- 47 unit tests covering decimal math, reservations, execution rules, conservative candle handling, calendar overrides, provider backoff, quote validation, and UI monetary estimates.
- Shell syntax, deployment YAML, documentation links, and maintenance-command validation.
- Backup/restore control-flow checks with a simulated Docker executable; real restore verification uses the documented disposable database command.

## Database and browser checks

The cloud execution sandbox requires separate permission for local service/network connections. PostgreSQL and browser integration could not be completed locally without that grant; they are configured in the repository's GitHub Actions workflow instead. The workflow provisions PostgreSQL 16 and runs all 70 tests, including 23 database integration cases, then builds the frontend, runs Chromium desktop/mobile flows, saves screenshots/traces, and builds the deployment image. Check the workflow result for the current commit before deployment.

To reproduce against your own disposable PostgreSQL database:

```sh
DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/TEST_DATABASE npm test
npm run build
npx playwright install chromium
# Start the API on port 3100 with APP_ORIGIN=http://127.0.0.1:3100 and the same TEST_DATABASE.
npm run test:browser
```

Alternatively, `npm run verify:local` provisions its own isolated embedded PostgreSQL 16 instance, runs all tests/builds, starts the API, and runs browser tests. It defaults to system Chromium at `/usr/bin/chromium`; set `CHROMIUM_PATH` to your installed Chromium executable. Its database is disposable and separate from your development/production account data. Run as a normal non-root user.

## External service check

A bounded request to Yahoo's chart endpoint returned HTTP 429 in this cloud environment. The engine implements rate-limit backoff and shows unavailable/stale data rather than substituting fabricated prices. This is an external feed limitation; fixture quotes are used only in explicitly labeled automated tests and are disabled as an engine provider in production.

Actual VPS deployment, HTTPS/domain configuration, live Yahoo availability from that VPS, and optional per-user Telegram delivery depend on the destination environment and are not claimed as completed here. No Telegram messages were sent during development. Angel One remains the agreed v2 scope.
