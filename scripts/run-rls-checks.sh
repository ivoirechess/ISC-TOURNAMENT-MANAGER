#!/usr/bin/env bash
# Runs supabase/tests/rls_checks.sql against a throwaway PostgreSQL cluster.
#
# Not part of `npm test`: it needs PostgreSQL binaries, which the static
# front-end does not otherwise require. Run it whenever a migration touches
# the RLS policies — CLAUDE.md asks for those to be reviewed explicitly, and
# reading the SQL is not the same as watching it refuse a write.
#
# Usage:  npm run test:rls
set -euo pipefail

PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1 || true)
if [ -z "$PGBIN" ]; then
  PGBIN=$(dirname "$(command -v initdb 2>/dev/null || true)" 2>/dev/null || true)
fi
if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/initdb" ]; then
  echo "PostgreSQL introuvable : ces verifications demandent initdb et pg_ctl." >&2
  echo "Sur Debian/Ubuntu : apt-get install postgresql" >&2
  exit 2
fi

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORKDIR=$(mktemp -d)

# initdb refuses to run as root. When the script is invoked as root (some
# containers), everything is run through an unprivileged system user
# instead; otherwise it runs as the current user with no indirection.
AS_USER=""
if [ "$(id -u)" -eq 0 ]; then
  for candidate in postgres nobody; do
    if id "$candidate" >/dev/null 2>&1; then AS_USER=$candidate; break; fi
  done
  if [ -z "$AS_USER" ]; then
    echo "Lance en root et aucun utilisateur non privilegie disponible." >&2
    echo "Relancez ce script sous un compte ordinaire." >&2
    exit 2
  fi
  chown -R "$AS_USER" "$WORKDIR"
fi

# Runs a command as that user when needed, directly otherwise.
run() {
  if [ -n "$AS_USER" ]; then
    su "$AS_USER" -s /bin/bash -c "$1"
  else
    bash -c "$1"
  fi
}
PORT=${PGPORT_RLS:-55440}
cleanup() {
  run "'$PGBIN/pg_ctl' -D '$WORKDIR/data' stop -m immediate" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

run "'$PGBIN/initdb' -D '$WORKDIR/data' -U postgres" >/dev/null

# Server settings go in the config file rather than through -o: quoting an
# empty listen_addresses across `su -c` is where this used to break.
{
  echo "listen_addresses = ''"
  echo "port = $PORT"
  echo "unix_socket_directories = '$WORKDIR'"
} >> "$WORKDIR/data/postgresql.conf"

run "'$PGBIN/pg_ctl' -D '$WORKDIR/data' -l '$WORKDIR/log' -w start" >/dev/null

psql_file() {
  run "'$PGBIN/psql' -h '$WORKDIR' -p $PORT -U postgres -v ON_ERROR_STOP=1 -q -f '$1'"
}
psql_stdin() {
  local sql_file="$WORKDIR/stdin.sql"
  cat > "$sql_file"
  [ -n "$AS_USER" ] && chown "$AS_USER" "$sql_file"
  psql_file "$sql_file"
}

# Stand-ins for what Supabase provides: the auth schema, the roles its API
# uses, and an auth.uid() the checks can point at any user in turn.
psql_stdin <<SQL >/dev/null
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable
  as \$\$ select nullif(current_setting('test.uid', true), '')::uuid \$\$;
create role authenticated;
create role anon;
grant usage on schema public, auth to authenticated, anon;
SQL

for migration in "$ROOT"/supabase/migrations/*.sql; do
  cp "$migration" "$WORKDIR/migration.sql"
  [ -n "$AS_USER" ] && chown "$AS_USER" "$WORKDIR/migration.sql"
  psql_file "$WORKDIR/migration.sql" >/dev/null
done

psql_stdin <<SQL >/dev/null
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
SQL

# NOTICE carries the per-check output; anything raised aborts with a message.
cp "$ROOT/supabase/tests/rls_checks.sql" "$WORKDIR/checks.sql"
[ -n "$AS_USER" ] && chown "$AS_USER" "$WORKDIR/checks.sql"
run "'$PGBIN/psql' -h '$WORKDIR' -p $PORT -U postgres -v ON_ERROR_STOP=1 -f '$WORKDIR/checks.sql'" 2>&1 |
  grep -E "NOTICE:|ERROR:|^Toutes" |
  sed -E 's/^psql:[^:]*:[0-9]+: //; s/^NOTICE:  //'
