import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { Connection, AsyncMessage } from 'rabbitmq-client';
import { SignJWT, KeyLike } from 'jose';
import { PINNED_IMAGES } from '../support/images.js';
import { runMigrations } from '../../src/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig, Config } from '../../src/config.js';
import { createOutboxRelay, OutboxRelay } from '../../src/outbox/relay.js';
import { createLogger } from '../../src/logger.js';
import { createEventValidator } from '../../src/events/validator.js';

describe('Report Service Integration Tests (Testcontainers PostGIS & RabbitMQ)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let rabbitContainer: StartedRabbitMQContainer;
  let pool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let config: Config;
  let outboxRelay: OutboxRelay;
  let rabbitClient: Connection;
  let testPrivateKey: crypto.KeyObject;
  let testPublicKeyB64: string;
  let migrationsDir: string;

  async function createJwt(
    userId: string,
    role: string,
    options: { exp?: string; aud?: string; alg?: string; foreignKey?: boolean } = {}
  ): Promise<string> {
    if (options.alg === 'none') {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: userId,
          role,
          iss: 'civic-auth',
          aud: options.aud || 'civic-api',
          exp: Math.floor(Date.now() / 1000) + 900
        })
      ).toString('base64url');
      return `${header}.${payload}.`;
    }

    const signerKey = options.foreignKey
      ? crypto.generateKeyPairSync('ed25519').privateKey
      : testPrivateKey;

    const jwt = new SignJWT({ role })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(userId)
      .setIssuer('civic-auth')
      .setAudience(options.aud || 'civic-api')
      .setIssuedAt()
      .setExpirationTime(options.exp || '15m');

    return await jwt.sign(signerKey as unknown as KeyLike);
  }

  beforeAll(async () => {
    // 1. Generate Ed25519 keypair for tests
    const keyPair = crypto.generateKeyPairSync('ed25519');
    testPrivateKey = keyPair.privateKey;
    const pubPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    testPublicKeyB64 = Buffer.from(pubPem).toString('base64');

    // 2. Start PostgreSQL/PostGIS Container using pinned image
    pgContainer = await new PostgreSqlContainer(PINNED_IMAGES.postgres)
      .withDatabase('civic_report_test')
      .withUsername('test_user')
      .withPassword('test_password')
      .start();

    // 3. Start RabbitMQ Container
    rabbitContainer = await new RabbitMQContainer(PINNED_IMAGES.rabbitmq)
      .withEnvironment({
        RABBITMQ_DEFAULT_USER: 'civic_test',
        RABBITMQ_DEFAULT_PASS: 'civic_test_pass'
      })
      .start();

    const rabbitUrl = `amqp://civic_test:civic_test_pass@${rabbitContainer.getHost()}:${rabbitContainer.getMappedPort(5672)}`;

    pool = new pg.Pool({
      host: pgContainer.getHost(),
      port: pgContainer.getPort(),
      database: pgContainer.getDatabase(),
      user: pgContainer.getUsername(),
      password: pgContainer.getPassword()
    });

    migrationsDir = resolve(process.cwd(), 'migrations');
    if (!existsSync(migrationsDir)) {
      migrationsDir = resolve(process.cwd(), 'services/report/migrations');
    }

    // 4. Run database migrations
    await runMigrations(pool, migrationsDir);

    // 5. Build configuration
    config = loadConfig({
      SERVICE_NAME: 'report-test',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      DB_HOST: pgContainer.getHost(),
      DB_PORT: String(pgContainer.getPort()),
      DB_NAME: pgContainer.getDatabase(),
      DB_USER: pgContainer.getUsername(),
      DB_PASSWORD: pgContainer.getPassword(),
      RABBITMQ_URL: rabbitUrl,
      JWT_PUBLIC_KEY_B64: testPublicKeyB64,
      JWT_ISSUER: 'civic-auth',
      JWT_AUDIENCE: 'civic-api',
      OUTBOX_INTERVAL_MS: '200',
      CONTRACTS_DIR: resolve(process.cwd(), '../../contracts')
    });

    rabbitClient = new Connection(rabbitUrl);
    rabbitClient.on('error', () => {});
    await rabbitClient.onConnect();

    const logger = createLogger({ serviceName: 'test', level: 'silent' });
    outboxRelay = createOutboxRelay({
      config,
      pool,
      logger,
      rabbitmqConnection: rabbitClient
    });

    app = await buildApp(config, {
      pool,
      isRabbitReady: () => true
    });
    await app.ready();
  }, 240000);

  afterAll(async () => {
    if (outboxRelay) await outboxRelay.stop().catch(() => {});
    if (app) await app.close().catch(() => {});
    if (pool) await pool.end().catch(() => {});
    if (rabbitClient) await rabbitClient.close().catch(() => {});
    if (pgContainer) await pgContainer.stop().catch(() => {});
    if (rabbitContainer) await rabbitContainer.stop().catch(() => {});
  }, 60000);

  it('creates report (201) with history row and validated outbox event', async () => {
    const citizenId = crypto.randomUUID();
    const token = await createJwt(citizenId, 'citizen');

    const res = await request(app.server)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Huge pothole on Ring Road',
        description: 'Deep crater causing traffic slowdown and tire damage',
        category: 'pothole',
        location: {
          lat: 23.0331234,
          lng: 72.5851234,
          address: 'Ring Road Junction'
        }
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.reporterId).toBe(citizenId);
    expect(res.body.title).toBe('Huge pothole on Ring Road');
    expect(res.body.category).toBe('pothole');
    expect(res.body.status).toBe('Submitted');
    expect(res.body.version).toBe(1);

    const reportId = res.body.id;

    // Check history row
    const historyRes = await pool.query('SELECT * FROM status_history WHERE report_id = $1', [
      reportId
    ]);
    expect(historyRes.rows.length).toBe(1);
    expect(historyRes.rows[0].from_status).toBeNull();
    expect(historyRes.rows[0].to_status).toBe('Submitted');
    expect(historyRes.rows[0].changed_by).toBe(citizenId);

    // Check outbox row
    const outboxRes = await pool.query(
      `SELECT * FROM outbox_events WHERE event_type = 'report.submitted' AND payload->>'reportId' = $1`,
      [reportId]
    );
    expect(outboxRes.rows.length).toBe(1);
    expect(outboxRes.rows[0].event_type).toBe('report.submitted');
  });

  it('rejects invalid category and bad coordinates with 400', async () => {
    const citizenId = crypto.randomUUID();
    const token = await createJwt(citizenId, 'citizen');

    // Invalid category
    const catRes = await request(app.server)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Valid title',
        description: 'Valid desc',
        category: 'non-existent-category',
        location: { lat: 23.0, lng: 72.0 }
      });
    expect(catRes.status).toBe(400);
    expect(catRes.body.code).toBe('invalid_category');

    // Bad latitude (>90)
    const badLatRes = await request(app.server)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Valid title',
        description: 'Valid desc',
        category: 'pothole',
        location: { lat: 95.0, lng: 72.0 }
      });
    expect(badLatRes.status).toBe(400);
    expect(badLatRes.body.code).toBe('validation_error');

    // Bad longitude (>180)
    const badLngRes = await request(app.server)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Valid title',
        description: 'Valid desc',
        category: 'pothole',
        location: { lat: 23.0, lng: 185.0 }
      });
    expect(badLngRes.status).toBe(400);
    expect(badLngRes.body.code).toBe('validation_error');
  });

  it('supports idempotent create via Idempotency-Key header', async () => {
    const citizenId = crypto.randomUUID();
    const token = await createJwt(citizenId, 'citizen');
    const idempKey = `test-key-${Date.now()}`;

    const payload = {
      title: 'Broken lamp post',
      description: 'Streetlight is down',
      category: 'streetlight',
      location: { lat: 23.05, lng: 72.55 }
    };

    // First request
    const firstRes = await request(app.server)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempKey)
      .send(payload);

    expect(firstRes.status).toBe(201);
    const firstId = firstRes.body.id;

    // Second request with same idempotency key
    const secondRes = await request(app.server)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempKey)
      .send(payload);

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.id).toBe(firstId);

    // Verify database only created one report row
    const countRes = await pool.query('SELECT count(*)::int as count FROM reports WHERE id = $1', [
      firstId
    ]);
    expect(countRes.rows[0].count).toBe(1);
  });

  it('mine endpoint returns only caller reports and detail ownership rules apply', async () => {
    const citizenA = crypto.randomUUID();
    const citizenB = crypto.randomUUID();
    const officer = crypto.randomUUID();
    const admin = crypto.randomUUID();

    const tokenA = await createJwt(citizenA, 'citizen');
    const tokenB = await createJwt(citizenB, 'citizen');
    const tokenOfficer = await createJwt(officer, 'officer');
    const tokenAdmin = await createJwt(admin, 'admin');

    // Citizen A creates report A
    const resA = await request(app.server)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        title: 'Report of Citizen A',
        description: 'Details A',
        category: 'garbage',
        location: { lat: 23.01, lng: 72.51 }
      });
    const idA = resA.body.id;

    // Citizen B creates report B
    const resB = await request(app.server)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        title: 'Report of Citizen B',
        description: 'Details B',
        category: 'garbage',
        location: { lat: 23.02, lng: 72.52 }
      });
    const idB = resB.body.id;

    // Citizen A GET /mine
    const mineA = await request(app.server)
      .get('/api/v1/reports/mine')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(mineA.status).toBe(200);
    const mineAIds = mineA.body.items.map((r: { id: string }) => r.id);
    expect(mineAIds).toContain(idA);
    expect(mineAIds).not.toContain(idB);

    // Citizen A views own report -> 200 with history
    const detailA = await request(app.server)
      .get(`/api/v1/reports/${idA}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(detailA.status).toBe(200);
    expect(detailA.body).toHaveProperty('history');
    expect(Array.isArray(detailA.body.history)).toBe(true);

    // Citizen B views Citizen A report -> 404 (not 403)
    const detailForbidden = await request(app.server)
      .get(`/api/v1/reports/${idA}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(detailForbidden.status).toBe(404);
    expect(detailForbidden.body.code).toBe('report_not_found');

    // Officer views Citizen A report -> 200
    const detailOfficer = await request(app.server)
      .get(`/api/v1/reports/${idA}`)
      .set('Authorization', `Bearer ${tokenOfficer}`);
    expect(detailOfficer.status).toBe(200);

    // Admin views Citizen A report -> 200
    const detailAdmin = await request(app.server)
      .get(`/api/v1/reports/${idA}`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    expect(detailAdmin.status).toBe(200);
  });

  it('enforces officer list permissions and filtering (DSH-02)', async () => {
    const citizen = crypto.randomUUID();
    const officer = crypto.randomUUID();
    const tokenCitizen = await createJwt(citizen, 'citizen');
    const tokenOfficer = await createJwt(officer, 'officer');

    // Citizen is refused
    const citizenList = await request(app.server)
      .get('/api/v1/reports')
      .set('Authorization', `Bearer ${tokenCitizen}`);
    expect(citizenList.status).toBe(403);
    expect(citizenList.body.code).toBe('forbidden');

    // Officer is allowed
    const officerList = await request(app.server)
      .get('/api/v1/reports?category=garbage')
      .set('Authorization', `Bearer ${tokenOfficer}`);
    expect(officerList.status).toBe(200);
    expect(officerList.body).toHaveProperty('items');
    expect(officerList.body).toHaveProperty('pagination');

    // Test department, ward, and q filters
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    await pool.query(
      `INSERT INTO reports (id, reporter_id, title, description, category_slug, lat, lng, status, version, ward_code, department_code, created_at, updated_at)
       VALUES ($1, $3, 'Dangerous deep pothole on road', 'desc', 'pothole', 23.0, 72.0, 'Submitted', 1, 'WARD-001', 'ROADS', NOW(), NOW()),
              ($2, $3, 'Broken water pipeline leaking', 'desc', 'water-leak', 23.1, 72.1, 'Submitted', 1, 'WARD-002', 'WATER', NOW(), NOW())`,
      [id1, id2, citizen]
    );

    // Test department filter
    const deptList = await request(app.server)
      .get('/api/v1/reports?department=ROADS')
      .set('Authorization', `Bearer ${tokenOfficer}`);
    expect(deptList.status).toBe(200);
    expect(deptList.body.items.some((r: { id: string }) => r.id === id1)).toBe(true);
    expect(deptList.body.items.some((r: { id: string }) => r.id === id2)).toBe(false);

    // Test ward filter
    const wardList = await request(app.server)
      .get('/api/v1/reports?ward=WARD-002')
      .set('Authorization', `Bearer ${tokenOfficer}`);
    expect(wardList.status).toBe(200);
    expect(wardList.body.items.some((r: { id: string }) => r.id === id2)).toBe(true);
    expect(wardList.body.items.some((r: { id: string }) => r.id === id1)).toBe(false);

    // Test q search filter (case-insensitive substring)
    const qList = await request(app.server)
      .get('/api/v1/reports?q=POTHOLE')
      .set('Authorization', `Bearer ${tokenOfficer}`);
    expect(qList.status).toBe(200);
    expect(qList.body.items.some((r: { id: string }) => r.id === id1)).toBe(true);
    expect(qList.body.items.some((r: { id: string }) => r.id === id2)).toBe(false);

    // Verify response includes reporterId only and NOT reporter display name
    const sampleItem = deptList.body.items.find((r: { id: string }) => r.id === id1);
    expect(sampleItem).toHaveProperty('reporterId');
    expect(sampleItem).not.toHaveProperty('reporterDisplayName');
    expect(sampleItem).not.toHaveProperty('displayName');
  });

  it('exercises full lifecycle of status transitions via API with authorization and rejection rules', async () => {
    const citizen = crypto.randomUUID();
    const officer = crypto.randomUUID();
    const admin = crypto.randomUUID();

    const tokenCitizen = await createJwt(citizen, 'citizen');
    const tokenOfficer = await createJwt(officer, 'officer');
    const tokenAdmin = await createJwt(admin, 'admin');

    // 1. Citizen creates report -> Submitted
    const createRes = await request(app.server)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${tokenCitizen}`)
      .send({
        title: 'Water pipe burst',
        description: 'Water gushing on street',
        category: 'water-leak',
        location: { lat: 23.03, lng: 72.53 }
      });
    const reportId = createRes.body.id;
    expect(createRes.body.status).toBe('Submitted');

    // Citizen cannot Verify (forbidden role)
    const citVerify = await request(app.server)
      .post(`/api/v1/reports/${reportId}/status`)
      .set('Authorization', `Bearer ${tokenCitizen}`)
      .send({ toStatus: 'Verified' });
    expect(citVerify.status).toBe(403);
    expect(citVerify.body.code).toBe('forbidden_transition');

    // Officer can Verify -> 200
    const offVerify = await request(app.server)
      .post(`/api/v1/reports/${reportId}/status`)
      .set('Authorization', `Bearer ${tokenOfficer}`)
      .send({ toStatus: 'Verified', note: 'Inspected on site' });
    expect(offVerify.status).toBe(200);
    expect(offVerify.body.status).toBe('Verified');
    expect(offVerify.body.version).toBe(2);

    // From Verified, Officer cannot move to In Progress directly (forbidden pair) -> 409
    const forbiddenPair = await request(app.server)
      .post(`/api/v1/reports/${reportId}/status`)
      .set('Authorization', `Bearer ${tokenOfficer}`)
      .send({ toStatus: 'In Progress' });
    expect(forbiddenPair.status).toBe(409);
    expect(forbiddenPair.body.code).toBe('forbidden_transition');

    // Rejection without reasonCode fails with 400
    const rejectNoReason = await request(app.server)
      .post(`/api/v1/reports/${reportId}/status`)
      .set('Authorization', `Bearer ${tokenOfficer}`)
      .send({ toStatus: 'Rejected' });
    expect(rejectNoReason.status).toBe(400);

    // Admin Assigns -> 200
    const adminAssign = await request(app.server)
      .post(`/api/v1/reports/${reportId}/status`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ toStatus: 'Assigned' });
    expect(adminAssign.status).toBe(200);
    expect(adminAssign.body.status).toBe('Assigned');

    // Officer moves to In Progress -> 200
    const offProgress = await request(app.server)
      .post(`/api/v1/reports/${reportId}/status`)
      .set('Authorization', `Bearer ${tokenOfficer}`)
      .send({ toStatus: 'In Progress' });
    expect(offProgress.status).toBe(200);
    expect(offProgress.body.status).toBe('In Progress');

    // Officer moves to Resolved -> 200
    const offResolved = await request(app.server)
      .post(`/api/v1/reports/${reportId}/status`)
      .set('Authorization', `Bearer ${tokenOfficer}`)
      .send({ toStatus: 'Resolved', note: 'Leak repaired' });
    expect(offResolved.status).toBe(200);
    expect(offResolved.body.status).toBe('Resolved');

    // Citizen reopens own report -> 200
    const citReopen = await request(app.server)
      .post(`/api/v1/reports/${reportId}/status`)
      .set('Authorization', `Bearer ${tokenCitizen}`)
      .send({ toStatus: 'Reopened', note: 'Water is leaking again' });
    expect(citReopen.status).toBe(200);
    expect(citReopen.body.status).toBe('Reopened');

    // Check status_history entries
    const historyRes = await pool.query(
      'SELECT from_status, to_status, changed_by FROM status_history WHERE report_id = $1 ORDER BY changed_at ASC, id ASC',
      [reportId]
    );
    expect(historyRes.rows.length).toBe(6);
    expect(historyRes.rows.map((r) => r.to_status)).toEqual([
      'Submitted',
      'Verified',
      'Assigned',
      'In Progress',
      'Resolved',
      'Reopened'
    ]);
  });

  it('maintains atomicity: if outbox validation fails, no report or history is committed', async () => {
    const failingValidator = {
      validateEvent: () => {
        throw new Error('Forced outbox failure for atomicity test');
      }
    };

    const failingApp = await buildApp(config, {
      pool,
      eventValidator: failingValidator,
      isRabbitReady: () => true
    });
    await failingApp.ready();

    const citizen = crypto.randomUUID();
    const token = await createJwt(citizen, 'citizen');

    const uniqueTitle = `Atomic test title ${Date.now()}`;
    const res = await request(failingApp.server)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: uniqueTitle,
        description: 'Should not commit',
        category: 'pothole',
        location: { lat: 23.0, lng: 72.0 }
      });

    expect(res.status).toBe(500);

    const reportCheck = await pool.query('SELECT * FROM reports WHERE title = $1', [uniqueTitle]);
    expect(reportCheck.rows.length).toBe(0);

    await failingApp.close();
  });

  it('serves public list hiding reporter data, rounding coordinates, and filtering by bbox and open status', async () => {
    const citizen = crypto.randomUUID();
    const token = await createJwt(citizen, 'citizen');

    // Create report 1 in Ahmedabad center (lat: 23.0225678, lng: 72.5714678)
    const res1 = await request(app.server)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Public Report In Center',
        description: 'Inside bbox',
        category: 'streetlight',
        location: { lat: 23.0225678, lng: 72.5714678 }
      });
    const id1 = res1.body.id;

    // Public list request
    const pubList = await request(app.server).get('/api/v1/public/reports');
    expect(pubList.status).toBe(200);
    expect(pubList.body).toHaveProperty('items');

    const item1 = pubList.body.items.find((i: { id: string }) => i.id === id1);
    expect(item1).toBeDefined();
    // Reporter ID must NOT be present
    expect(item1).not.toHaveProperty('reporterId');
    expect(item1).not.toHaveProperty('reporter_id');
    // Coordinates rounded to 4 decimals
    expect(item1.lat).toBe(23.0226);
    expect(item1.lng).toBe(72.5715);

    // Bounding box query containing report 1: bbox=72.50,23.00,72.60,23.10
    const bboxIn = await request(app.server).get(
      '/api/v1/public/reports?bbox=72.50,23.00,72.60,23.10'
    );
    expect(bboxIn.status).toBe(200);
    const inIds = bboxIn.body.items.map((i: { id: string }) => i.id);
    expect(inIds).toContain(id1);

    // Far bounding box query: bbox=10.0,10.0,11.0,11.0
    const bboxFar = await request(app.server).get(
      '/api/v1/public/reports?bbox=10.0,10.0,11.0,11.0'
    );
    expect(bboxFar.status).toBe(200);
    const farIds = bboxFar.body.items.map((i: { id: string }) => i.id);
    expect(farIds).not.toContain(id1);

    // Public detail request
    const pubDetail = await request(app.server).get(`/api/v1/public/reports/${id1}`);
    expect(pubDetail.status).toBe(200);
    expect(pubDetail.body).toHaveProperty('timeline');
    expect(pubDetail.body.timeline[0]).not.toHaveProperty('changedBy');
    expect(pubDetail.body.timeline[0]).not.toHaveProperty('note');
    expect(pubDetail.body.lat).toBe(23.0226);
    expect(pubDetail.body.lng).toBe(72.5715);

    // Public categories
    const pubCat = await request(app.server).get('/api/v1/public/categories');
    expect(pubCat.status).toBe(200);
    expect(pubCat.body.length).toBeGreaterThanOrEqual(4);
  });

  it('relays outbox events to real RabbitMQ and validates consumed payloads against JSON Schemas', async () => {
    // Set up dedicated test consumer queue on RabbitMQ
    const testQueue = `test.report.subscriber.${Date.now()}`;
    const receivedMessages: Array<Record<string, unknown>> = [];

    const consumer = rabbitClient.createConsumer(
      {
        queue: testQueue,
        queueOptions: { durable: true, autoDelete: true },
        exchanges: [{ exchange: 'civic.events', type: 'topic', durable: true }],
        queueBindings: [
          { exchange: 'civic.events', routingKey: 'report.submitted' },
          { exchange: 'civic.events', routingKey: 'report.status-changed' }
        ]
      },
      async (msg: AsyncMessage) => {
        receivedMessages.push(msg.body);
      }
    );

    // Wait for consumer to be ready
    await new Promise<void>((resolve) => {
      consumer.on('ready', () => resolve());
      setTimeout(resolve, 500);
    });

    // Process pending outbox events through the relay
    const processed = await outboxRelay.processBatch();
    expect(processed).toBeGreaterThan(0);

    // Wait briefly for messages to arrive at consumer
    let attempts = 0;
    while (receivedMessages.length < 2 && attempts < 50) {
      await new Promise((r) => setTimeout(r, 100));
      attempts++;
    }

    expect(receivedMessages.length).toBeGreaterThanOrEqual(2);

    const validator = createEventValidator(config);
    for (const msg of receivedMessages) {
      expect(() => validator.validateEvent(msg.eventType as string, msg)).not.toThrow();
    }

    // Check that outbox published_at timestamps were updated
    const pendingCount = await pool.query(
      'SELECT count(*)::int as count FROM outbox_events WHERE published_at IS NULL'
    );
    expect(pendingCount.rows[0].count).toBe(0);

    await consumer.close();
  });

  it('rejects invalid, expired, forged, and missing JWTs with 401', async () => {
    const citizen = crypto.randomUUID();

    // 1. Missing Authorization header
    const missingRes = await request(app.server).get('/api/v1/reports/mine');
    expect(missingRes.status).toBe(401);
    expect(missingRes.body.code).toBe('unauthorized');

    // 2. Expired token
    const expiredToken = await createJwt(citizen, 'citizen', { exp: '-10s' });
    const expiredRes = await request(app.server)
      .get('/api/v1/reports/mine')
      .set('Authorization', `Bearer ${expiredToken}`);
    expect(expiredRes.status).toBe(401);
    expect(expiredRes.body.code).toBe('unauthorized');

    // 3. Wrong audience
    const wrongAudToken = await createJwt(citizen, 'citizen', { aud: 'wrong-audience' });
    const wrongAudRes = await request(app.server)
      .get('/api/v1/reports/mine')
      .set('Authorization', `Bearer ${wrongAudToken}`);
    expect(wrongAudRes.status).toBe(401);
    expect(wrongAudRes.body.code).toBe('unauthorized');

    // 4. Forged signature (signed with foreign private key)
    const forgedToken = await createJwt(citizen, 'citizen', { foreignKey: true });
    const forgedRes = await request(app.server)
      .get('/api/v1/reports/mine')
      .set('Authorization', `Bearer ${forgedToken}`);
    expect(forgedRes.status).toBe(401);
    expect(forgedRes.body.code).toBe('unauthorized');

    // 5. Alg none
    const algNoneToken = await createJwt(citizen, 'citizen', { alg: 'none' });
    const algNoneRes = await request(app.server)
      .get('/api/v1/reports/mine')
      .set('Authorization', `Bearer ${algNoneToken}`);
    expect(algNoneRes.status).toBe(401);
    expect(algNoneRes.body.code).toBe('unauthorized');
  });

  it('submits reports with photoIds, attaches ready photos from images_seen, and returns URLs', async () => {
    const citizen = crypto.randomUUID();
    const token = await createJwt(citizen, 'citizen');
    const photoId = crypto.randomUUID();

    // 1. Pre-seed images_seen as if image was processed before report creation
    await pool.query(
      `INSERT INTO images_seen (image_id, status, processed_at, width, height, gps_present, seen_at)
       VALUES ($1, 'ready', NOW(), 1600, 1200, true, NOW())`,
      [photoId]
    );

    // 2. Submit report with photoId
    const res = await request(app.server)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Broken streetlight with photo',
        description: 'See attached photo',
        category: 'pothole',
        location: { lat: 12.9716, lng: 77.5946 },
        photoIds: [photoId]
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('photos');
    expect(res.body.photos).toHaveLength(1);
    expect(res.body.photos[0]).toEqual({
      imageId: photoId,
      width: 1600,
      height: 1200,
      thumbnailUrl: `/api/v1/images/${photoId}/thumbnail`,
      url: `/api/v1/images/${photoId}/file`
    });

    const reportId = res.body.id;

    // 3. Verify GET /api/v1/reports/:id returns photos
    const getRes = await request(app.server)
      .get(`/api/v1/reports/${reportId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.photos).toHaveLength(1);
    expect(getRes.body.photos[0]).toEqual({
      imageId: photoId,
      width: 1600,
      height: 1200,
      thumbnailUrl: `/api/v1/images/${photoId}/thumbnail`,
      url: `/api/v1/images/${photoId}/file`
    });

    // Verify GET /api/v1/public/reports/:id also returns photos
    const publicRes = await request(app.server).get(`/api/v1/public/reports/${reportId}`);
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.photos).toHaveLength(1);
    expect(publicRes.body.photos[0]).toEqual({
      imageId: photoId,
      width: 1600,
      height: 1200,
      thumbnailUrl: `/api/v1/images/${photoId}/thumbnail`,
      url: `/api/v1/images/${photoId}/file`
    });

    // 4. Verify staged outbox event includes photoIds
    const outboxRes = await pool.query(
      `SELECT payload FROM outbox_events WHERE payload->>'reportId' = $1 AND event_type = 'report.submitted'`,
      [reportId]
    );
    expect(outboxRes.rows).toHaveLength(1);
    const outboxPayload = outboxRes.rows[0].payload;
    expect(outboxPayload.photoIds).toEqual([photoId]);

    // 5. Verify max 1 photo limit validation: 2 photos -> 400
    const tooManyPhotosRes = await request(app.server)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Too many photos',
        description: 'Two photos provided',
        category: 'pothole',
        location: { lat: 12.9716, lng: 77.5946 },
        photoIds: [photoId, crypto.randomUUID()]
      });
    expect(tooManyPhotosRes.status).toBe(400);
  });

  it('exercises relay lifecycle methods', async () => {
    expect(() => outboxRelay.start()).not.toThrow();
    expect(outboxRelay.isRabbitConnected()).toBe(true);
    await expect(outboxRelay.stop()).resolves.not.toThrow();
  });
});
