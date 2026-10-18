import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { Connection, AsyncMessage } from 'rabbitmq-client';
import { PINNED_IMAGES } from '../support/images.js';
import { runMigrations } from '../../src/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig, Config } from '../../src/config.js';
import { createOutboxRelay, OutboxRelay } from '../../src/outbox/relay.js';
import { createLogger } from '../../src/logger.js';
import { createEventValidator } from '../../src/events/validator.js';
import { bootstrapAdmin } from '../../src/auth/bootstrap.js';
import { hashPassword } from '../../src/auth/password.js';

describe('Auth Service Integration Tests (Testcontainers)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let rabbitContainer: StartedRabbitMQContainer;
  let pool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let config: Config;
  let outboxRelay: OutboxRelay;
  let rabbitClient: Connection;
  let testPrivateKeyB64: string;
  let migrationsDir: string;

  beforeAll(async () => {
    // 1. Generate Ed25519 keypair for tests
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    testPrivateKeyB64 = Buffer.from(pem).toString('base64');

    // 2. Start PostgreSQL Container using pinned image
    pgContainer = await new PostgreSqlContainer(PINNED_IMAGES.postgres)
      .withDatabase('civic_auth_test')
      .withUsername('test_user')
      .withPassword('test_password')
      .withStartupTimeout(120000)
      .start();

    // 3. Start RabbitMQ Container using pinned image with explicit credentials
    rabbitContainer = await new RabbitMQContainer(PINNED_IMAGES.rabbitmq)
      .withEnvironment({
        RABBITMQ_DEFAULT_USER: 'civic_test',
        RABBITMQ_DEFAULT_PASS: 'civic_test_pass'
      })
      .withStartupTimeout(120000)
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
      migrationsDir = resolve(process.cwd(), 'services/auth/migrations');
    }

    // 4. Run database migrations
    await runMigrations(pool, migrationsDir);

    // 5. Build configuration
    config = loadConfig({
      SERVICE_NAME: 'auth-test',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      DB_HOST: pgContainer.getHost(),
      DB_PORT: String(pgContainer.getPort()),
      DB_NAME: pgContainer.getDatabase(),
      DB_USER: pgContainer.getUsername(),
      DB_PASSWORD: pgContainer.getPassword(),
      RABBITMQ_URL: rabbitUrl,
      JWT_PRIVATE_KEY_B64: testPrivateKeyB64,
      JWT_ISSUER: 'civic-auth',
      JWT_AUDIENCE: 'civic-api',
      ACCESS_TTL_SECONDS: '900',
      REFRESH_TTL_DAYS: '7',
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
  });

  it('runs migrations idempotently and rejects tampered checksums', async () => {
    // Run second time cleanly
    const secondRun = await runMigrations(pool, migrationsDir);
    expect(secondRun).toHaveLength(0);

    // Tamper with checksum of 0001_init.sql in schema_migrations
    await pool.query(
      `UPDATE schema_migrations SET checksum = 'tampered_bad_checksum' WHERE version = '0001_init.sql'`
    );

    await expect(runMigrations(pool, migrationsDir)).rejects.toThrow(/Migration checksum mismatch/);

    // Restore real checksum
    const realSql = readFileSync(join(migrationsDir, '0001_init.sql'), 'utf8');
    const realChecksum = crypto.createHash('sha256').update(realSql, 'utf8').digest('hex');
    await pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = '0001_init.sql'`, [
      realChecksum
    ]);
  });

  it('completes the full flow: register -> login -> me -> refresh -> logout', async () => {
    const testEmail = `citizen_${Date.now()}@example.com`;
    const testPassword = 'StrongPassword123!';
    const testDisplayName = 'Citizen Tester';

    // 1. Register
    const regRes = await request(app.server).post('/api/v1/auth/register').send({
      email: testEmail,
      password: testPassword,
      displayName: testDisplayName
    });

    expect(regRes.status).toBe(201);
    expect(regRes.body).toHaveProperty('id');
    expect(regRes.body.email).toBe(testEmail);
    expect(regRes.body.displayName).toBe(testDisplayName);
    expect(regRes.body.role).toBe('citizen');

    // 2. Login
    const loginRes = await request(app.server).post('/api/v1/auth/login').send({
      email: testEmail,
      password: testPassword
    });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.tokenType).toBe('Bearer');
    expect(loginRes.body.accessToken).toBeTypeOf('string');
    expect(loginRes.body.refreshToken).toBeTypeOf('string');
    expect(loginRes.body.user.email).toBe(testEmail);

    const accessToken = loginRes.body.accessToken;
    const refreshToken1 = loginRes.body.refreshToken;

    // 3. Me
    const meRes = await request(app.server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.email).toBe(testEmail);
    expect(meRes.body.role).toBe('citizen');

    // 4. Refresh token rotation
    const refreshRes = await request(app.server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: refreshToken1 });

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.accessToken).toBeTypeOf('string');
    expect(refreshRes.body.refreshToken).toBeTypeOf('string');
    expect(refreshRes.body.refreshToken).not.toBe(refreshToken1);

    const accessToken2 = refreshRes.body.accessToken;
    const refreshToken2 = refreshRes.body.refreshToken;

    // Verify new access token works
    const meRes2 = await request(app.server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken2}`);
    expect(meRes2.status).toBe(200);

    // 5. Logout
    const logoutRes = await request(app.server)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: refreshToken2 });

    expect(logoutRes.status).toBe(204);

    // Attempting refresh with logged out token fails
    const failRefresh = await request(app.server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: refreshToken2 });

    expect(failRefresh.status).toBe(401);
    expect(failRefresh.body.code).toBe('invalid_refresh_token');
  });

  it('rejects duplicate email with 409 email_taken', async () => {
    const dupEmail = 'duplicate@example.com';
    const pw = 'SafePassword123!';

    const first = await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email: dupEmail, password: pw, displayName: 'User One' });
    expect(first.status).toBe(201);

    const second = await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email: dupEmail, password: pw, displayName: 'User Two' });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('email_taken');
  });

  it('handles concurrent registrations of the same email: exactly one 201 and one 409, no 500', async () => {
    const concurrentEmail = `concurrent_${Date.now()}@example.com`;
    const pw = 'SafePassword123!';

    const [res1, res2] = await Promise.all([
      request(app.server)
        .post('/api/v1/auth/register')
        .send({ email: concurrentEmail, password: pw, displayName: 'Concurrent One' }),
      request(app.server)
        .post('/api/v1/auth/register')
        .send({ email: concurrentEmail, password: pw, displayName: 'Concurrent Two' })
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 409]);

    const res409 = res1.status === 409 ? res1 : res2;
    expect(res409.body.code).toBe('email_taken');
  });

  it('rejects weak password and password matching email with 400 validation_error', async () => {
    // Too short (<10)
    const shortRes = await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email: 'valid@example.com', password: 'short', displayName: 'Short' });
    expect(shortRes.status).toBe(400);
    expect(shortRes.body.code).toBe('validation_error');

    // Equal to email
    const matchRes = await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email: 'same@example.com', password: 'same@example.com', displayName: 'Same' });
    expect(matchRes.status).toBe(400);
    expect(matchRes.body.code).toBe('validation_error');
  });

  it('rejects wrong password with 401 invalid_credentials', async () => {
    const email = 'checkpass@example.com';
    await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email, password: 'RealPassword123!', displayName: 'Check Pass' });

    const wrongLogin = await request(app.server)
      .post('/api/v1/auth/login')
      .send({ email, password: 'WrongPassword999!' });

    expect(wrongLogin.status).toBe(401);
    expect(wrongLogin.body.code).toBe('invalid_credentials');
  });

  it('detects refresh token reuse and revokes entire family', async () => {
    const email = 'reuse@example.com';
    const pw = 'StrongPassword123!';
    await request(app.server)
      .post('/api/v1/auth/register')
      .send({ email, password: pw, displayName: 'Reuse Test' });

    const login = await request(app.server)
      .post('/api/v1/auth/login')
      .send({ email, password: pw });

    const r1 = login.body.refreshToken;

    // Legitimate rotation: r1 -> r2
    const ref1 = await request(app.server).post('/api/v1/auth/refresh').send({ refreshToken: r1 });
    expect(ref1.status).toBe(200);
    const r2 = ref1.body.refreshToken;

    // Attacker tries to reuse r1
    const attack = await request(app.server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: r1 });
    expect(attack.status).toBe(401);
    expect(attack.body.code).toBe('invalid_refresh_token');

    // Legitimate r2 is now also revoked due to family invalidation
    const victim = await request(app.server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: r2 });
    expect(victim.status).toBe(401);
    expect(victim.body.code).toBe('invalid_refresh_token');
  });

  it('rejects forged JWT on protected endpoints', async () => {
    const foreignPair = await (await import('jose')).generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const forgedToken = await new (await import('jose')).SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(crypto.randomUUID())
      .setIssuer('civic-auth')
      .setAudience('civic-api')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(foreignPair.privateKey);

    const res = await request(app.server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${forgedToken}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });

  it('maintains atomicity: if outbox validation fails, user row is not committed', async () => {
    const failEmail = 'atomic_fail@example.com';

    // Mock event validator to fail
    const failingValidator = {
      validateUserCreated: () => {
        throw new Error('Forced outbox failure for atomicity test');
      }
    };

    const atomicApp = await buildApp(config, {
      pool,
      eventValidator: failingValidator
    });
    await atomicApp.ready();

    const reg = await request(atomicApp.server).post('/api/v1/auth/register').send({
      email: failEmail,
      password: 'Password123!',
      displayName: 'Fail Atomic'
    });

    expect(reg.status).toBe(500);

    // Verify user row was rolled back
    const userCheck = await pool.query(`SELECT id FROM users WHERE email = $1`, [failEmail]);
    expect(userCheck.rows).toHaveLength(0);

    await atomicApp.close();
  });

  it('relays outbox events to real RabbitMQ and validates consumed payload', async () => {
    const email = 'relay_test@example.com';
    const reg = await request(app.server).post('/api/v1/auth/register').send({
      email,
      password: 'Password123!',
      displayName: 'Relay Tester'
    });
    expect(reg.status).toBe(201);

    // Set up a consumer on RabbitMQ to receive user.created events
    let receivedMsg: AsyncMessage | null = null;
    const consumer = rabbitClient.createConsumer(
      {
        queue: 'test.user-created',
        queueOptions: { durable: true, autoDelete: true },
        exchanges: [{ exchange: 'civic.events', type: 'topic', durable: true }],
        queueBindings: [{ exchange: 'civic.events', routingKey: 'user.created' }]
      },
      async (msg) => {
        receivedMsg = msg;
      }
    );

    // Wait for consumer to be ready
    await new Promise<void>((resolve) => {
      consumer.on('ready', () => resolve());
      setTimeout(resolve, 500);
    });

    // Process batch with outbox relay
    const count = await outboxRelay.processBatch();
    expect(count).toBeGreaterThan(0);

    // Wait up to 5 seconds for message receipt
    for (let i = 0; i < 50; i++) {
      if (receivedMsg) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(receivedMsg).not.toBeNull();
    const rawMsg = receivedMsg as unknown as AsyncMessage;
    const parsedBody = typeof rawMsg.body === 'string' ? JSON.parse(rawMsg.body) : rawMsg.body;
    expect(parsedBody.eventType).toBe('user.created');
    expect(parsedBody.version).toBe(1);
    expect(parsedBody.payload.email).toBe(email);

    // Validate payload against event JSON schema
    const eventValidator = createEventValidator(config);
    expect(() => eventValidator.validateUserCreated(parsedBody)).not.toThrow();

    // Check AMQP properties mapping
    expect(rawMsg.type).toBe('user.created');
    expect(rawMsg.contentType).toBe('application/json');
    expect(rawMsg.deliveryMode).toBe(2);

    await consumer.close();
  });

  it('serves /healthz, /readyz, /.well-known/jwks.json, and handles 404', async () => {
    // /healthz returns 200
    const health = await request(app.server).get('/healthz');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');

    // /readyz returns 200 when ready
    const ready = await request(app.server).get('/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');

    // /.well-known/jwks.json returns 200 with keys
    const jwks = await request(app.server).get('/.well-known/jwks.json');
    expect(jwks.status).toBe(200);
    expect(jwks.body.keys).toHaveLength(1);

    // 404 problem details
    const notFound = await request(app.server).get('/api/v1/nonexistent-route');
    expect(notFound.status).toBe(404);
    expect(notFound.body.code).toBe('not_found');

    // /readyz returns 503 when dependencies are unready
    const unreadyApp = await buildApp(config, {
      pool: {
        query: () => Promise.reject(new Error('DB failure'))
      } as unknown as pg.Pool,
      isRabbitReady: () => false
    });
    await unreadyApp.ready();
    const unreadyRes = await request(unreadyApp.server).get('/readyz');
    expect(unreadyRes.status).toBe(503);
    expect(unreadyRes.body.code).toBe('service_unavailable');
    await unreadyApp.close();
  });

  it('exercises relay lifecycle methods', async () => {
    expect(outboxRelay.isRabbitConnected()).toBe(true);
    outboxRelay.start();
    await new Promise((r) => setTimeout(r, 300));
    await outboxRelay.stop();
  });

  describe('Part B Admin User Management and Bootstrap', () => {
    const bootstrapEmail = 'bootstrap.admin@civic.test';
    const bootstrapPass = 'BootstrapAdmin#2026!';

    it('bootstrap creates exactly one admin on two starts', async () => {
      const logger = createLogger({ serviceName: 'test-bootstrap', level: 'silent' });
      const validator = createEventValidator(config);

      const bootstrapConfig = loadConfig({
        ...config,
        BOOTSTRAP_ADMIN_EMAIL: bootstrapEmail,
        BOOTSTRAP_ADMIN_PASSWORD: bootstrapPass
      });

      // Start 1
      await bootstrapAdmin(pool, bootstrapConfig, logger, validator);
      const res1 = await pool.query(
        "SELECT id, email, role, is_active FROM users WHERE email = $1 AND role = 'admin'",
        [bootstrapEmail]
      );
      expect(res1.rows).toHaveLength(1);
      expect(res1.rows[0].is_active).toBe(true);

      // Start 2 (idempotent, does not duplicate or throw)
      await bootstrapAdmin(pool, bootstrapConfig, logger, validator);
      const res2 = await pool.query(
        "SELECT id, email, role, is_active FROM users WHERE email = $1 AND role = 'admin'",
        [bootstrapEmail]
      );
      expect(res2.rows).toHaveLength(1);

      // Verify outbox has user.created event for bootstrap admin
      const outboxRes = await pool.query(
        "SELECT * FROM outbox_events WHERE event_type = 'user.created' AND payload->>'email' = $1",
        [bootstrapEmail]
      );
      expect(outboxRes.rows).toHaveLength(1);
    });

    it('enforces RBAC, guards, deactivation token revocation, and user.updated event emission', async () => {
      const validator = createEventValidator(config);

      // 1. Login with bootstrap admin
      const adminLoginRes = await request(app.server).post('/api/v1/auth/login').send({
        email: bootstrapEmail,
        password: bootstrapPass
      });
      expect(adminLoginRes.status).toBe(200);
      const adminToken = adminLoginRes.body.accessToken;
      const adminUser = adminLoginRes.body.user;

      // 2. Register citizen & login to obtain citizen token
      const citizenEmail = `citizen_${Date.now()}@civic.test`;
      const citizenPass = 'Citizen#Pass2026!';
      await request(app.server).post('/api/v1/auth/register').send({
        email: citizenEmail,
        password: citizenPass,
        displayName: 'Test Citizen'
      });
      const citizenLoginRes = await request(app.server).post('/api/v1/auth/login').send({
        email: citizenEmail,
        password: citizenPass
      });
      const citizenToken = citizenLoginRes.body.accessToken;

      // 3. RBAC checks on /api/v1/auth/users: no token -> 401, citizen -> 403
      const noTokenPost = await request(app.server).post('/api/v1/auth/users').send({
        email: 'some.user@civic.test',
        password: 'SomePassword#1',
        displayName: 'Some User',
        role: 'officer'
      });
      expect(noTokenPost.status).toBe(401);
      expect(noTokenPost.body.code).toBe('unauthorized');

      const citizenPost = await request(app.server)
        .post('/api/v1/auth/users')
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({
          email: 'some.user@civic.test',
          password: 'SomePassword#1',
          displayName: 'Some User',
          role: 'officer'
        });
      expect(citizenPost.status).toBe(403);
      expect(citizenPost.body.code).toBe('forbidden');

      const noTokenGet = await request(app.server).get('/api/v1/auth/users');
      expect(noTokenGet.status).toBe(401);

      const citizenGet = await request(app.server)
        .get('/api/v1/auth/users')
        .set('Authorization', `Bearer ${citizenToken}`);
      expect(citizenGet.status).toBe(403);

      const dummyUuid = crypto.randomUUID();
      const noTokenPatch = await request(app.server)
        .patch(`/api/v1/auth/users/${dummyUuid}`)
        .send({ displayName: 'New Name' });
      expect(noTokenPatch.status).toBe(401);

      const citizenPatch = await request(app.server)
        .patch(`/api/v1/auth/users/${dummyUuid}`)
        .set('Authorization', `Bearer ${citizenToken}`)
        .send({ displayName: 'New Name' });
      expect(citizenPatch.status).toBe(403);

      // 4. Admin creates an officer
      const officerEmail = `officer_${Date.now()}@civic.test`;
      const officerPass = 'Officer#Pass2026!';
      const createOfficerRes = await request(app.server)
        .post('/api/v1/auth/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: officerEmail,
          password: officerPass,
          displayName: 'Roads Officer',
          role: 'officer'
        });

      expect(createOfficerRes.status).toBe(201);
      expect(createOfficerRes.body.email).toBe(officerEmail);
      expect(createOfficerRes.body.role).toBe('officer');
      expect(createOfficerRes.body.isActive).toBe(true);
      const officerId = createOfficerRes.body.id;

      // Duplicate email returns 409 email_taken
      const duplicateRes = await request(app.server)
        .post('/api/v1/auth/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: officerEmail,
          password: officerPass,
          displayName: 'Roads Officer Duplicate',
          role: 'officer'
        });
      expect(duplicateRes.status).toBe(409);
      expect(duplicateRes.body.code).toBe('email_taken');

      // Officer login to test role and get refresh token
      const officerLoginRes = await request(app.server).post('/api/v1/auth/login').send({
        email: officerEmail,
        password: officerPass
      });
      expect(officerLoginRes.status).toBe(200);
      const officerToken = officerLoginRes.body.accessToken;
      const officerRefreshToken = officerLoginRes.body.refreshToken;

      // Officer calling admin routes gets 403
      const officerAdminRes = await request(app.server)
        .get('/api/v1/auth/users')
        .set('Authorization', `Bearer ${officerToken}`);
      expect(officerAdminRes.status).toBe(403);

      // 5. GET /api/v1/auth/users with pagination and filters
      const listUsersRes = await request(app.server)
        .get('/api/v1/auth/users?role=officer&page=1&pageSize=10')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(listUsersRes.status).toBe(200);
      expect(listUsersRes.body.items.length).toBeGreaterThanOrEqual(1);
      expect(listUsersRes.body.pagination.page).toBe(1);
      expect(listUsersRes.body.pagination.pageSize).toBe(10);
      expect(listUsersRes.body.items.some((u: { email: string }) => u.email === officerEmail)).toBe(
        true
      );

      const searchUsersRes = await request(app.server)
        .get(`/api/v1/auth/users?q=${encodeURIComponent(officerEmail)}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(searchUsersRes.status).toBe(200);
      expect(searchUsersRes.body.items.length).toBe(1);

      // 6. PATCH /api/v1/auth/users/:id guards
      // Unknown id -> 404
      const unknownPatch = await request(app.server)
        .patch(`/api/v1/auth/users/${crypto.randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ displayName: 'Ghost' });
      expect(unknownPatch.status).toBe(404);
      expect(unknownPatch.body.code).toBe('not_found');

      // Admin cannot deactivate themselves -> 400
      const selfDeact = await request(app.server)
        .patch(`/api/v1/auth/users/${adminUser.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false });
      expect(selfDeact.status).toBe(400);
      expect(selfDeact.body.code).toBe('self_modification_forbidden');

      // Admin cannot demote themselves -> 400
      const selfDemote = await request(app.server)
        .patch(`/api/v1/auth/users/${adminUser.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'citizen' });
      expect(selfDemote.status).toBe(400);
      expect(selfDemote.body.code).toBe('self_modification_forbidden');

      // Create a 2nd admin
      const admin2Email = `admin2_${Date.now()}@civic.test`;
      const admin2Pass = 'Admin2#Pass2026!';
      const createAdmin2Res = await request(app.server)
        .post('/api/v1/auth/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: admin2Email,
          password: admin2Pass,
          displayName: 'Second Admin',
          role: 'admin'
        });
      expect(createAdmin2Res.status).toBe(201);
      const admin2Id = createAdmin2Res.body.id;

      // Login as Admin 2
      const admin2LoginRes = await request(app.server).post('/api/v1/auth/login').send({
        email: admin2Email,
        password: admin2Pass
      });
      const admin2Token = admin2LoginRes.body.accessToken;

      // Admin 2 demotes Admin 2 -> 400 (self demotion)
      const admin2SelfDemote = await request(app.server)
        .patch(`/api/v1/auth/users/${admin2Id}`)
        .set('Authorization', `Bearer ${admin2Token}`)
        .send({ role: 'citizen' });
      expect(admin2SelfDemote.status).toBe(400);

      // Admin 1 demotes Admin 2 -> 200 (since Admin 1 remains active)
      const demoteAdmin2Res = await request(app.server)
        .patch(`/api/v1/auth/users/${admin2Id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'officer' });
      expect(demoteAdmin2Res.status).toBe(200);
      expect(demoteAdmin2Res.body.role).toBe('officer');

      // Test 409 last_admin guard:
      // Create a temporary third admin, login as third admin, then demote third admin in DB directly
      // so callingAdmin has a valid admin JWT but is not active in DB, or target is the sole active admin.
      const admin3Email = `admin3_${Date.now()}@civic.test`;
      const admin3Pass = 'Admin3#Pass2026!';
      const createAdmin3Res = await request(app.server)
        .post('/api/v1/auth/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: admin3Email,
          password: admin3Pass,
          displayName: 'Third Admin',
          role: 'admin'
        });
      expect(createAdmin3Res.status).toBe(201);
      const admin3Id = createAdmin3Res.body.id;

      // Admin 1 deactivates Admin 3: now Admin 1 is the ONLY active admin remaining!
      await request(app.server)
        .patch(`/api/v1/auth/users/${admin3Id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false });

      // Now activeAdminCount is 1 (Admin 1).
      // Temporarily mark Admin 3 active again in DB as an admin:
      await pool.query("UPDATE users SET is_active = true, role = 'admin' WHERE id = $1", [
        admin3Id
      ]);
      // Now Admin 3 is active admin, and Admin 1 is active admin (total 2).
      // Now demote Admin 3 in DB to 'officer' but Admin 3 still holds a valid admin JWT:
      await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [adminUser.id]);
      await pool.query("UPDATE users SET role = 'citizen' WHERE id = $1", [admin3Id]);
      // Now ONLY Admin 1 is active admin! (activeAdminCount = 1)
      // If someone calls PATCH on Admin 1 to deactivate or demote it:
      // (Using admin3Token, but updating admin3 role to admin temporarily in DB to pass requireAdmin):
      // Wait: we can add a test specifically asserting last_admin 409:
      // If active admin count = 1, can Admin 1 deactivate Admin 1? Guard 1 throws 400.
      // But if another admin token is used where target is Admin 1:
      // Let's create an admin token for a dummy admin, insert dummy admin in DB as admin,
      // then in a transaction or test, verify that attempting to deactivate the last admin returns 409 last_admin.
      const dummyAdminEmail = `dummy_admin_${Date.now()}@civic.test`;
      const dummyAdminId = crypto.randomUUID();
      const hash = await hashPassword('DummyPass#2026!', config);
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $2, 'Dummy', $3, 'admin', true, NOW(), NOW())`,
        [dummyAdminId, dummyAdminEmail, hash]
      );
      const dummyLogin = await request(app.server).post('/api/v1/auth/login').send({
        email: dummyAdminEmail,
        password: 'DummyPass#2026!'
      });
      const dummyAdminToken = dummyLogin.body.accessToken;

      // Now 2 active admins (Admin 1 and Dummy Admin).
      // Deactivate Admin 1:
      const deactAdmin1 = await request(app.server)
        .patch(`/api/v1/auth/users/${adminUser.id}`)
        .set('Authorization', `Bearer ${dummyAdminToken}`)
        .send({ isActive: false });
      expect(deactAdmin1.status).toBe(200);

      // Now Dummy Admin is the ONLY active admin in the entire database!
      // Attempting to deactivate Dummy Admin from any caller... wait, if Dummy Admin calls PATCH on Dummy Admin -> 400.
      // If we make Admin 1 active again in DB as an 'admin', Admin 1 logs in, now 2 admins.
      // What if Admin 1 is active admin, Dummy Admin is deactivated -> Admin 1 is sole active admin.
      // If another admin (e.g. dummy admin before deactivation) tries to deactivate Admin 1 when Admin 1 was the ONLY active admin?
      // Exactly! When activeAdminCount <= 1:
      // Let's test the 409 last_admin guard directly:
      // Mark Dummy Admin inactive in DB, but keep Dummy Admin's valid access token:
      await pool.query('UPDATE users SET is_active = true WHERE id = $1', [dummyAdminId]);
      await pool.query('UPDATE users SET is_active = false WHERE id = $1', [adminUser.id]);
      // Now ONLY dummyAdmin is active admin (count = 1).
      // Reactivate adminUser in DB, but as role 'citizen':
      await pool.query("UPDATE users SET is_active = true, role = 'citizen' WHERE id = $1", [
        adminUser.id
      ]);
      // Now dummyAdmin is the ONLY active admin.
      // What if dummyAdmin tries to deactivate dummyAdmin? self_modification_forbidden.
      // What if another admin in DB is updated to citizen, while holding a JWT?
      // Even simpler: Insert a user with role 'admin' and is_active = true, and ensure count = 1.
      // Then use a direct test or call PATCH on that admin user:
      // If caller is another admin (temporarily active during check, but count is 1):
      // To test 409 `last_admin`:
      const testAdminAId = crypto.randomUUID();
      const testAdminBId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, 'adminA@civic.test', 'admina@civic.test', 'Admin A', $3, 'admin', true, NOW(), NOW()),
                ($2, 'adminB@civic.test', 'adminb@civic.test', 'Admin B', $3, 'admin', true, NOW(), NOW())`,
        [testAdminAId, testAdminBId, hash]
      );
      const loginA = await request(app.server).post('/api/v1/auth/login').send({
        email: 'adminA@civic.test',
        password: 'DummyPass#2026!'
      });
      // Now de-adminify all other admins so only Admin B is active admin:
      await pool.query("UPDATE users SET is_active = false WHERE role = 'admin' AND id != $1", [
        testAdminBId
      ]);
      // Now ONLY Admin B is an active admin! Count = 1.
      // Admin A has a valid access token, but is inactive in DB, so let's temporarily set Admin A is_active = true, role = 'officer'
      // Wait, requireAdmin checks tokenPayload.role === 'admin' and user in DB is_active = true!
      // In requireAdmin: it checks `SELECT id, is_active FROM users WHERE id = $1`. It does NOT re-check role in DB, it checks tokenPayload.role!
      // And tokenPayload.role for Admin A is 'admin'!
      // And in DB, Admin A is_active = true, but role is 'citizen'!
      await pool.query("UPDATE users SET is_active = true, role = 'citizen' WHERE id = $1", [
        testAdminAId
      ]);
      // Now ONLY Admin B has role = 'admin' in the database! Total active admins = 1!
      // Admin A calls PATCH on Admin B to deactivate Admin B:
      const lastAdminRes = await request(app.server)
        .patch(`/api/v1/auth/users/${testAdminBId}`)
        .set('Authorization', `Bearer ${loginA.body.accessToken}`)
        .send({ isActive: false });
      expect(lastAdminRes.status).toBe(409);
      expect(lastAdminRes.body.code).toBe('last_admin');

      // Restore Admin 1 as active admin for rest of test
      await pool.query("UPDATE users SET is_active = true, role = 'admin' WHERE id = $1", [
        adminUser.id
      ]);

      // 7. Deactivation of officer: revokes refresh tokens and emits user.updated
      const deactOfficerRes = await request(app.server)
        .patch(`/api/v1/auth/users/${officerId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false, displayName: 'Deactivated Officer' });

      expect(deactOfficerRes.status).toBe(200);
      expect(deactOfficerRes.body.isActive).toBe(false);
      expect(deactOfficerRes.body.displayName).toBe('Deactivated Officer');

      // Deactivated user cannot log in
      const officerDeactLogin = await request(app.server).post('/api/v1/auth/login').send({
        email: officerEmail,
        password: officerPass
      });
      expect(officerDeactLogin.status).toBe(401);

      // Deactivated user's refresh token fails
      const officerRefreshRes = await request(app.server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: officerRefreshToken });
      expect(officerRefreshRes.status).toBe(401);

      // 8. Verify user.updated event in outbox against schema
      const userUpdatedOutbox = await pool.query(
        "SELECT * FROM outbox_events WHERE event_type = 'user.updated' AND payload->>'userId' = $1 ORDER BY occurred_at DESC LIMIT 1",
        [officerId]
      );
      expect(userUpdatedOutbox.rows).toHaveLength(1);
      const row = userUpdatedOutbox.rows[0];
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      const eventEnvelope = {
        eventId: row.event_id,
        eventType: row.event_type,
        version: row.version,
        occurredAt:
          row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
        correlationId: row.correlation_id,
        payload
      };

      expect(() => validator.validateUserUpdated(eventEnvelope)).not.toThrow();
    });
  });
});
