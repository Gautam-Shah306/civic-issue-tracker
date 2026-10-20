import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { Config } from '../config.js';
import { hashPassword } from './password.js';
import { EventValidator } from '../events/validator.js';

export async function bootstrapAdmin(
  pool: pg.Pool,
  config: Config,
  logger: FastifyBaseLogger,
  eventValidator: EventValidator
): Promise<void> {
  if (!config.BOOTSTRAP_ADMIN_EMAIL || !config.BOOTSTRAP_ADMIN_PASSWORD) {
    return;
  }

  const email = config.BOOTSTRAP_ADMIN_EMAIL.trim();
  const emailNormalized = email.toLowerCase();
  const password = config.BOOTSTRAP_ADMIN_PASSWORD;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if an active administrator already exists in the system
    const adminCheck = await client.query(
      "SELECT id FROM users WHERE role = 'admin' AND is_active = true LIMIT 1"
    );
    if (adminCheck.rows.length > 0) {
      await client.query('COMMIT');
      return;
    }

    // Check if a user with this normalized email already exists
    const emailCheck = await client.query(
      'SELECT id FROM users WHERE email_normalized = $1 LIMIT 1',
      [emailNormalized]
    );
    if (emailCheck.rows.length > 0) {
      await client.query('COMMIT');
      return;
    }

    // Hash password before inserting
    const passwordHash = await hashPassword(password, config);
    const userId = randomUUID();
    const now = new Date();
    const occurredAt = now.toISOString();
    const role = 'admin';
    const displayName = 'Administrator';

    const insertResult = await client.query(
      `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7, $7)
       ON CONFLICT (email_normalized) DO NOTHING
       RETURNING id`,
      [userId, email, emailNormalized, displayName, passwordHash, role, now]
    );

    if (insertResult.rows.length === 0) {
      await client.query('COMMIT');
      logger.info(
        { email: emailNormalized },
        'Bootstrap administrator already exists or concurrent bootstrap won'
      );
      return;
    }

    const eventId = randomUUID();
    const correlationId = randomUUID();
    const payload = {
      userId,
      email,
      displayName,
      role,
      createdAt: occurredAt
    };

    const eventEnvelope = {
      eventId,
      eventType: 'user.created',
      version: 1,
      occurredAt,
      correlationId,
      payload
    };

    eventValidator.validateUserCreated(eventEnvelope);

    await client.query(
      `INSERT INTO outbox_events (event_id, event_type, version, correlation_id, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [eventId, 'user.created', 1, correlationId, JSON.stringify(payload), occurredAt]
    );

    await client.query('COMMIT');
    logger.info({ email: emailNormalized }, 'Bootstrap administrator created successfully');
  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => {});
    if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
      logger.info(
        { email: emailNormalized },
        'Bootstrap administrator creation skipped due to unique constraint'
      );
      return;
    }
    logger.error({ err }, 'Failed to bootstrap administrator');
    throw err;
  } finally {
    client.release();
  }
}
