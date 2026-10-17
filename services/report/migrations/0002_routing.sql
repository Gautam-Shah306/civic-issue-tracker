-- 0002_routing.sql: Add ward and department references for Cycle 4 routing
ALTER TABLE reports ADD COLUMN IF NOT EXISTS ward_code VARCHAR(16) NULL;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS department_code VARCHAR(50) NULL;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS department_code VARCHAR(50) NULL;
