-- 0002_seed.sql: Seed departments, categories, and synthetic 5x5 ward grid (D-045)

-- Departments
INSERT INTO departments (code, name, email, active) VALUES
    ('roads', 'Roads & Infrastructure', 'roads@civic.example.test', true),
    ('sanitation', 'Sanitation & Solid Waste', 'sanitation@civic.example.test', true),
    ('electricity', 'Electricity & Lighting', 'electricity@civic.example.test', true),
    ('water', 'Water & Sewerage', 'water@civic.example.test', true)
ON CONFLICT (code) DO NOTHING;

-- Categories
INSERT INTO categories (slug, name, department_code, active) VALUES
    ('pothole', 'Pothole', 'roads', true),
    ('garbage', 'Garbage', 'sanitation', true),
    ('streetlight', 'Streetlight', 'electricity', true),
    ('water-leak', 'Water Leak', 'water', true)
ON CONFLICT (slug) DO NOTHING;

-- Synthetic 5x5 PostGIS polygon grid
-- Lat 22.95 to 23.15 in steps of 0.04 (rows 1..5)
-- Lng 72.45 to 72.70 in steps of 0.05 (cols 1..5)
INSERT INTO wards (code, name, active, geom)
SELECT
    'W-R' || r || 'C' || c AS code,
    'Ward R' || r || 'C' || c AS name,
    true AS active,
    ST_SetSRID(
        ST_MakeEnvelope(
            ROUND((72.45 + (c - 1) * 0.05)::numeric, 4),
            ROUND((22.95 + (r - 1) * 0.04)::numeric, 4),
            ROUND((72.45 + c * 0.05)::numeric, 4),
            ROUND((22.95 + r * 0.04)::numeric, 4),
            4326
        ),
        4326
    ) AS geom
FROM generate_series(1, 5) AS r
CROSS JOIN generate_series(1, 5) AS c
ON CONFLICT (code) DO NOTHING;
