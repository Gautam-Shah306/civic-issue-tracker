"""Database migration runner matching Node schema_migrations semantics."""

import hashlib
import logging
import sys
from pathlib import Path
from typing import Any

import psycopg

from app.config import get_settings

ADVISORY_LOCK_ID = 849204821
logger = logging.getLogger("migrate")


def compute_sha256(content: str) -> str:
    """Compute hex SHA-256 digest of migration file content."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def find_migrations_dir() -> Path:
    """Locate migrations directory across common workspace or container locations."""
    cwd = Path.cwd()
    candidate_dirs = [
        cwd / "migrations",
        cwd / "services" / "routing" / "migrations",
        cwd / "services" / "_template-py" / "migrations",
        Path(__file__).parent.parent / "migrations",
        Path("/app/migrations"),
    ]
    for d in candidate_dirs:
        if d.is_dir():
            return d.resolve()
    raise FileNotFoundError(f"Migrations directory not found in candidate paths: {candidate_dirs}")


def run_migrations(
    conn: psycopg.Connection[Any],
    migrations_dir: Path | None = None,
) -> list[str]:
    """Execute pending SQL migrations under an advisory lock with SHA-256 verification."""
    target_dir = migrations_dir or find_migrations_dir()
    applied: list[str] = []

    with conn.cursor() as cur:
        # 1. Acquire advisory lock
        cur.execute("SELECT pg_advisory_lock(%s);", (ADVISORY_LOCK_ID,))
        try:
            # 2. Ensure schema_migrations table exists
            cur.execute("""
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version VARCHAR(255) PRIMARY KEY,
                    checksum VARCHAR(64) NOT NULL,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            """)
            conn.commit()

            # 3. Read and sort all .sql files
            sql_files = sorted(
                [f for f in target_dir.iterdir() if f.is_file() and f.suffix == ".sql"]
            )

            for sql_file in sql_files:
                filename = sql_file.name
                content = sql_file.read_text(encoding="utf-8")
                checksum = compute_sha256(content)

                cur.execute(
                    "SELECT checksum FROM schema_migrations WHERE version = %s;",
                    (filename,),
                )
                row = cur.fetchone()

                if row is not None:
                    recorded_checksum = row[0]
                    if recorded_checksum != checksum:
                        raise RuntimeError(
                            f"Migration checksum mismatch for {filename}: "
                            f"recorded={recorded_checksum}, calculated={checksum}"
                        )
                    # Already applied with matching checksum
                    continue

                # Apply migration inside an isolated transaction
                logger.info("Applying migration %s ...", filename)
                cur.execute(content)
                cur.execute(
                    "INSERT INTO schema_migrations (version, checksum) VALUES (%s, %s);",
                    (filename, checksum),
                )
                conn.commit()
                applied.append(filename)

        finally:
            cur.execute("SELECT pg_advisory_unlock(%s);", (ADVISORY_LOCK_ID,))
            conn.commit()

    return applied


def main() -> None:
    """Entry point for python -m app.migrate execution."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    settings = get_settings()
    logger.info(
        "Connecting to database at %s:%s/%s ...",
        settings.DB_HOST,
        settings.DB_PORT,
        settings.DB_NAME,
    )

    try:
        with psycopg.connect(settings.postgres_dsn) as conn:
            applied = run_migrations(conn)
            if applied:
                logger.info(
                    "Successfully applied %d migrations: %s",
                    len(applied),
                    ", ".join(applied),
                )
            else:
                logger.info("Database schema is up to date (no migrations applied).")
    except Exception as e:
        logger.error("Migration failed: %s", e)
        sys.exit(1)


if __name__ == "__main__":
    main()
