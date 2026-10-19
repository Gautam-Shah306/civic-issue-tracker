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

    it('bootstrap creates exactly one admin across two starts', async () => {
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

    it('bootstrap never overwrites an existing user', async () => {
      const logger = createLogger({ serviceName: 'test-bootstrap', level: 'silent' });
      const validator = createEventValidator(config);
      const existingUserEmail = `existing_${Date.now()}@civic.test`;
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $2, 'Existing Citizen', 'hash', 'citizen', true, NOW(), NOW())`,
        [crypto.randomUUID(), existingUserEmail]
      );
      const overwriteConfig = loadConfig({
        ...config,
        BOOTSTRAP_ADMIN_EMAIL: existingUserEmail,
        BOOTSTRAP_ADMIN_PASSWORD: bootstrapPass
      });
      await bootstrapAdmin(pool, overwriteConfig, logger, validator);
      const existingUserCheck = await pool.query(
        'SELECT display_name, role FROM users WHERE email = $1',
        [existingUserEmail]
      );
      expect(existingUserCheck.rows[0].display_name).toBe('Existing Citizen');
      expect(existingUserCheck.rows[0].role).toBe('citizen');
    });

    it('an admin cannot deactivate themselves', async () => {
      const adminEmail = `admin_self_${Date.now()}@civic.test`;
      const adminPass = 'AdminPass#2026!';
      const adminId = crypto.randomUUID();
      const hash = await hashPassword(adminPass, config);
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $2, 'Self Admin', $3, 'admin', true, NOW(), NOW())`,
        [adminId, adminEmail, hash]
      );
      const login = await request(app.server).post('/api/v1/auth/login').send({
        email: adminEmail,
        password: adminPass
      });
      const res = await request(app.server)
        .patch(`/api/v1/auth/users/${adminId}`)
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .send({ isActive: false });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('self_modification_forbidden');
    });

    it('an admin cannot demote themselves', async () => {
      const adminEmail = `admin_demote_${Date.now()}@civic.test`;
      const adminPass = 'AdminPass#2026!';
      const adminId = crypto.randomUUID();
      const hash = await hashPassword(adminPass, config);
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $2, 'Demote Admin', $3, 'admin', true, NOW(), NOW())`,
        [adminId, adminEmail, hash]
      );
      const login = await request(app.server).post('/api/v1/auth/login').send({
        email: adminEmail,
        password: adminPass
      });
      const res = await request(app.server)
        .patch(`/api/v1/auth/users/${adminId}`)
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .send({ role: 'citizen' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('self_modification_forbidden');
    });

    it('the last active admin cannot be deactivated (409 last_admin)', async () => {
      const adminAId = crypto.randomUUID();
      const adminBId = crypto.randomUUID();
      const hash = await hashPassword('Pass#2026!', config);
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, 'last_admin_a@civic.test', 'last_admin_a@civic.test', 'Admin A', $3, 'admin', true, NOW(), NOW()),
                ($2, 'last_admin_b@civic.test', 'last_admin_b@civic.test', 'Admin B', $3, 'admin', true, NOW(), NOW())`,
        [adminAId, adminBId, hash]
      );
      const loginA = await request(app.server).post('/api/v1/auth/login').send({
        email: 'last_admin_a@civic.test',
        password: 'Pass#2026!'
      });

      await pool.query("UPDATE users SET is_active = false WHERE role = 'admin' AND id != $1", [
        adminBId
      ]);
      await pool.query("UPDATE users SET is_active = true, role = 'citizen' WHERE id = $1", [
        adminAId
      ]);

      const res = await request(app.server)
        .patch(`/api/v1/auth/users/${adminBId}`)
        .set('Authorization', `Bearer ${loginA.body.accessToken}`)
        .send({ isActive: false });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('last_admin');
    });

    it('the last active admin cannot be demoted (409 last_admin)', async () => {
      const adminAId = crypto.randomUUID();
      const adminBId = crypto.randomUUID();
      const hash = await hashPassword('Pass#2026!', config);
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, 'demote_last_a@civic.test', 'demote_last_a@civic.test', 'Admin A', $3, 'admin', true, NOW(), NOW()),
                ($2, 'demote_last_b@civic.test', 'demote_last_b@civic.test', 'Admin B', $3, 'admin', true, NOW(), NOW())`,
        [adminAId, adminBId, hash]
      );
      const loginA = await request(app.server).post('/api/v1/auth/login').send({
        email: 'demote_last_a@civic.test',
        password: 'Pass#2026!'
      });

      await pool.query("UPDATE users SET is_active = false WHERE role = 'admin' AND id != $1", [
        adminBId
      ]);
      await pool.query("UPDATE users SET is_active = true, role = 'citizen' WHERE id = $1", [
        adminAId
      ]);

      const res = await request(app.server)
        .patch(`/api/v1/auth/users/${adminBId}`)
        .set('Authorization', `Bearer ${loginA.body.accessToken}`)
        .send({ role: 'officer' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('last_admin');
    });

    it('unknown user id gives 404', async () => {
      const adminEmail = `admin_unk_${Date.now()}@civic.test`;
      const adminPass = 'AdminPass#2026!';
      const hash = await hashPassword(adminPass, config);
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $2, 'Admin Unk', $3, 'admin', true, NOW(), NOW())`,
        [crypto.randomUUID(), adminEmail, hash]
      );
      const login = await request(app.server).post('/api/v1/auth/login').send({
        email: adminEmail,
        password: adminPass
      });

      const res = await request(app.server)
        .patch(`/api/v1/auth/users/${crypto.randomUUID()}`)
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .send({ displayName: 'Ghost' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });

    it('POST, GET and PATCH users: citizen 403, officer 403, no token 401', async () => {
      const hash = await hashPassword('Pass#2026!', config);
      const citEmail = `cit_rbac_${Date.now()}@civic.test`;
      const offEmail = `off_rbac_${Date.now()}@civic.test`;
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $2, 'Cit', $4, 'citizen', true, NOW(), NOW()),
                ($3, $5, $5, 'Off', $4, 'officer', true, NOW(), NOW())`,
        [crypto.randomUUID(), citEmail, crypto.randomUUID(), hash, offEmail]
      );
      const citLogin = await request(app.server)
        .post('/api/v1/auth/login')
        .send({ email: citEmail, password: 'Pass#2026!' });
      const offLogin = await request(app.server)
        .post('/api/v1/auth/login')
        .send({ email: offEmail, password: 'Pass#2026!' });
      const citToken = citLogin.body.accessToken;
      const offToken = offLogin.body.accessToken;
      const dummyId = crypto.randomUUID();

      // No token -> 401
      expect((await request(app.server).post('/api/v1/auth/users').send({})).status).toBe(401);
      expect((await request(app.server).get('/api/v1/auth/users')).status).toBe(401);
      expect(
        (await request(app.server).patch(`/api/v1/auth/users/${dummyId}`).send({})).status
      ).toBe(401);

      // Citizen -> 403
      expect(
        (
          await request(app.server)
            .post('/api/v1/auth/users')
            .set('Authorization', `Bearer ${citToken}`)
            .send({})
        ).status
      ).toBe(403);
      expect(
        (
          await request(app.server)
            .get('/api/v1/auth/users')
            .set('Authorization', `Bearer ${citToken}`)
        ).status
      ).toBe(403);
      expect(
        (
          await request(app.server)
            .patch(`/api/v1/auth/users/${dummyId}`)
            .set('Authorization', `Bearer ${citToken}`)
            .send({})
        ).status
      ).toBe(403);

      // Officer -> 403
      expect(
        (
          await request(app.server)
            .post('/api/v1/auth/users')
            .set('Authorization', `Bearer ${offToken}`)
            .send({})
        ).status
      ).toBe(403);
      expect(
        (
          await request(app.server)
            .get('/api/v1/auth/users')
            .set('Authorization', `Bearer ${offToken}`)
        ).status
      ).toBe(403);
      expect(
        (
          await request(app.server)
            .patch(`/api/v1/auth/users/${dummyId}`)
            .set('Authorization', `Bearer ${offToken}`)
            .send({})
        ).status
      ).toBe(403);
    });

    it('a deactivated user cannot log in', async () => {
      const email = `deact_login_${Date.now()}@civic.test`;
      const pass = 'Pass#2026!';
      const id = crypto.randomUUID();
      const hash = await hashPassword(pass, config);
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $2, 'Deact User', $3, 'citizen', false, NOW(), NOW())`,
        [id, email, hash]
      );
      const login = await request(app.server)
        .post('/api/v1/auth/login')
        .send({ email, password: pass });
      expect(login.status).toBe(401);
    });

    it("deactivation revokes the user's refresh tokens", async () => {
      const email = `deact_tok_${Date.now()}@civic.test`;
      const pass = 'Pass#2026!';
      const id = crypto.randomUUID();
      const hash = await hashPassword(pass, config);
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $2, 'Deact Tok', $3, 'citizen', true, NOW(), NOW())`,
        [id, email, hash]
      );
      const login = await request(app.server)
        .post('/api/v1/auth/login')
        .send({ email, password: pass });
      const refreshToken = login.body.refreshToken;

      // Admin deactivates user
      const adminEmail = `admin_act_${Date.now()}@civic.test`;
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $2, 'Admin Act', $3, 'admin', true, NOW(), NOW())`,
        [crypto.randomUUID(), adminEmail, hash]
      );
      const adminLogin = await request(app.server)
        .post('/api/v1/auth/login')
        .send({ email: adminEmail, password: pass });
      await request(app.server)
        .patch(`/api/v1/auth/users/${id}`)
        .set('Authorization', `Bearer ${adminLogin.body.accessToken}`)
        .send({ isActive: false });

      // Refresh token is revoked
      const refreshRes = await request(app.server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });
      expect(refreshRes.status).toBe(401);
    });

    it('the user.updated event is written in the same transaction as the change and validates against its schema', async () => {
      const validator = createEventValidator(config);
      const email = `upd_evt_${Date.now()}@civic.test`;
      const pass = 'Pass#2026!';
      const id = crypto.randomUUID();
      const hash = await hashPassword(pass, config);
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $2, 'Update Evt', $3, 'officer', true, NOW(), NOW())`,
        [id, email, hash]
      );
      const adminEmail = `admin_evt_${Date.now()}@civic.test`;
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $2, 'Admin Evt', $3, 'admin', true, NOW(), NOW())`,
        [crypto.randomUUID(), adminEmail, hash]
      );
      const adminLogin = await request(app.server)
        .post('/api/v1/auth/login')
        .send({ email: adminEmail, password: pass });

      await request(app.server)
        .patch(`/api/v1/auth/users/${id}`)
        .set('Authorization', `Bearer ${adminLogin.body.accessToken}`)
        .send({ displayName: 'New Display Name', isActive: false });

      const outboxRes = await pool.query(
        "SELECT * FROM outbox_events WHERE event_type = 'user.updated' AND payload->>'userId' = $1 ORDER BY occurred_at DESC LIMIT 1",
        [id]
      );
      expect(outboxRes.rows).toHaveLength(1);
      const row = outboxRes.rows[0];
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

    it('list filters role, active and q', async () => {
      const pass = 'Pass#2026!';
      const hash = await hashPassword(pass, config);
      const adminEmail = `admin_list_${Date.now()}@civic.test`;
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $2, 'Admin List', $3, 'admin', true, NOW(), NOW())`,
        [crypto.randomUUID(), adminEmail, hash]
      );
      const adminLogin = await request(app.server)
        .post('/api/v1/auth/login')
        .send({ email: adminEmail, password: pass });
      const adminToken = adminLogin.body.accessToken;

      const qTerm = `unq_${Date.now()}`;
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, '${qTerm}_off@civic.test', '${qTerm}_off@civic.test', '${qTerm} Officer', $3, 'officer', true, NOW(), NOW()),
                ($2, '${qTerm}_cit@civic.test', '${qTerm}_cit@civic.test', '${qTerm} Citizen', $3, 'citizen', false, NOW(), NOW())`,
        [crypto.randomUUID(), crypto.randomUUID(), hash]
      );

      // Filter role
      const roleRes = await request(app.server)
        .get(`/api/v1/auth/users?role=officer&q=${qTerm}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(roleRes.status).toBe(200);
      expect(roleRes.body.items).toHaveLength(1);
      expect(roleRes.body.items[0].role).toBe('officer');

      // Filter active=false
      const inactRes = await request(app.server)
        .get(`/api/v1/auth/users?active=false&q=${qTerm}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(inactRes.status).toBe(200);
      expect(inactRes.body.items).toHaveLength(1);
      expect(inactRes.body.items[0].isActive).toBe(false);

      // Filter q
      const qRes = await request(app.server)
        .get(`/api/v1/auth/users?q=${qTerm}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(qRes.status).toBe(200);
      expect(qRes.body.items).toHaveLength(2);
    });

    it('list pagination', async () => {
      const pass = 'Pass#2026!';
      const hash = await hashPassword(pass, config);
      const adminEmail = `admin_page_${Date.now()}@civic.test`;
      await pool.query(
        `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $2, 'Admin Page', $3, 'admin', true, NOW(), NOW())`,
        [crypto.randomUUID(), adminEmail, hash]
      );
      const adminLogin = await request(app.server)
        .post('/api/v1/auth/login')
        .send({ email: adminEmail, password: pass });
      const adminToken = adminLogin.body.accessToken;

      const pageRes = await request(app.server)
        .get('/api/v1/auth/users?page=1&pageSize=2')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(pageRes.status).toBe(200);
      expect(pageRes.body.pagination.page).toBe(1);
      expect(pageRes.body.pagination.pageSize).toBe(2);
      expect(pageRes.body.items.length).toBeLessThanOrEqual(2);
      expect(pageRes.body.pagination.total).toBeGreaterThanOrEqual(1);
    });
  });
});
