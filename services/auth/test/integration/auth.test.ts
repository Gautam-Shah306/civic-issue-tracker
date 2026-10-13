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
      .start();

    // 3. Start RabbitMQ Container using pinned image with explicit credentials
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
  }, 120000);

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
});
