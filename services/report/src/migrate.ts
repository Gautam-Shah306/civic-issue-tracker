import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const ADVISORY_LOCK_ID = 849204821;

export async function runMigrations(
  clientOrPool: pg.Pool | pg.PoolClient | pg.Client,
  migrationsDir: string
): Promise<string[]> {
  const applied: string[] = [];

  // Acquire PostgreSQL advisory lock
  await clientOrPool.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);

  try {
    // Ensure migrations tracking table exists
    await clientOrPool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    if (!existsSync(migrationsDir)) {
      throw new Error(`Migrations directory not found: ${migrationsDir}`);
    }

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const filePath = join(migrationsDir, file);
      const sqlContent = readFileSync(filePath, 'utf8');
      const checksum = createHash('sha256').update(sqlContent, 'utf8').digest('hex');

      const existing = await clientOrPool.query(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [file]
      );

      if (existing.rows.length > 0) {
        const storedChecksum = existing.rows[0].checksum;
        if (storedChecksum !== checksum) {
          throw new Error(
            `Migration checksum mismatch for ${file}: recorded=${storedChecksum}, calculated=${checksum}`
          );
        }
        // Already applied and checksum matches
        continue;
      }

      // Apply migration inside transaction
      await clientOrPool.query('BEGIN');
      try {
        await clientOrPool.query(sqlContent);
        await clientOrPool.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [file, checksum]
        );
        await clientOrPool.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await clientOrPool.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await clientOrPool.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
  }

  return applied;
}

// Standalone execution entrypoint
async function main() {
  const host = process.env.DB_HOST || '127.0.0.1';
  const port = Number(process.env.DB_PORT) || 5432;
  const database = process.env.DB_NAME || 'civic_report';
  const user = process.env.DB_USER || 'civic_report';
  const password = process.env.DB_PASSWORD || '';

  const pool = new Pool({
    host,
    port,
    database,
    user,
    password
  });

  // Resolve migrations directory (relative to project root or container /app/migrations)
  const candidateDirs = [
    resolve(process.cwd(), 'migrations'),
    resolve(process.cwd(), 'services/report/migrations'),
    resolve(import.meta.dirname, '../migrations'),
    '/app/migrations'
  ];

  let migrationsDir = candidateDirs.find((d) => existsSync(d));
  if (!migrationsDir) {
    migrationsDir = resolve(process.cwd(), 'migrations');
  }

  try {
    const applied = await runMigrations(pool, migrationsDir);
    console.log(
      `Successfully executed migrations (${applied.length} applied) from ${migrationsDir}`
    );
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    await pool.end();
    process.exit(1);
  }
}

// Run main if executed directly via node dist/migrate.js or node src/migrate.ts
if (
  process.argv[1] &&
  (process.argv[1].endsWith('migrate.js') || process.argv[1].endsWith('migrate.ts'))
) {
  main();
}
