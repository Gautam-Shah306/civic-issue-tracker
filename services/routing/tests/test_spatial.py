"""Spatial ward resolution and department mapping tests."""

import psycopg

from app.config import Settings


def test_ward_lookup_inside_grid(test_settings: Settings) -> None:
    # lat 23.01 (row 2: 22.99-23.03), lng 72.48 (col 1: 72.45-72.50) -> W-R2C1
    with psycopg.connect(test_settings.postgres_dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
                SELECT code, name FROM wards
                WHERE active = true
                  AND ST_Intersects(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326))
                ORDER BY code ASC
                LIMIT 1;
                """,
            (72.48, 23.01),
        )
        row = cur.fetchone()
        assert row is not None
        assert row[0] == "W-R2C1"


def test_ward_lookup_on_boundary(test_settings: Settings) -> None:
    # lat 23.03 (boundary between row 2 and row 3), lng 72.58 (col 3: 72.55-72.60)
    with psycopg.connect(test_settings.postgres_dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
                SELECT code, name FROM wards
                WHERE active = true
                  AND ST_Intersects(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326))
                ORDER BY code ASC
                LIMIT 1;
                """,
            (72.58, 23.03),
        )
        row = cur.fetchone()
        assert row is not None
        assert row[0] in ("W-R2C3", "W-R3C3")
        # Deterministic lowest code
        assert row[0] == "W-R2C3"


def test_ward_lookup_outside_grid(test_settings: Settings) -> None:
    # lat 10.0, lng 10.0 (far outside Ahmedabad grid)
    with psycopg.connect(test_settings.postgres_dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
                SELECT code, name FROM wards
                WHERE active = true
                  AND ST_Intersects(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326))
                ORDER BY code ASC
                LIMIT 1;
                """,
            (10.0, 10.0),
        )
        row = cur.fetchone()
        assert row is None


def test_category_to_department_resolution(test_settings: Settings) -> None:
    expected_mappings = {
        "pothole": "roads",
        "garbage": "sanitation",
        "streetlight": "electricity",
        "water-leak": "water",
    }
    with psycopg.connect(test_settings.postgres_dsn) as conn, conn.cursor() as cur:
        for slug, expected_dept in expected_mappings.items():
            cur.execute(
                """
                    SELECT d.code, d.name, d.email
                    FROM categories c
                    JOIN departments d ON d.code = c.department_code
                    WHERE c.slug = %s AND c.active = true AND d.active = true;
                    """,
                (slug,),
            )
            row = cur.fetchone()
            assert row is not None
            assert row[0] == expected_dept
            assert row[2] == f"{expected_dept}@civic.example.test"

        # Unknown category returns None
        cur.execute(
            """
                SELECT d.code
                FROM categories c
                JOIN departments d ON d.code = c.department_code
                WHERE c.slug = %s AND c.active = true AND d.active = true;
                """,
            ("unknown-category",),
        )
        assert cur.fetchone() is None
