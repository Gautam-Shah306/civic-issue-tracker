import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { Connection, AsyncMessage } from 'rabbitmq-client';
import { SignJWT } from 'jose';
import { PINNED_IMAGES } from '../support/images.js';
import { runMigrations } from '../../src/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig, Config } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createEventValidator } from '../../src/events/validator.js';
import { createAnalyticsConsumers } from '../../src/events/consumers.js';

async function pollUntil<T>(
  fn: () => Promise<T | null | false | undefined>,
  timeoutMs = 30000,
  intervalMs = 150
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Polling timed out after ${timeoutMs}ms`);
}

describe('Analytics & Audit Service Integration Tests (Testcontainers)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let rabbitContainer: StartedRabbitMQContainer;
  let adminPool: pg.Pool;
  let ownerPool: pg.Pool;
  let rwPool: pg.Pool;
  let config: Config;
  let rabbitClient: Connection;
  let testPrivateKey: crypto.KeyObject;
  let testPublicKeyB64: string;
  let migrationsDir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;

  async function createJwt(
    userId: string,
    role: string,
    options: { exp?: string; iss?: string; aud?: string; foreignKey?: boolean } = {}
  ): Promise<string> {
    const signerKey = options.foreignKey
      ? crypto.generateKeyPairSync('ed25519').privateKey
      : testPrivateKey;

    return new SignJWT({ role })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(userId)
      .setIssuer(options.iss || 'civic-auth')
      .setAudience(options.aud || 'civic-api')
      .setIssuedAt()
      .setExpirationTime(options.exp || '15m')
      .sign(signerKey);
  }

  beforeAll(async () => {
    // 1. Generate Ed25519 Key Pair for test JWT verification
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    testPrivateKey = privateKey;
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    testPublicKeyB64 = Buffer.from(pubPem).toString('base64');

    // 2. Start PostgreSQL Container
    pgContainer = await new PostgreSqlContainer(PINNED_IMAGES.postgres)
      .withDatabase('civic_admin')
      .withUsername('civic_admin')
      .withPassword('civic_admin_pass')
      .withStartupTimeout(120000)
      .start();

    // 3. Start RabbitMQ Container
    rabbitContainer = await new RabbitMQContainer(PINNED_IMAGES.rabbitmq)
      .withEnvironment({
        RABBITMQ_DEFAULT_USER: 'civic_test',
        RABBITMQ_DEFAULT_PASS: 'civic_test_pass'
      })
      .withStartupTimeout(120000)
      .start();

    const pgHost = pgContainer.getHost();
    const pgPort = pgContainer.getMappedPort(5432);
    const rabbitHost = rabbitContainer.getHost();
    const rabbitPort = rabbitContainer.getMappedPort(5672);

    adminPool = new pg.Pool({
      host: pgHost,
      port: pgPort,
      database: 'civic_admin',
      user: 'civic_admin',
      password: 'civic_admin_pass'
    });

    // Provision roles and database
    await adminPool.query(
      `CREATE ROLE civic_analytics WITH LOGIN PASSWORD 'analytics_owner_pass';`
    );
    await adminPool.query(
      `CREATE ROLE civic_analytics_rw WITH LOGIN PASSWORD 'analytics_rw_pass';`
    );
    await adminPool.query(`CREATE DATABASE civic_analytics WITH OWNER civic_analytics;`);
    await adminPool.query(`REVOKE CONNECT ON DATABASE civic_analytics FROM PUBLIC;`);
    await adminPool.query(`GRANT CONNECT ON DATABASE civic_analytics TO civic_analytics;`);
    await adminPool.query(`GRANT CONNECT ON DATABASE civic_analytics TO civic_analytics_rw;`);

    ownerPool = new pg.Pool({
      host: pgHost,
      port: pgPort,
      database: 'civic_analytics',
      user: 'civic_analytics',
      password: 'analytics_owner_pass'
    });

    rwPool = new pg.Pool({
      host: pgHost,
      port: pgPort,
      database: 'civic_analytics',
      user: 'civic_analytics_rw',
      password: 'analytics_rw_pass'
    });

    migrationsDir = resolve(process.cwd(), 'migrations');
    if (!existsSync(migrationsDir)) {
      migrationsDir = resolve(process.cwd(), 'services/analytics/migrations');
    }

    config = loadConfig({
      DB_HOST: pgHost,
      DB_PORT: pgPort,
      DB_NAME: 'civic_analytics',
      DB_USER: 'civic_analytics_rw',
      DB_PASSWORD: 'analytics_rw_pass',
      RABBITMQ_URL: `amqp://civic_test:civic_test_pass@${rabbitHost}:${rabbitPort}`,
      JWT_PUBLIC_KEY_B64: testPublicKeyB64,
      DELIVERY_LIMIT: 2,
      CONTRACTS_DIR: resolve(process.cwd(), '../../contracts')
    });

    rabbitClient = new Connection(config.RABBITMQ_URL);
    await rabbitClient.onConnect();

    // Run migrations as owner role
    await runMigrations(ownerPool, migrationsDir);

    app = await buildApp(config, {
      pool: rwPool,
      isRabbitReady: () => true,
      areConsumersReady: () => true
    });
    await app.ready();
  }, 240000);

  const activeConsumers: Array<{ stop(): Promise<void> }> = [];

  afterEach(async () => {
    for (const c of activeConsumers) {
      await c.stop().catch(() => {});
    }
    activeConsumers.length = 0;
  });

  afterAll(async () => {
    for (const c of activeConsumers) {
      await c.stop().catch(() => {});
    }
    if (app) await app.close().catch(() => {});
    if (rwPool) await rwPool.end().catch(() => {});
    if (ownerPool) await ownerPool.end().catch(() => {});
    if (adminPool) await adminPool.end().catch(() => {});
    if (rabbitClient) {
      await Promise.race([
        rabbitClient.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 2000))
      ]);
    }
    if (pgContainer) await pgContainer.stop().catch(() => {});
    if (rabbitContainer) await rabbitContainer.stop().catch(() => {});
  }, 120000);

  it('runs migrations twice idempotently', async () => {
    const secondRun = await runMigrations(ownerPool, migrationsDir);
    expect(secondRun.length).toBe(0);
  });

  it('enforces append-only immutability: _rw role cannot update/delete/truncate and trigger blocks owner', async () => {
    const eventId = crypto.randomUUID();
    // Insert test row into audit_log as rw role
    await rwPool.query(
      `INSERT INTO audit_log (event_id, event_type, version, correlation_id, occurred_at, actor, payload)
       VALUES ($1, 'test.event', 1, $2, clock_timestamp(), 'tester', '{"test":true}');`,
      [eventId, crypto.randomUUID()]
    );

    // 1. _rw role attempts UPDATE (fails with permission denied 42501)
    await expect(
      rwPool.query(`UPDATE audit_log SET actor = 'hacker' WHERE event_id = $1`, [eventId])
    ).rejects.toThrow();

    // 2. _rw role attempts DELETE (fails with permission denied 42501)
    await expect(
      rwPool.query(`DELETE FROM audit_log WHERE event_id = $1`, [eventId])
    ).rejects.toThrow();

    // 3. _rw role attempts TRUNCATE (fails with permission denied)
    await expect(rwPool.query(`TRUNCATE audit_log`)).rejects.toThrow();

    // 4. Owner role attempts UPDATE (trigger raises 55000 reject_audit_log_mutation)
    let updateErr: (Error & { code?: string }) | null = null;
    try {
      await ownerPool.query(`UPDATE audit_log SET actor = 'owner_update' WHERE event_id = $1`, [
        eventId
      ]);
    } catch (err: unknown) {
      updateErr = err as Error & { code?: string };
    }
    expect(updateErr).not.toBeNull();
    expect(updateErr?.code).toBe('55000');

    // 5. Owner role attempts DELETE (trigger raises 55000)
    let deleteErr: (Error & { code?: string }) | null = null;
    try {
      await ownerPool.query(`DELETE FROM audit_log WHERE event_id = $1`, [eventId]);
    } catch (err: unknown) {
      deleteErr = err as Error & { code?: string };
    }
    expect(deleteErr).not.toBeNull();
    expect(deleteErr?.code).toBe('55000');

    // 6. Owner role attempts TRUNCATE (trigger raises 55000)
    let truncErr: (Error & { code?: string }) | null = null;
    try {
      await ownerPool.query(`TRUNCATE audit_log`);
    } catch (err: unknown) {
      truncErr = err as Error & { code?: string };
    }
    expect(truncErr).not.toBeNull();
    expect(truncErr?.code).toBe('55000');
  });

  it('audit consumer stores every event type once, and ignores duplicates', async () => {
    const logger = createLogger({ serviceName: 'test-analytics', level: 'silent' });
    const validator = createEventValidator(config);
    const consumers = createAnalyticsConsumers({
      config,
      pool: rwPool,
      rabbitClient,
      validator,
      logger
    });
    await consumers.start();
    activeConsumers.push(consumers);

    const eventId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const reportId = crypto.randomUUID();
    const reporterId = crypto.randomUUID();

    const reportSubmittedEvent = {
      eventId,
      eventType: 'report.submitted',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId,
      payload: {
        reportId,
        reporterId,
        title: 'Water main broken',
        description: 'Details',
        category: 'water-leak',
        location: { lat: 23.0, lng: 72.0 },
        submittedAt: new Date().toISOString()
      }
    };

    const pub = rabbitClient.createPublisher({ confirms: true });
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.submitted' },
      reportSubmittedEvent
    );

    // Wait for audit log row
    const auditRow = await pollUntil(async () => {
      const res = await rwPool.query<Record<string, unknown>>(
        'SELECT * FROM audit_log WHERE event_id = $1',
        [eventId]
      );
      return res.rows.length > 0 ? res.rows[0] : null;
    });

    expect(auditRow).not.toBeNull();
    expect(auditRow.event_type).toBe('report.submitted');
    expect(auditRow.actor).toBe(reporterId);
    expect(auditRow.subject_type).toBe('report');
    expect(auditRow.subject_id).toBe(reportId);

    // Resend duplicate
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.submitted' },
      reportSubmittedEvent
    );

    await new Promise((r) => setTimeout(r, 500));
    const countRes = await rwPool.query('SELECT count(*) FROM audit_log WHERE event_id = $1', [
      eventId
    ]);
    expect(Number(countRes.rows[0].count)).toBe(1);

    await consumers.stop();
  });

  it('stats consumer updates report_index across full lifecycle and summary numbers are correct', async () => {
    const logger = createLogger({ serviceName: 'test-analytics', level: 'silent' });
    const validator = createEventValidator(config);
    const consumers = createAnalyticsConsumers({
      config,
      pool: rwPool,
      rabbitClient,
      validator,
      logger
    });
    await consumers.start();
    activeConsumers.push(consumers);

    const reportId = crypto.randomUUID();
    const pub = rabbitClient.createPublisher({ confirms: true });
    const baseTime = Date.now() - 36000000; // 10h ago

    // 1. report.submitted
    const submittedTime = new Date(baseTime).toISOString();
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.submitted' },
      {
        eventId: crypto.randomUUID(),
        eventType: 'report.submitted',
        version: 1,
        occurredAt: submittedTime,
        correlationId: crypto.randomUUID(),
        payload: {
          reportId,
          reporterId: crypto.randomUUID(),
          title: 'Pothole on Main St',
          description: 'Deep hole',
          category: 'pothole',
          location: { lat: 23.0, lng: 72.0 },
          submittedAt: submittedTime
        }
      }
    );

    // Wait for report_index insertion via polling (up to 30s)
    await pollUntil(async () => {
      const res = await rwPool.query('SELECT * FROM report_index WHERE report_id = $1', [reportId]);
      return res.rows.length > 0;
    });

    // 2. Verified (T1: baseTime + 2h)
    const verifiedTime = new Date(baseTime + 7200000).toISOString();
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.status-changed' },
      {
        eventId: crypto.randomUUID(),
        eventType: 'report.status-changed',
        version: 1,
        occurredAt: verifiedTime,
        correlationId: crypto.randomUUID(),
        payload: {
          reportId,
          fromStatus: 'Submitted',
          toStatus: 'Verified',
          changedBy: crypto.randomUUID(),
          changedAt: verifiedTime
        }
      }
    );

    // 3. Assigned (T2: baseTime + 4h)
    const assignedTime = new Date(baseTime + 14400000).toISOString();
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.status-changed' },
      {
        eventId: crypto.randomUUID(),
        eventType: 'report.status-changed',
        version: 1,
        occurredAt: assignedTime,
        correlationId: crypto.randomUUID(),
        payload: {
          reportId,
          fromStatus: 'Verified',
          toStatus: 'Assigned',
          changedBy: crypto.randomUUID(),
          changedAt: assignedTime
        }
      }
    );

    // 4. In Progress (T3: baseTime + 6h)
    const inProgressTime = new Date(baseTime + 21600000).toISOString();
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.status-changed' },
      {
        eventId: crypto.randomUUID(),
        eventType: 'report.status-changed',
        version: 1,
        occurredAt: inProgressTime,
        correlationId: crypto.randomUUID(),
        payload: {
          reportId,
          fromStatus: 'Assigned',
          toStatus: 'In Progress',
          changedBy: crypto.randomUUID(),
          changedAt: inProgressTime
        }
      }
    );

    // 5. Resolved (T4: baseTime + 8h)
    const resolvedTime = new Date(baseTime + 28800000).toISOString();
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.status-changed' },
      {
        eventId: crypto.randomUUID(),
        eventType: 'report.status-changed',
        version: 1,
        occurredAt: resolvedTime,
        correlationId: crypto.randomUUID(),
        payload: {
          reportId,
          fromStatus: 'In Progress',
          toStatus: 'Resolved',
          changedBy: crypto.randomUUID(),
          changedAt: resolvedTime
        }
      }
    );

    // Wait for resolved_at to be set via polling (up to 30s)
    const resolvedRow = await pollUntil(async () => {
      const res = await rwPool.query<Record<string, unknown>>(
        'SELECT * FROM report_index WHERE report_id = $1 AND resolved_at IS NOT NULL',
        [reportId]
      );
      return res.rows.length > 0 ? res.rows[0] : null;
    });

    expect(resolvedRow).not.toBeNull();
    expect(resolvedRow.current_status).toBe('Resolved');

    // 6. Reopened (T5: baseTime + 9h)
    const reopenedTime = new Date(baseTime + 32400000).toISOString();
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.status-changed' },
      {
        eventId: crypto.randomUUID(),
        eventType: 'report.status-changed',
        version: 1,
        occurredAt: reopenedTime,
        correlationId: crypto.randomUUID(),
        payload: {
          reportId,
          fromStatus: 'Resolved',
          toStatus: 'Reopened',
          changedBy: crypto.randomUUID(),
          changedAt: reopenedTime
        }
      }
    );

    // Wait for resolved_at to be cleared via polling (up to 30s)
    await pollUntil(async () => {
      const res = await rwPool.query<{ current_status: string; resolved_at: unknown }>(
        'SELECT current_status, resolved_at FROM report_index WHERE report_id = $1 AND current_status = $2',
        [reportId, 'Reopened']
      );
      return res.rows.length > 0 && res.rows[0].resolved_at === null;
    });

    const officerToken = await createJwt(crypto.randomUUID(), 'officer');
    const res = await request(app.server)
      .get('/api/v1/analytics/summary')
      .set('Authorization', `Bearer ${officerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.totalReports).toBeGreaterThanOrEqual(1);
    expect(res.body.byCategory.pothole).toBeGreaterThanOrEqual(1);
    expect(res.body.byStatus.Reopened).toBeGreaterThanOrEqual(1);

    await consumers.stop();
  });

  it('stats consumer deterministically converges to latest event state when five lifecycle events are published in shuffled orders concurrently', async () => {
    const logger = createLogger({ serviceName: 'test-analytics-shuffled', level: 'silent' });
    const validator = createEventValidator(config);
    const consumers = createAnalyticsConsumers({
      config,
      pool: rwPool,
      rabbitClient,
      validator,
      logger
    });
    await consumers.start();
    activeConsumers.push(consumers);

    const pub = rabbitClient.createPublisher({ confirms: true });

    // We test 3 distinct reports with 3 different shuffled permutations of the 5 events
    const permutations = [
      [4, 2, 0, 3, 1], // Resolved, Assigned, Submitted, In Progress, Verified
      [3, 4, 1, 0, 2], // In Progress, Resolved, Verified, Submitted, Assigned
      [2, 3, 0, 4, 1] // Assigned, In Progress, Submitted, Resolved, Verified
    ];

    const reportIds: string[] = [];
    const baseTime = Date.now() - 100000000;

    for (let pIdx = 0; pIdx < permutations.length; pIdx++) {
      const reportId = crypto.randomUUID();
      reportIds.push(reportId);
      const perm = permutations[pIdx];

      const submittedAt = new Date(baseTime + pIdx * 10000000).toISOString();
      const verifiedAt = new Date(baseTime + pIdx * 10000000 + 1000000).toISOString();
      const assignedAt = new Date(baseTime + pIdx * 10000000 + 2000000).toISOString();
      const inProgressAt = new Date(baseTime + pIdx * 10000000 + 3000000).toISOString();
      const resolvedAt = new Date(baseTime + pIdx * 10000000 + 4000000).toISOString();

      const events = [
        // 0: submitted
        {
          routingKey: 'report.submitted',
          message: {
            eventId: crypto.randomUUID(),
            eventType: 'report.submitted',
            version: 1,
            occurredAt: submittedAt,
            correlationId: crypto.randomUUID(),
            payload: {
              reportId,
              reporterId: crypto.randomUUID(),
              title: `Shuffled Pothole ${pIdx}`,
              description: 'Concurrent race test',
              category: 'pothole',
              location: { lat: 23.0, lng: 72.0 },
              submittedAt
            }
          }
        },
        // 1: Verified
        {
          routingKey: 'report.status-changed',
          message: {
            eventId: crypto.randomUUID(),
            eventType: 'report.status-changed',
            version: 1,
            occurredAt: verifiedAt,
            correlationId: crypto.randomUUID(),
            payload: {
              reportId,
              fromStatus: 'Submitted',
              toStatus: 'Verified',
              changedBy: crypto.randomUUID(),
              changedAt: verifiedAt
            }
          }
        },
        // 2: Assigned
        {
          routingKey: 'report.status-changed',
          message: {
            eventId: crypto.randomUUID(),
            eventType: 'report.status-changed',
            version: 1,
            occurredAt: assignedAt,
            correlationId: crypto.randomUUID(),
            payload: {
              reportId,
              fromStatus: 'Verified',
              toStatus: 'Assigned',
              changedBy: crypto.randomUUID(),
              changedAt: assignedAt
            }
          }
        },
        // 3: In Progress
        {
          routingKey: 'report.status-changed',
          message: {
            eventId: crypto.randomUUID(),
            eventType: 'report.status-changed',
            version: 1,
            occurredAt: inProgressAt,
            correlationId: crypto.randomUUID(),
            payload: {
              reportId,
              fromStatus: 'Assigned',
              toStatus: 'In Progress',
              changedBy: crypto.randomUUID(),
              changedAt: inProgressAt
            }
          }
        },
        // 4: Resolved (latest timestamp)
        {
          routingKey: 'report.status-changed',
          message: {
            eventId: crypto.randomUUID(),
            eventType: 'report.status-changed',
            version: 1,
            occurredAt: resolvedAt,
            correlationId: crypto.randomUUID(),
            payload: {
              reportId,
              fromStatus: 'In Progress',
              toStatus: 'Resolved',
              changedBy: crypto.randomUUID(),
              changedAt: resolvedAt
            }
          }
        }
      ];

      // Reorder by permutation and send concurrently
      const shuffled = perm.map((idx) => events[idx]);
      await Promise.all(
        shuffled.map((e) =>
          pub.send({ exchange: 'civic.events', routingKey: e.routingKey }, e.message)
        )
      );
    }

    // Assert that for ALL reports, the final converged status is 'Resolved' and resolved_at matches resolvedAt
    for (let pIdx = 0; pIdx < permutations.length; pIdx++) {
      const reportId = reportIds[pIdx];
      const expectedResolvedAtMs = baseTime + pIdx * 10000000 + 4000000;

      const row = await pollUntil(async () => {
        const res = await rwPool.query<{
          current_status: string;
          category: string;
          resolved_at: Date | null;
        }>(
          'SELECT current_status, category, resolved_at FROM report_index WHERE report_id = $1 AND current_status = $2 AND resolved_at IS NOT NULL AND category != $3',
          [reportId, 'Resolved', 'unknown']
        );
        return res.rows.length > 0 ? res.rows[0] : null;
      });

      expect(row.current_status).toBe('Resolved');
      expect(row.category).toBe('pothole');
      expect(new Date(row.resolved_at!).getTime()).toBe(expectedResolvedAtMs);
    }

    // Verify summary counts match
    const officerToken = await createJwt(crypto.randomUUID(), 'officer');
    const res = await request(app.server)
      .get('/api/v1/analytics/summary')
      .set('Authorization', `Bearer ${officerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.byStatus.Resolved).toBeGreaterThanOrEqual(permutations.length);
    expect(res.body.byCategory.pothole).toBeGreaterThanOrEqual(permutations.length);

    await consumers.stop();
  });

  it('handles status events arriving before report.submitted and counts unknown category honestly in summary', async () => {
    const logger = createLogger({ serviceName: 'test-analytics-placeholder', level: 'silent' });
    const validator = createEventValidator(config);
    const consumers = createAnalyticsConsumers({
      config,
      pool: rwPool,
      rabbitClient,
      validator,
      logger
    });
    await consumers.start();
    activeConsumers.push(consumers);

    const reportId = crypto.randomUUID();
    const pub = rabbitClient.createPublisher({ confirms: true });

    const statusChangedTime = new Date(Date.now() - 5000000).toISOString();

    // 1. Send status event before report.submitted exists
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.status-changed' },
      {
        eventId: crypto.randomUUID(),
        eventType: 'report.status-changed',
        version: 1,
        occurredAt: statusChangedTime,
        correlationId: crypto.randomUUID(),
        payload: {
          reportId,
          fromStatus: 'Assigned',
          toStatus: 'In Progress',
          changedBy: crypto.randomUUID(),
          changedAt: statusChangedTime
        }
      }
    );

    // 2. Poll until placeholder row is present with category 'unknown'
    const placeholderRow = await pollUntil(async () => {
      const res = await rwPool.query<{
        category: string;
        current_status: string;
      }>('SELECT category, current_status FROM report_index WHERE report_id = $1', [reportId]);
      return res.rows.length > 0 ? res.rows[0] : null;
    });

    expect(placeholderRow.category).toBe('unknown');
    expect(placeholderRow.current_status).toBe('In Progress');

    // 3. Summary shows 'unknown' category count honestly
    const officerToken = await createJwt(crypto.randomUUID(), 'officer');
    const summaryBefore = await request(app.server)
      .get('/api/v1/analytics/summary')
      .set('Authorization', `Bearer ${officerToken}`);

    expect(summaryBefore.status).toBe(200);
    expect(summaryBefore.body.byCategory.unknown).toBeGreaterThanOrEqual(1);

    // 4. Later, report.submitted lands
    const submittedTime = new Date(Date.now() - 10000000).toISOString();
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.submitted' },
      {
        eventId: crypto.randomUUID(),
        eventType: 'report.submitted',
        version: 1,
        occurredAt: submittedTime,
        correlationId: crypto.randomUUID(),
        payload: {
          reportId,
          reporterId: crypto.randomUUID(),
          title: 'Streetlight out',
          description: 'Dark corner',
          category: 'streetlight',
          location: { lat: 23.0, lng: 72.0 },
          submittedAt: submittedTime
        }
      }
    );

    // 5. Poll until category transitions to 'streetlight' while keeping status 'In Progress'
    const updatedRow = await pollUntil(async () => {
      const res = await rwPool.query<{
        category: string;
        current_status: string;
      }>(
        'SELECT category, current_status FROM report_index WHERE report_id = $1 AND category = $2',
        [reportId, 'streetlight']
      );
      return res.rows.length > 0 ? res.rows[0] : null;
    });

    expect(updatedRow.category).toBe('streetlight');
    expect(updatedRow.current_status).toBe('In Progress'); // Must NOT be overwritten back to 'Submitted'

    // 6. Summary now counts under 'streetlight'
    const summaryAfter = await request(app.server)
      .get('/api/v1/analytics/summary')
      .set('Authorization', `Bearer ${officerToken}`);

    expect(summaryAfter.status).toBe(200);
    expect(summaryAfter.body.byCategory.streetlight).toBeGreaterThanOrEqual(1);

    await consumers.stop();
  });

  it('role checks: citizen 403, officer summary 200, officer audit 403, admin both 200', async () => {
    const citizenToken = await createJwt(crypto.randomUUID(), 'citizen');
    const officerToken = await createJwt(crypto.randomUUID(), 'officer');
    const adminToken = await createJwt(crypto.randomUUID(), 'admin');

    // Citizen -> summary: 403
    const citSummary = await request(app.server)
      .get('/api/v1/analytics/summary')
      .set('Authorization', `Bearer ${citizenToken}`);
    expect(citSummary.status).toBe(403);

    // Citizen -> audit: 403
    const citAudit = await request(app.server)
      .get('/api/v1/analytics/audit')
      .set('Authorization', `Bearer ${citizenToken}`);
    expect(citAudit.status).toBe(403);

    // Officer -> summary: 200
    const offSummary = await request(app.server)
      .get('/api/v1/analytics/summary')
      .set('Authorization', `Bearer ${officerToken}`);
    expect(offSummary.status).toBe(200);

    // Officer -> audit: 403
    const offAudit = await request(app.server)
      .get('/api/v1/analytics/audit')
      .set('Authorization', `Bearer ${officerToken}`);
    expect(offAudit.status).toBe(403);

    // Admin -> summary: 200
    const admSummary = await request(app.server)
      .get('/api/v1/analytics/summary')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(admSummary.status).toBe(200);

    // Admin -> audit: 200
    const admAudit = await request(app.server)
      .get('/api/v1/analytics/audit')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(admAudit.status).toBe(200);
  });

  it('JWT edge cases: missing token (401), invalid signature (401), expired (401), wrong issuer/aud (401)', async () => {
    // Missing token
    const noToken = await request(app.server).get('/api/v1/analytics/summary');
    expect(noToken.status).toBe(401);

    // Foreign key (invalid signature)
    const badKeyToken = await createJwt(crypto.randomUUID(), 'admin', { foreignKey: true });
    const badKeyRes = await request(app.server)
      .get('/api/v1/analytics/summary')
      .set('Authorization', `Bearer ${badKeyToken}`);
    expect(badKeyRes.status).toBe(401);

    // Expired token
    const expiredToken = await createJwt(crypto.randomUUID(), 'admin', { exp: '-1s' });
    const expRes = await request(app.server)
      .get('/api/v1/analytics/summary')
      .set('Authorization', `Bearer ${expiredToken}`);
    expect(expRes.status).toBe(401);

    // Wrong issuer
    const wrongIssToken = await createJwt(crypto.randomUUID(), 'admin', { iss: 'wrong-issuer' });
    const issRes = await request(app.server)
      .get('/api/v1/analytics/summary')
      .set('Authorization', `Bearer ${wrongIssToken}`);
    expect(issRes.status).toBe(401);

    // Wrong audience
    const wrongAudToken = await createJwt(crypto.randomUUID(), 'admin', { aud: 'wrong-audience' });
    const audRes = await request(app.server)
      .get('/api/v1/analytics/summary')
      .set('Authorization', `Bearer ${wrongAudToken}`);
    expect(audRes.status).toBe(401);
  });

  it('audit response contains envelope fields plus payload and never raw passwords or tokens', async () => {
    const adminToken = await createJwt(crypto.randomUUID(), 'admin');

    const res = await request(app.server)
      .get('/api/v1/analytics/audit?page=1&pageSize=10')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);

    const firstItem = res.body.items[0];
    const allowedKeys = new Set([
      'id',
      'eventId',
      'eventType',
      'version',
      'correlationId',
      'occurredAt',
      'receivedAt',
      'actor',
      'subjectType',
      'subjectId',
      'payload'
    ]);

    for (const key of Object.keys(firstItem)) {
      expect(allowedKeys.has(key)).toBe(true);
    }

    const jsonStr = JSON.stringify(res.body);
    expect(jsonStr).not.toContain('password');
    expect(jsonStr).not.toContain('refreshToken');
    expect(jsonStr).not.toContain('jwt');

    // Test with all query filters: eventType, subjectId, from, to
    const filteredRes = await app.inject({
      method: 'GET',
      url: `/api/v1/analytics/audit?page=1&pageSize=10&eventType=user.created&subjectId=${firstItem.subjectId}&from=2020-01-01T00:00:00Z&to=2099-01-01T00:00:00Z`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(filteredRes.statusCode).toBe(200);

    // Test validation error handling (400 Problem Details)
    const badQueryRes = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/audit?page=0',
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(badQueryRes.statusCode).toBe(400);
    expect(badQueryRes.headers['content-type']).toContain('application/problem+json');
  });

  it('responds to /healthz and /readyz, including 503 when degraded', async () => {
    const healthRes = await app.inject({ method: 'GET', url: '/healthz' });
    expect(healthRes.statusCode).toBe(200);

    const readyRes = await app.inject({ method: 'GET', url: '/readyz' });
    expect(readyRes.statusCode).toBe(200);

    const degradedApp = await buildApp(config, {
      pool: rwPool,
      isRabbitReady: () => false,
      areConsumersReady: () => false
    });
    const degradedRes = await degradedApp.inject({ method: 'GET', url: '/readyz' });
    expect(degradedRes.statusCode).toBe(503);
    await degradedApp.close();
  });

  it('DLQ behaviour for an invalid envelope in analytics.audit', async () => {
    const logger = createLogger({ serviceName: 'test-analytics-dlq', level: 'silent' });
    const validator = createEventValidator(config);
    const consumers = createAnalyticsConsumers({
      config,
      pool: rwPool,
      rabbitClient,
      validator,
      logger
    });
    await consumers.start();
    activeConsumers.push(consumers);

    const badEnvelope = {
      // Missing eventId, version, occurredAt, correlationId
      eventType: 'invalid.event',
      payload: { some: 'data' }
    };

    const pub = rabbitClient.createPublisher({ confirms: true });
    await pub.send({ exchange: 'civic.events', routingKey: 'invalid.event' }, badEnvelope);

    let dlqMsg: AsyncMessage | null = null;
    for (let i = 0; i < 30; i++) {
      dlqMsg = await rabbitClient.basicGet('analytics.audit.dlq');
      if (dlqMsg) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(dlqMsg).not.toBeNull();
    await consumers.stop();
  });

  it('matches committed contracts/openapi/analytics.v1.openapi.json (OpenAPI drift test)', () => {
    const candidatePaths = [
      resolve(process.cwd(), 'contracts/openapi/analytics.v1.openapi.json'),
      resolve(process.cwd(), '../../contracts/openapi/analytics.v1.openapi.json')
    ];

    const targetPath = candidatePaths.find((p) => existsSync(p));
    expect(targetPath).toBeDefined();

    const committedSpec = readFileSync(targetPath!, 'utf8');

    function sortKeys(obj: unknown): unknown {
      if (obj === null || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(sortKeys);
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
        sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
      }
      return sorted;
    }

    const currentSpec = app.swagger();
    const currentJson = JSON.stringify(sortKeys(currentSpec), null, 2) + '\n';

    expect(currentJson).toBe(committedSpec);
  });
});
