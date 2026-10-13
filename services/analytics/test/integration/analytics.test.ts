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
    let updateErr: any = null;
    try {
      await ownerPool.query(`UPDATE audit_log SET actor = 'owner_update' WHERE event_id = $1`, [
        eventId
      ]);
    } catch (err: any) {
      updateErr = err;
    }
    expect(updateErr).not.toBeNull();
    expect(updateErr.code).toBe('55000');

    // 5. Owner role attempts DELETE (trigger raises 55000)
    let deleteErr: any = null;
    try {
      await ownerPool.query(`DELETE FROM audit_log WHERE event_id = $1`, [eventId]);
    } catch (err: any) {
      deleteErr = err;
    }
    expect(deleteErr).not.toBeNull();
    expect(deleteErr.code).toBe('55000');

    // 6. Owner role attempts TRUNCATE (trigger raises 55000)
    let truncErr: any = null;
    try {
      await ownerPool.query(`TRUNCATE audit_log`);
    } catch (err: any) {
      truncErr = err;
    }
    expect(truncErr).not.toBeNull();
    expect(truncErr.code).toBe('55000');
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
    let auditRow: any = null;
    for (let i = 0; i < 30; i++) {
      const res = await rwPool.query('SELECT * FROM audit_log WHERE event_id = $1', [eventId]);
      if (res.rows.length > 0) {
        auditRow = res.rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

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

    // 1. report.submitted
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.submitted' },
      {
        eventId: crypto.randomUUID(),
        eventType: 'report.submitted',
        version: 1,
        occurredAt: new Date(Date.now() - 36000000).toISOString(), // 10h ago
        correlationId: crypto.randomUUID(),
        payload: {
          reportId,
          reporterId: crypto.randomUUID(),
          title: 'Pothole on Main St',
          description: 'Deep hole',
          category: 'pothole',
          location: { lat: 23.0, lng: 72.0 },
          submittedAt: new Date(Date.now() - 36000000).toISOString()
        }
      }
    );

    // Wait for report_index insertion
    for (let i = 0; i < 30; i++) {
      const res = await rwPool.query('SELECT * FROM report_index WHERE report_id = $1', [reportId]);
      if (res.rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    // 2. Verified
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.status-changed' },
      {
        eventId: crypto.randomUUID(),
        eventType: 'report.status-changed',
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId: crypto.randomUUID(),
        payload: {
          reportId,
          fromStatus: 'Submitted',
          toStatus: 'Verified',
          changedBy: crypto.randomUUID(),
          changedAt: new Date().toISOString()
        }
      }
    );

    // 3. Assigned
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.status-changed' },
      {
        eventId: crypto.randomUUID(),
        eventType: 'report.status-changed',
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId: crypto.randomUUID(),
        payload: {
          reportId,
          fromStatus: 'Verified',
          toStatus: 'Assigned',
          changedBy: crypto.randomUUID(),
          changedAt: new Date().toISOString()
        }
      }
    );

    // 4. In Progress
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.status-changed' },
      {
        eventId: crypto.randomUUID(),
        eventType: 'report.status-changed',
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId: crypto.randomUUID(),
        payload: {
          reportId,
          fromStatus: 'Assigned',
          toStatus: 'In Progress',
          changedBy: crypto.randomUUID(),
          changedAt: new Date().toISOString()
        }
      }
    );

    // 5. Resolved
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.status-changed' },
      {
        eventId: crypto.randomUUID(),
        eventType: 'report.status-changed',
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId: crypto.randomUUID(),
        payload: {
          reportId,
          fromStatus: 'In Progress',
          toStatus: 'Resolved',
          changedBy: crypto.randomUUID(),
          changedAt: new Date().toISOString()
        }
      }
    );

    // Wait for resolved_at to be set
    let resolvedRow: any = null;
    for (let i = 0; i < 30; i++) {
      const res = await rwPool.query(
        'SELECT * FROM report_index WHERE report_id = $1 AND resolved_at IS NOT NULL',
        [reportId]
      );
      if (res.rows.length > 0) {
        resolvedRow = res.rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(resolvedRow).not.toBeNull();
    expect(resolvedRow.current_status).toBe('Resolved');

    // 6. Reopened
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.status-changed' },
      {
        eventId: crypto.randomUUID(),
        eventType: 'report.status-changed',
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId: crypto.randomUUID(),
        payload: {
          reportId,
          fromStatus: 'Resolved',
          toStatus: 'Reopened',
          changedBy: crypto.randomUUID(),
          changedAt: new Date().toISOString()
        }
      }
    );

    // Wait for resolved_at to be cleared
    for (let i = 0; i < 30; i++) {
      const res = await rwPool.query(
        'SELECT * FROM report_index WHERE report_id = $1 AND current_status = $2',
        [reportId, 'Reopened']
      );
      if (res.rows.length > 0 && res.rows[0].resolved_at === null) {
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

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
