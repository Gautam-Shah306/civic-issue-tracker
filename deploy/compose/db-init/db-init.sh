#!/bin/sh
set -eu

# db-init.sh: Idempotent database and role provisioning for Civic Issue Tracker services.
# Provisions roles and databases for: auth, report, notification.
# Enforces least-privilege connection access and installs required extensions.

POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
ADMIN_USER="${POSTGRES_USER:?Postgres admin user is required}"
ADMIN_DB="${POSTGRES_DB:?Postgres admin db is required}"

export PGPASSWORD="${POSTGRES_PASSWORD:?Postgres admin password is required}"

echo "Connecting to PostgreSQL at ${POSTGRES_HOST}:${POSTGRES_PORT} as ${ADMIN_USER}..."

run_admin_sql() {
    psql -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -U "${ADMIN_USER}" -d "${ADMIN_DB}" -v ON_ERROR_STOP=1 "$@"
}

run_db_sql() {
    target_db="$1"
    shift
    psql -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -U "${ADMIN_USER}" -d "${target_db}" -v ON_ERROR_STOP=1 "$@"
}

provision_service() {
    service_name="$1"
    service_password="$2"
    install_postgis="$3"

    role_name="civic_${service_name}"
    db_name="civic_${service_name}"

    echo "Provisioning role and database for '${service_name}'..."

    # 1. Create role if not exists, then set password and ensure LOGIN
    run_admin_sql -v rname="${role_name}" -v rpass="${service_password}" <<'SQL'
SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L', :'rname', :'rpass')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'rname')
\gexec

SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'rname', :'rpass')
\gexec
SQL

    # 2. Create database if not exists owned by the service role
    run_admin_sql -v dbname="${db_name}" -v rname="${role_name}" <<'SQL'
SELECT format('CREATE DATABASE %I WITH OWNER %I', :'dbname', :'rname')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'dbname')
\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'dbname', :'rname')
\gexec
SQL

    # 3. Restrict connection access: REVOKE CONNECT from PUBLIC, GRANT CONNECT only to its owner role
    run_admin_sql -v dbname="${db_name}" -v rname="${role_name}" <<'SQL'
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'dbname')
\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'dbname', :'rname')
\gexec
SQL

    # 4. Install extensions if requested
    if [ "${install_postgis}" = "true" ]; then
        echo "Ensuring PostGIS extension is installed in '${db_name}'..."
        run_db_sql "${db_name}" -c "CREATE EXTENSION IF NOT EXISTS postgis;"
    fi
}

provision_service "auth" "${AUTH_DB_PASSWORD:?AUTH_DB_PASSWORD is required}" "false"
provision_service "report" "${REPORT_DB_PASSWORD:?REPORT_DB_PASSWORD is required}" "true"
provision_service "notification" "${NOTIFICATION_DB_PASSWORD:?NOTIFICATION_DB_PASSWORD is required}" "false"
provision_service "analytics" "${ANALYTICS_DB_PASSWORD:?ANALYTICS_DB_PASSWORD is required}" "false"
provision_service "routing" "${ROUTING_DB_PASSWORD:?ROUTING_DB_PASSWORD is required}" "true"
provision_service "image" "${IMAGE_DB_PASSWORD:?IMAGE_DB_PASSWORD is required}" "false"

echo "Provisioning civic_analytics_rw role..."
run_admin_sql -v rname="civic_analytics_rw" -v rpass="${ANALYTICS_RW_DB_PASSWORD:?ANALYTICS_RW_DB_PASSWORD is required}" <<'SQL'
SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L', :'rname', :'rpass')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'rname')
\gexec

SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'rname', :'rpass')
\gexec
SQL

run_admin_sql -v dbname="civic_analytics" -v rname="civic_analytics_rw" <<'SQL'
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'dbname', :'rname')
\gexec
SQL

echo "Database provisioning completed successfully."
