#!/usr/bin/env sh
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mode=${1:-}
archive=${2:-}
if [ "$mode" != '--verify' ] && [ "$mode" != '--confirm-replace-existing-data' ]; then
  printf '%s\n' 'Usage: scripts/restore.sh --verify backup.dump' '   or: scripts/restore.sh --confirm-replace-existing-data backup.dump' >&2
  exit 2
fi
if [ ! -f "$archive" ] || [ ! -s "$archive" ]; then
  printf '%s\n' 'A readable, non-empty backup archive is required.' >&2
  exit 2
fi
compose() { docker compose --project-directory "$repo_dir" "$@"; }
compose exec -T db pg_restore --list < "$archive" > /dev/null
if [ "$mode" = '--verify' ]; then
  verify_db="paperlane_restore_check_$(date -u +%Y%m%d%H%M%S)_$$"
  cleanup() { compose exec -T db sh -c 'dropdb --if-exists -U "$POSTGRES_USER" "$1"' sh "$verify_db" > /dev/null; }
  trap cleanup EXIT HUP INT TERM
  compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$verify_db"
  compose exec -T db sh -c 'pg_restore --exit-on-error --single-transaction --no-owner -U "$POSTGRES_USER" -d "$1"' sh "$verify_db" < "$archive"
  compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -c "SELECT count(*) AS verified_accounts FROM accounts; SELECT count(*) AS verified_trades FROM trades;"' sh "$verify_db"
  printf '%s\n' 'Restore verified in a disposable database; production data was untouched.'
else
  # Downtime is intentional: there must be no writers while replacing data.
  compose stop api engine
  if ! compose exec -T db sh -c 'pg_restore --exit-on-error --single-transaction --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$archive"; then
    printf '%s\n' 'Restore failed. API and engine remain stopped; inspect the error before restarting.' >&2
    exit 1
  fi
  compose up -d api engine
  printf '%s\n' 'Database restored; API and engine restarted. Check engine recovery and /api/health.'
fi
