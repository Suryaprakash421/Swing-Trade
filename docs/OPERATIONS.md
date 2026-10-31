# Operations

Run host scripts from the checked-out repository. The scripts use Docker Compose and the database container's PostgreSQL tools, so the database does not need a public port. Protect backups and terminal logs because they can contain private trading data.

## Nightly backups

`scripts/backup.sh` creates an atomic custom-format `pg_dump`, validates that the archive can be read, and removes only generated backups older than approximately 14 days. The default directory is `backups/`, excluded from Git, with restrictive permissions. Override it with `BACKUP_DIR` if required.

```sh
./scripts/backup.sh
```

Install a host cron job under an operator permitted to use Docker. Use the repository's actual absolute path, and ensure the log directory exists with suitable permissions:

```cron
30 20 * * * /opt/paperlane/scripts/backup.sh >> /opt/paperlane/backups/cron.log 2>&1
```

Cron uses the host timezone. The example runs daily at 20:30 in that timezone; choose a time after the NSE session. Monitor the cron exit status/log and periodically verify a restore. A backup folder on the same VPS does not protect against loss of that VPS or disk; copy archives to a protected off-host destination if desired.

## Verify a restore without touching production

```sh
./scripts/restore.sh --verify backups/paperlane-YYYYMMDDTHHMMSSZ-PID.dump
```

This creates a disposable database in the running PostgreSQL container, restores the archive with errors treated as failures, reads account/trade counts, and drops the temporary database. It requires enough free disk for a second copy. A successful archive listing alone is not a full restore test.

## Replace the live database

First take a fresh backup, verify the chosen archive, and schedule downtime. This operation intentionally replaces the database contents:

```sh
./scripts/restore.sh --confirm-replace-existing-data backups/paperlane-YYYYMMDDTHHMMSSZ-PID.dump
```

The script stops the API and worker, performs a single-transaction restore, and restarts them only if restoration succeeds. If it fails, the services remain stopped so the operator can inspect the error. Check `/api/health`, login, and the engine's replay status afterward. Missing market history after an old restore must be reconciled visibly rather than treated as an exact recovery. Restoring an old backup also restores its user/session state; perform operator password resets where needed to revoke restored sessions.

## Reset a forgotten password

There is no unauthenticated reset endpoint or emailed password recovery in v1. A trusted operator can reset a specific username through the application container:

```sh
docker compose exec api node --import tsx scripts/reset-password.ts username
```

The command asks twice for a new password without echoing input. Use 12–128 characters. It updates the Argon2id hash and revokes all of that user's sessions in one transaction. The protected operator terminal/log receives a timestamped audit event without the password or hash. Never put a password in command-line arguments, a shell history entry, or Git.

## Session calendar

Review the official NSE holidays and special-session notices for each year. The application supports per-date session overrides and weekday defaults. Importing an incomplete holiday list does not make the remaining dates verified.

Prepare a UTF-8 JSON document in this shape (the example demonstrates the format; it is not a complete year):

```json
{
  "source": "https://www.nseindia.com/resources/exchange-communication-holidays",
  "year": 2026,
  "sessions": [{ "date": "2026-01-26", "isOpen": false, "description": "Republic Day" }]
}
```

For a special session, include `isOpen: true`, `openTime` and `closeTime` in IST `HH:mm` form. Reviewed overrides are upserted; no private trading data is deleted. The source URL is retained alongside the session description. The import validates format and consistency, not the truth of a holiday notice; the operator must review the source.

```sh
docker compose cp ./calendar.json api:/tmp/calendar.json
docker compose exec api node --import tsx scripts/import-calendar.ts /tmp/calendar.json --source-reviewed
```

If using host npm tooling instead, load `.env` explicitly:

```sh
node --env-file=.env --import tsx scripts/import-calendar.ts ./calendar.json --source-reviewed
```

## Instrument list

The engine attempts a bounded daily import from NSE's published equity CSV and preserves a startup seed if the source is unavailable. A manual offline import accepts NSE `EQUITY_L.csv` with `SYMBOL`, `NAME OF COMPANY`, and optional `SERIES`/`TICK SIZE` columns. Only `EQ` rows are imported when `SERIES` is present. Absent symbols are preserved to avoid breaking existing holdings.

```sh
docker compose cp ./EQUITY_L.csv api:/tmp/EQUITY_L.csv
docker compose exec api node --import tsx scripts/import-instruments.ts /tmp/EQUITY_L.csv
```

CSV files without a tick-size column use the schema's ₹0.05 fallback. Review/update tick sizes from an authoritative instrument source if required by a symbol's current NSE tick rules. The importer never places orders.

## Alerts and troubleshooting

- The dashboard's quote timestamp, feed state, and unresolved-history indicators describe data quality. A running API alone does not prove the worker is processing usable market data.
- Inspect `docker compose logs --tail=200 engine` for rate limits, lock refusal, missing candles, or failed imports. Do not run a second worker to work around an advisory-lock warning.
- Telegram delivery uses retrying outbox records and must target a verified recipient for the owning account. A failed alert does not roll back a trade. Recipient setup is an operator maintenance task in v1; the UI does not include a bot-linking flow. Use the procedure below before enabling it.
- Signup can be closed by setting `REGISTRATION_ENABLED=false` and recreating the API service. Existing account data remains separate and existing logins continue.
- Account reset in the UI affects only that authenticated user's trades, private events, reservations, and equity history. It does not delete other users or shared market data.
- Never use `docker compose down --volumes` as routine troubleshooting; it deletes the persistent database volume.

## Configure a private Telegram recipient

Leave `TELEGRAM_BOT_TOKEN` empty until notifications are wanted. Recipient verification is performed by the trusted operator in v1, not by accepting an arbitrary chat ID from another app user.

1. Have the intended user start a private conversation with your bot and send a one-time challenge agreed with that user. Confirm the challenge and exact Telegram chat ID through the bot's update mechanism and the same person's established identity. Do not use a shared group chat.
2. Set the bot token privately in `.env`; never put it into SQL or Git. Enabling the token permits the worker to send messages to every enabled, verified account recipient.
3. Open a database console:

```sh
docker compose exec db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

4. Set psql variables to the verified username and recipient, then enable that account's preference. Replace the sample values with the verified ones:

```sql
\set username 'verified_username'
\set chat_id '123456789'
BEGIN;
UPDATE notification_preferences p
SET telegram_chat_id = :'chat_id', verified = true, enabled = true
FROM accounts a JOIN users u ON u.id = a.user_id
WHERE p.account_id = a.id AND u.username = :'username';
COMMIT;
```

Confirm the update affected exactly one row. Recreate the engine after changing `.env`: `docker compose up -d engine`. Existing undelivered outbox records for that account may be delivered after enabling; review or clear unwanted backlog deliberately before activation. The worker caps retries and records failures without changing trading results.

To turn that account's notifications off, use the same console and username variable:

```sql
UPDATE notification_preferences p
SET enabled = false, verified = false, telegram_chat_id = NULL
FROM accounts a JOIN users u ON u.id = a.user_id
WHERE p.account_id = a.id AND u.username = :'username';
```

Never enable `verified` merely because someone provided a numeric chat ID. A shared global recipient would expose private activity and is intentionally unsupported.
