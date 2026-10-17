"""Migrations idempotency and checksum tamper tests."""

from pathlib import Path

import psycopg
import pytest

from app.config import Settings
from app.migrate import run_migrations


def test_migrations_run_twice(test_settings: Settings) -> None:
    """Verify migrations runner is idempotent and handles re-run cleanly."""
    with psycopg.connect(test_settings.postgres_dsn) as conn:
        run_migrations(conn)
        # Second run must not fail and apply 0 migrations
        applied_second = run_migrations(conn)
        assert len(applied_second) == 0


def test_migration_checksum_tamper_detected(test_settings: Settings, tmp_path: Path) -> None:
    """Verify migration runner refuses execution if an applied file's checksum changed."""
    # Create fake migrations directory with a modified migration
    mig_dir = tmp_path / "migrations"
    mig_dir.mkdir()
    (mig_dir / "0001_init.sql").write_text("-- Tampered sql content", encoding="utf-8")

    with (
        psycopg.connect(test_settings.postgres_dsn) as conn,
        pytest.raises(RuntimeError, match="Migration checksum mismatch"),
    ):
        run_migrations(conn, migrations_dir=mig_dir)
