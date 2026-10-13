import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const ADVISORY_LOCK_ID = 849204823;

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
        throw new Error(`Failed to apply migration ${file}: ${(err as Error).message}`);
      }
    }

    return applied;
  } finally {
    await clientOrPool.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
  }
}

// CLI entry point when executed directly
if (
  process.argv[1] &&
  (process.argv[1].endsWith('migrate.ts') || process.argv[1].endsWith('migrate.js'))
) {
  const dbHost = process.env.DB_HOST || 'localhost';
  const dbPort = Number(process.env.DB_PORT) || 5432;
  const dbName = process.env.DB_NAME || 'civic_analytics';
  const dbUser = process.env.DB_USER || 'civic_analytics';
  const dbPassword = process.env.DB_PASSWORD;

  if (!dbPassword) {
    console.error('DB_PASSWORD environment variable is required');
    process.exit(1);
  }

  const pool = new Pool({
    host: dbHost,
    port: dbPort,
    database: dbName,
    user: dbUser,
    password: dbPassword
  });

  const migrationsDir = resolve(process.cwd(), 'migrations');

  runMigrations(pool, migrationsDir)
    .then((applied) => {
      if (applied.length > 0) {
        console.log(`Applied ${applied.length} migration(s):`, applied.join(', '));
      } else {
        console.log('No new migrations to apply.');
      }
      return pool.end();
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      pool.end().finally(() => process.exit(1));
    });
}
