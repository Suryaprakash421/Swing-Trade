# Deploying Paperlane

Paperlane runs as three containers: PostgreSQL, the API that serves the built React application, and the engine. It needs no public database port or Redis. No deployment or external publishing is performed by the source repository itself.

## Configuration

Copy `.env.example` to `.env` and keep it private (`chmod 600 .env`). Generate a random hexadecimal database password, for example with `openssl rand -hex 32`. Set `DB_PASSWORD`; avoid URL-special characters unless you URL-encode them in connection strings. Compose derives its internal `DATABASE_URL`; host npm commands use the `DATABASE_URL` written in `.env`.

For HTTPS production, configure:

```dotenv
APP_ORIGIN=https://paper.example.com
COOKIE_SECURE=true
REGISTRATION_ENABLED=true
PRICE_PROVIDER=yahoo
POLL_INTERVAL_MS=20000
```

`APP_ORIGIN` must match the browser's exact scheme, hostname, and port. Compose binds the API to `127.0.0.1:3000`, enables proxy support, and sets `NODE_ENV=production`. On local HTTP only, use `APP_ORIGIN=http://localhost:3000` and `COOKIE_SECURE=false`. Secure cookies are required for a public HTTPS deployment.

There is no environment-variable app password. Users sign up individually and passwords are stored as Argon2id hashes. Set `REGISTRATION_ENABLED=false` after the intended users have registered if you want to close further signup. Existing users can still log in.

`TELEGRAM_BOT_TOKEN` is optional. It must never be committed. Alerts remain off until a user-specific chat recipient is configured and verified. A global chat ID is deliberately unsupported for private trade notifications.

## Start and update

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 api engine
curl --fail http://127.0.0.1:3000/api/health
```

The application starts with migrations applied. Engine readiness is distinct from API availability: inspect the authenticated dashboard's feed/engine state and worker logs as well as the health endpoint. Outside trading hours the engine can be healthy while idle.

To update, first take a backup, update the source, and run `docker compose up -d --build`. Review migrations before deployment; do not run two independent engines against the same database. A second engine should refuse the advisory lock and exit.

PostgreSQL 16 is the Compose default. Pin tested image digests in your own production release process if you require exact base-image reproducibility. Back up before changing PostgreSQL major versions; a named volume cannot be reused across arbitrary database major versions.

## HTTPS reverse proxy

Use the existing host reverse proxy. With Caddy, replace the domain and ensure its DNS points at the VPS:

```caddyfile
paper.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

Caddy provisions HTTPS and streams SSE promptly. For Nginx, use the equivalent existing TLS configuration and these upstream settings:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

Do not expose the loopback application port directly to the Internet. Allow inbound HTTPS at the reverse proxy and keep PostgreSQL unexposed. Ensure the configured proxy is the only path to the API when trusting forwarded headers.

## Capacity and market data

Start with at least 2 GB RAM if available. The original target of 50 active trades and 100 watched symbols is aggregate across users, not a per-user guarantee. Measure worker latency, memory, DB connections, provider request limits, and disk growth before expanding usage. Build images away from a memory-constrained VPS where practical.

Yahoo data is delayed and unofficial. Rate limits, missing intraday history, and outages are handled as degraded states; they cannot be converted into live execution guarantees. In delayed mode, orders and execution-level edits follow the quoted market timeline. The simulated event timestamp can precede the wall-clock submission/processing timestamp; the trade event log retains both. This is a delayed-data practice model, not proof of an order that could have executed at the current live market price.

Import the current reviewed NSE session calendar, including special sessions, before relying on automatic decisions. Review provider terms for the intended multi-user access model.

## Managed cloud build trust

The Dockerfile accepts an optional BuildKit `proxy_ca` secret for managed development environments that require an injected CA. It keeps certificate verification enabled and does not copy the session CA into image layers:

```sh
docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" --target api -t paperlane-api .
docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" --target engine -t paperlane-engine .
```

Use standard `docker compose build` on a normal VPS with public CA trust. In a managed environment, supply the secret through a local Compose build override or use the explicitly built images. A runtime that requires the same managed proxy CA must mount it read-only and set `NODE_EXTRA_CA_CERTS` for the engine; session-specific proxy configuration is not a production application requirement.
