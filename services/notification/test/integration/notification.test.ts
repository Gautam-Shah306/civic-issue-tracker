import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { Connection } from 'rabbitmq-client';
import { PINNED_IMAGES } from '../support/images.js';
import { runMigrations } from '../../src/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig, Config } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createEventValidator } from '../../src/events/validator.js';
import { createNotificationConsumers } from '../../src/events/consumers.js';
import { createMailer } from '../../src/sender/mailer.js';
import { createSenderLoop } from '../../src/sender/loop.js';

describe('Notification Service Integration Tests (Testcontainers)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let rabbitContainer: StartedRabbitMQContainer;
  let mailpitContainer: StartedTestContainer;
  let pool: pg.Pool;
  let config: Config;
  let rabbitClient: Connection;
  let migrationsDir: string;
  let mailpitHttpUrl: string;
  let mailpitSmtpPort: number;

  beforeAll(async () => {
    // Start PostgreSQL container
    pgContainer = await new PostgreSqlContainer(PINNED_IMAGES.postgres)
      .withDatabase('civic_notification_test')
      .withUsername('civic_test')
      .withPassword('civic_test_pass')
      .withStartupTimeout(120000)
      .start();

    // Start RabbitMQ container
    rabbitContainer = await new RabbitMQContainer(PINNED_IMAGES.rabbitmq)
      .withEnvironment({
        RABBITMQ_DEFAULT_USER: 'civic_test',
        RABBITMQ_DEFAULT_PASS: 'civic_test_pass'
      })
      .withStartupTimeout(120000)
      .start();

    // Start Mailpit container
    mailpitContainer = await new GenericContainer(PINNED_IMAGES.mailpit)
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forListeningPorts())
      .withStartupTimeout(120000)
      .start();

    const pgPort = pgContainer.getMappedPort(5432);
    const pgHost = pgContainer.getHost();
    const rabbitPort = rabbitContainer.getMappedPort(5672);
    const rabbitHost = rabbitContainer.getHost();
    mailpitSmtpPort = mailpitContainer.getMappedPort(1025);
    const mailpitHttpPort = mailpitContainer.getMappedPort(8025);
    const mailpitHost = mailpitContainer.getHost();
    mailpitHttpUrl = `http://${mailpitHost}:${mailpitHttpPort}`;

    pool = new pg.Pool({
      host: pgHost,
      port: pgPort,
      database: 'civic_notification_test',
      user: 'civic_test',
      password: 'civic_test_pass',
      max: 10
    });

    migrationsDir = resolve(process.cwd(), 'migrations');
    if (!existsSync(migrationsDir)) {
      migrationsDir = resolve(process.cwd(), 'services/notification/migrations');
    }

    config = loadConfig({
      DB_HOST: pgHost,
      DB_PORT: pgPort,
      DB_NAME: 'civic_notification_test',
      DB_USER: 'civic_test',
      DB_PASSWORD: 'civic_test_pass',
      RABBITMQ_URL: `amqp://civic_test:civic_test_pass@${rabbitHost}:${rabbitPort}`,
      SMTP_HOST: mailpitHost,
      SMTP_PORT: mailpitSmtpPort,
      SMTP_FROM: 'notifications@civic.local',
      DELIVERY_LIMIT: 2,
      CONTRACTS_DIR: resolve(process.cwd(), '../../contracts')
    });

    rabbitClient = new Connection(config.RABBITMQ_URL);
    await rabbitClient.onConnect();
  }, 240000);

  const activeConsumers: Array<{ stop(): Promise<void> }> = [];

  afterEach(async () => {
    for (const c of activeConsumers) {
      await c.stop().catch(() => {});
    }
    activeConsumers.length = 0;
    if (pool) {
      await pool.query('DELETE FROM notifications;').catch(() => {});
      await pool.query('DELETE FROM report_index;').catch(() => {});
      await pool.query('DELETE FROM recipients;').catch(() => {});
      await pool.query('DELETE FROM processed_events;').catch(() => {});
    }
  });

  afterAll(async () => {
    for (const c of activeConsumers) {
      await c.stop().catch(() => {});
    }
    if (pool) await pool.end().catch(() => {});
    if (rabbitClient) {
      await Promise.race([
        rabbitClient.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 2000))
      ]);
    }
    if (pgContainer) await pgContainer.stop().catch(() => {});
    if (rabbitContainer) await rabbitContainer.stop().catch(() => {});
    if (mailpitContainer) await mailpitContainer.stop().catch(() => {});
  }, 120000);

  it('runs migrations twice idempotently', async () => {
    const firstRun = await runMigrations(pool, migrationsDir);
    expect(firstRun.length).toBeGreaterThan(0);

    const secondRun = await runMigrations(pool, migrationsDir);
    expect(secondRun.length).toBe(0);
  });

  it('responds to /healthz and /readyz, including 503 when degraded', async () => {
    const app = await buildApp(config, {
      pool,
      isRabbitReady: () => true,
      areConsumersReady: () => true
    });

    const healthRes = await app.inject({ method: 'GET', url: '/healthz' });
    expect(healthRes.statusCode).toBe(200);

    const readyRes = await app.inject({ method: 'GET', url: '/readyz' });
    expect(readyRes.statusCode).toBe(200);
    await app.close();

    const degradedApp = await buildApp(config, {
      pool,
      isRabbitReady: () => false,
      areConsumersReady: () => false
    });
    const degradedRes = await degradedApp.inject({ method: 'GET', url: '/readyz' });
    expect(degradedRes.statusCode).toBe(503);
    await degradedApp.close();
  });

  it('starts and stops sender loop cleanly', async () => {
    const logger = createLogger({ serviceName: 'test-notification', level: 'silent' });
    const mailer = createMailer(config);
    const loop = createSenderLoop({
      config,
      pool,
      mailer,
      logger
    });

    loop.start();
    loop.start(); // second call is no-op
    await new Promise((r) => setTimeout(r, 50));
    await loop.stop();
  });

  it('consumes user.created, creates welcome notification, and ignores duplicate delivery', async () => {
    const logger = createLogger({ serviceName: 'test-notification', level: 'silent' });
    const validator = createEventValidator(config);
    const consumers = createNotificationConsumers({
      config,
      pool,
      rabbitClient,
      validator,
      logger
    });

    await consumers.start();
    activeConsumers.push(consumers);

    const userId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const userCreatedEvent = {
      eventId,
      eventType: 'user.created',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
      payload: {
        userId,
        email: `citizen-${userId.slice(0, 8)}@example.com`,
        displayName: 'Test Citizen',
        role: 'citizen',
        createdAt: new Date().toISOString()
      }
    };

    const pub = rabbitClient.createPublisher({ confirms: true });

    // Publish event
    await pub.send(
      {
        exchange: 'civic.events',
        routingKey: 'user.created'
      },
      userCreatedEvent
    );

    // Wait for consumer processing
    let notifRow: { kind: string; status: string } | null = null;
    for (let i = 0; i < 30; i++) {
      const res = await pool.query<{ kind: string; status: string }>(
        'SELECT * FROM notifications WHERE event_id = $1',
        [eventId]
      );
      if (res.rows.length > 0) {
        notifRow = res.rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(notifRow).not.toBeNull();
    expect(notifRow!.kind).toBe('welcome');
    expect(notifRow!.status).toBe('pending');

    // Verify recipient was recorded in read model
    const recRes = await pool.query('SELECT * FROM recipients WHERE user_id = $1', [userId]);
    expect(recRes.rows.length).toBe(1);
    expect(recRes.rows[0].display_name).toBe('Test Citizen');

    // Redeliver duplicate event
    await pub.send(
      {
        exchange: 'civic.events',
        routingKey: 'user.created'
      },
      userCreatedEvent
    );

    await new Promise((r) => setTimeout(r, 600));

    // Verify still exactly ONE notification
    const countRes = await pool.query('SELECT count(*) FROM notifications WHERE event_id = $1', [
      eventId
    ]);
    expect(Number(countRes.rows[0].count)).toBe(1);

    // Deliver through sender: exactly ONE email sent
    const mailer = createMailer(config);
    const senderLoop = createSenderLoop({ config, pool, mailer, logger });
    const sentCount = await senderLoop.processBatch();
    expect(sentCount).toBe(1);

    const sentRows = await pool.query('SELECT status FROM notifications WHERE event_id = $1', [
      eventId
    ]);
    expect(sentRows.rows[0].status).toBe('sent');

    await consumers.stop();
  });

  it('report.submitted consumed BEFORE user.created still ends in ONE email once the user event arrives', async () => {
    const logger = createLogger({ serviceName: 'test-ordering-1', level: 'silent' });
    const validator = createEventValidator(config);
    const consumers = createNotificationConsumers({
      config,
      pool,
      rabbitClient,
      validator,
      logger
    });
    await consumers.start();
    activeConsumers.push(consumers);

    const mailer = createMailer(config);
    const senderLoop = createSenderLoop({
      config,
      pool,
      mailer,
      logger
    });

    const reporterId = crypto.randomUUID();
    const reportId = crypto.randomUUID();
    const submittedEventId = crypto.randomUUID();

    // 1. Report is submitted BEFORE user is created
    const reportSubmittedEvent = {
      eventId: submittedEventId,
      eventType: 'report.submitted',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
      payload: {
        reportId,
        reporterId,
        title: 'Ordering Test Streetlight',
        description: 'Dark corner',
        category: 'streetlight',
        location: { lat: 23.0, lng: 72.0 },
        submittedAt: new Date().toISOString()
      }
    };

    const pub = rabbitClient.createPublisher({ confirms: true });
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.submitted' },
      reportSubmittedEvent
    );

    // Wait for consumer to process report.submitted
    let notifRow: { status: string; kind: string } | null = null;
    for (let i = 0; i < 30; i++) {
      const res = await pool.query('SELECT * FROM notifications WHERE event_id = $1', [
        submittedEventId
      ]);
      if (res.rows.length > 0) {
        notifRow = res.rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(notifRow).not.toBeNull();
    expect(notifRow.status).toBe('pending');

    // Run sender: recipient is not in recipients table yet, so row stays pending with 'waiting for recipient data'
    const sentBeforeUser = await senderLoop.processBatch();
    expect(sentBeforeUser).toBe(0);

    const waitingRes = await pool.query(
      'SELECT status, last_error FROM notifications WHERE event_id = $1',
      [submittedEventId]
    );
    expect(waitingRes.rows[0].status).toBe('pending');
    expect(waitingRes.rows[0].last_error).toBe('waiting for recipient data');

    // 2. Now user.created event arrives!
    const userCreatedEventId = crypto.randomUUID();
    const userEmail = `ordering-${reporterId.slice(0, 6)}@test.local`;
    const userCreatedEvent = {
      eventId: userCreatedEventId,
      eventType: 'user.created',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
      payload: {
        userId: reporterId,
        email: userEmail,
        displayName: 'Late Citizen',
        role: 'citizen',
        createdAt: new Date().toISOString()
      }
    };

    await pub.send({ exchange: 'civic.events', routingKey: 'user.created' }, userCreatedEvent);

    // Wait for user.created to be consumed
    for (let i = 0; i < 30; i++) {
      const res = await pool.query('SELECT * FROM recipients WHERE user_id = $1', [reporterId]);
      if (res.rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    // Reset next_attempt_at to now for the pending report notification so sender picks it up immediately
    await pool.query(
      'UPDATE notifications SET next_attempt_at = clock_timestamp() WHERE event_id = $1',
      [submittedEventId]
    );

    // Run sender batch: both welcome and report_received should now be delivered!
    const sentAfterUser = await senderLoop.processBatch();
    expect(sentAfterUser).toBe(2);

    const sentRows = await pool.query(
      'SELECT kind, status FROM notifications WHERE event_id IN ($1, $2)',
      [submittedEventId, userCreatedEventId]
    );
    expect(sentRows.rows.every((r) => r.status === 'sent')).toBe(true);

    await consumers.stop();
  });

  it('report.status-changed consumed BEFORE report.submitted still ends in ONE email once submitted arrives', async () => {
    const logger = createLogger({ serviceName: 'test-ordering-2', level: 'silent' });
    const validator = createEventValidator(config);
    const consumers = createNotificationConsumers({
      config,
      pool,
      rabbitClient,
      validator,
      logger
    });
    await consumers.start();
    activeConsumers.push(consumers);

    const mailer = createMailer(config);
    const senderLoop = createSenderLoop({
      config,
      pool,
      mailer,
      logger
    });

    const reporterId = crypto.randomUUID();
    const reportId = crypto.randomUUID();
    const userEmail = `status-before-sub-${reporterId.slice(0, 6)}@test.local`;

    // Seed recipient so user is known
    await pool.query(
      `INSERT INTO recipients (user_id, email, display_name, role) VALUES ($1, $2, $3, $4);`,
      [reporterId, userEmail, 'Early Citizen', 'citizen']
    );

    // Publish status-changed event before report.submitted
    const statusChangedEventId = crypto.randomUUID();
    const statusChangedEvent = {
      eventId: statusChangedEventId,
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
    };

    const pub = rabbitClient.createPublisher({ confirms: true });
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.status-changed' },
      statusChangedEvent
    );

    for (let i = 0; i < 30; i++) {
      const res = await pool.query('SELECT * FROM notifications WHERE event_id = $1', [
        statusChangedEventId
      ]);
      if (res.rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    // Sender cannot find report in report_index yet -> stays pending
    const sentBeforeSub = await senderLoop.processBatch();
    expect(sentBeforeSub).toBe(0);

    const notifBefore = await pool.query(
      'SELECT status, last_error FROM notifications WHERE event_id = $1',
      [statusChangedEventId]
    );
    expect(notifBefore.rows[0].status).toBe('pending');
    expect(notifBefore.rows[0].last_error).toBe('waiting for recipient data');

    // Now publish report.submitted
    const reportSubmittedEventId = crypto.randomUUID();
    const reportSubmittedEvent = {
      eventId: reportSubmittedEventId,
      eventType: 'report.submitted',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
      payload: {
        reportId,
        reporterId,
        title: 'Water Leak Main',
        description: 'Details',
        category: 'water-leak',
        location: { lat: 23.0, lng: 72.0 },
        submittedAt: new Date().toISOString()
      }
    };
    await pub.send(
      { exchange: 'civic.events', routingKey: 'report.submitted' },
      reportSubmittedEvent
    );

    for (let i = 0; i < 30; i++) {
      const res = await pool.query('SELECT * FROM report_index WHERE report_id = $1', [reportId]);
      if (res.rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    await pool.query(
      'UPDATE notifications SET next_attempt_at = clock_timestamp() WHERE event_id = $1',
      [statusChangedEventId]
    );

    // Now sender can deliver both
    const sentAfterSub = await senderLoop.processBatch();
    expect(sentAfterSub).toBe(2);

    const okStatusNotif = await pool.query(
      'SELECT status, subject FROM notifications WHERE event_id = $1',
      [statusChangedEventId]
    );
    expect(okStatusNotif.rows[0].status).toBe('sent');
    expect(okStatusNotif.rows[0].subject).toContain('Verified: Water Leak Main');

    await consumers.stop();
  });

  it('sender delivers notification to Mailpit and verifies recipient & subject via Mailpit API', async () => {
    const logger = createLogger({ serviceName: 'test-sender', level: 'silent' });
    const mailer = createMailer(config);
    const senderLoop = createSenderLoop({
      config,
      pool,
      mailer,
      logger
    });

    const notifId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const targetEmail = `verified-${notifId.slice(0, 6)}@testmail.local`;
    const targetSubject = 'Welcome to Civic Issue Tracker';

    await pool.query(
      `INSERT INTO recipients (user_id, email, display_name, role) VALUES ($1, $2, $3, $4);`,
      [userId, targetEmail, 'Verified User', 'citizen']
    );

    await pool.query(
      `INSERT INTO notifications (id, event_id, kind, recipient_user_id, status, created_at, next_attempt_at)
       VALUES ($1, $2, 'welcome', $3, 'pending', clock_timestamp(), clock_timestamp());`,
      [notifId, crypto.randomUUID(), userId]
    );

    // Process batch synchronously
    const sentCount = await senderLoop.processBatch();
    expect(sentCount).toBeGreaterThanOrEqual(1);

    // Check DB status
    const dbRes = await pool.query(
      'SELECT status, sent_at, attempts, recipient_email FROM notifications WHERE id = $1',
      [notifId]
    );
    expect(dbRes.rows[0].status).toBe('sent');
    expect(dbRes.rows[0].sent_at).not.toBeNull();
    expect(dbRes.rows[0].attempts).toBe(1);
    expect(dbRes.rows[0].recipient_email).toBe(targetEmail);

    // Verify via Mailpit HTTP API
    const resp = await fetch(`${mailpitHttpUrl}/api/v1/messages`);
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      messages: Array<{ To: Array<{ Address: string }>; Subject: string }>;
    };
    const matchingMessage = data.messages.find(
      (m) => m.Subject === targetSubject && m.To.some((t) => t.Address === targetEmail)
    );
    expect(matchingMessage).toBeDefined();
  });

  it('SMTP down -> increments attempts with back-off, then delivers when SMTP returns', async () => {
    const logger = createLogger({ serviceName: 'test-resilience', level: 'silent' });

    const brokenConfig = { ...config, SMTP_PORT: 9999 };
    const brokenMailer = createMailer(brokenConfig);
    const brokenSenderLoop = createSenderLoop({
      config: brokenConfig,
      pool,
      mailer: brokenMailer,
      logger
    });

    const notifId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO recipients (user_id, email, display_name, role) VALUES ($1, $2, $3, $4);`,
      [userId, 'retry@test.local', 'Retry User', 'citizen']
    );

    await pool.query(
      `INSERT INTO notifications (id, event_id, kind, recipient_user_id, status, created_at, next_attempt_at)
       VALUES ($1, $2, 'welcome', $3, 'pending', clock_timestamp(), clock_timestamp());`,
      [notifId, crypto.randomUUID(), userId]
    );

    // Attempt delivery while SMTP is down
    await brokenSenderLoop.processBatch();

    // Notification should still be pending with attempts=1 and last_error recorded
    const failRes = await pool.query(
      'SELECT status, attempts, last_error, next_attempt_at FROM notifications WHERE id = $1',
      [notifId]
    );
    expect(failRes.rows[0].status).toBe('pending');
    expect(failRes.rows[0].attempts).toBe(1);
    expect(failRes.rows[0].last_error).not.toBeNull();

    // Now reset next_attempt_at to now and use working mailer
    await pool.query('UPDATE notifications SET next_attempt_at = clock_timestamp() WHERE id = $1', [
      notifId
    ]);

    const workingMailer = createMailer(config);
    const workingSenderLoop = createSenderLoop({
      config,
      pool,
      mailer: workingMailer,
      logger
    });

    const recoveredCount = await workingSenderLoop.processBatch();
    expect(recoveredCount).toBeGreaterThanOrEqual(1);

    const okRes = await pool.query('SELECT status, attempts FROM notifications WHERE id = $1', [
      notifId
    ]);
    expect(okRes.rows[0].status).toBe('sent');
    expect(okRes.rows[0].attempts).toBe(2);
  });

  it('computes attempts and capped exponential back-off correctly', async () => {
    const logger = createLogger({ serviceName: 'test-backoff', level: 'silent' });
    const brokenConfig = {
      ...config,
      SMTP_PORT: 9999,
      SENDER_MAX_ATTEMPTS: 4,
      SENDER_BACKOFF_CAP_SECONDS: 8
    };
    const brokenMailer = createMailer(brokenConfig);
    const brokenSenderLoop = createSenderLoop({
      config: brokenConfig,
      pool,
      mailer: brokenMailer,
      logger
    });

    const notifId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO recipients (user_id, email, display_name, role) VALUES ($1, $2, $3, $4);`,
      [userId, 'cap@test.local', 'Cap User', 'citizen']
    );

    await pool.query(
      `INSERT INTO notifications (id, event_id, kind, recipient_user_id, status, attempts, created_at, next_attempt_at)
       VALUES ($1, $2, 'welcome', $3, 'pending', 0, clock_timestamp(), clock_timestamp());`,
      [notifId, crypto.randomUUID(), userId]
    );

    // Attempt 1: fail -> attempts=1, delay = min(2^1, 8) = 2s
    await brokenSenderLoop.processBatch();
    let res = await pool.query(
      'SELECT attempts, status, next_attempt_at FROM notifications WHERE id = $1',
      [notifId]
    );
    expect(res.rows[0].attempts).toBe(1);
    expect(res.rows[0].status).toBe('pending');

    // Attempt 2:
    await pool.query('UPDATE notifications SET next_attempt_at = clock_timestamp() WHERE id = $1', [
      notifId
    ]);
    await brokenSenderLoop.processBatch();
    res = await pool.query('SELECT attempts, status FROM notifications WHERE id = $1', [notifId]);
    expect(res.rows[0].attempts).toBe(2);

    // Attempt 3:
    await pool.query('UPDATE notifications SET next_attempt_at = clock_timestamp() WHERE id = $1', [
      notifId
    ]);
    await brokenSenderLoop.processBatch();
    res = await pool.query('SELECT attempts, status FROM notifications WHERE id = $1', [notifId]);
    expect(res.rows[0].attempts).toBe(3);

    // Attempt 4: reaches MAX_ATTEMPTS (4) -> failed!
    await pool.query('UPDATE notifications SET next_attempt_at = clock_timestamp() WHERE id = $1', [
      notifId
    ]);
    await brokenSenderLoop.processBatch();
    res = await pool.query('SELECT attempts, status FROM notifications WHERE id = $1', [notifId]);
    expect(res.rows[0].attempts).toBe(4);
    expect(res.rows[0].status).toBe('failed');
  });

  it('no database transaction is open during the SMTP call', async () => {
    const logger = createLogger({ serviceName: 'test-no-tx', level: 'silent' });
    const notifId = crypto.randomUUID();
    const userId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO recipients (user_id, email, display_name, role) VALUES ($1, $2, $3, $4);`,
      [userId, 'notx@test.local', 'NoTx User', 'citizen']
    );

    await pool.query(
      `INSERT INTO notifications (id, event_id, kind, recipient_user_id, status, attempts, created_at, next_attempt_at)
       VALUES ($1, $2, 'welcome', $3, 'pending', 0, clock_timestamp(), clock_timestamp());`,
      [notifId, crypto.randomUUID(), userId]
    );

    let activeTxCountDuringSmtp = -1;

    const slowMailer = {
      sendMail: async () => {
        // Query pg_stat_activity to assert no open transactions during SMTP call
        const statRes = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM pg_stat_activity
           WHERE datname = 'civic_notification_test'
             AND pid != pg_backend_pid()
             AND state = 'idle in transaction';`
        );
        activeTxCountDuringSmtp = parseInt(statRes.rows[0].count, 10);
        return { messageId: 'test-msg-id' };
      }
    } as unknown as Transporter;

    const testLoop = createSenderLoop({
      config,
      pool,
      mailer: slowMailer,
      logger
    });

    await testLoop.processBatch();

    expect(activeTxCountDuringSmtp).toBe(0);

    const okRes = await pool.query('SELECT status FROM notifications WHERE id = $1', [notifId]);
    expect(okRes.rows[0].status).toBe('sent');
  });

  it('the 60 s lease prevents a second sender from double-sending', async () => {
    const logger = createLogger({ serviceName: 'test-lease', level: 'silent' });
    const notifId = crypto.randomUUID();
    const userId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO recipients (user_id, email, display_name, role) VALUES ($1, $2, $3, $4);`,
      [userId, 'lease@test.local', 'Lease User', 'citizen']
    );

    await pool.query(
      `INSERT INTO notifications (id, event_id, kind, recipient_user_id, status, attempts, created_at, next_attempt_at)
       VALUES ($1, $2, 'welcome', $3, 'pending', 0, clock_timestamp(), clock_timestamp());`,
      [notifId, crypto.randomUUID(), userId]
    );

    let sender1ProcessedCount = 0;
    let sender2ProcessedCount = 0;

    let unblockSender1: () => void;
    const sender1Pause = new Promise<void>((resolve) => {
      unblockSender1 = resolve;
    });

    const pausedMailer = {
      sendMail: async () => {
        await sender1Pause;
        return { messageId: 's1' };
      }
    } as unknown as Transporter;

    const workingMailer = createMailer(config);

    const sender1 = createSenderLoop({ config, pool, mailer: pausedMailer, logger });
    const sender2 = createSenderLoop({ config, pool, mailer: workingMailer, logger });

    // Start Sender 1 batch (claims lease for 60s, then pauses inside sendMail)
    const p1 = sender1.processBatch().then((cnt) => {
      sender1ProcessedCount = cnt;
    });

    // Wait briefly so Sender 1 claims lease
    await new Promise((r) => setTimeout(r, 200));

    // Sender 2 should see 0 available rows because Sender 1 holds the lease
    sender2ProcessedCount = await sender2.processBatch();
    expect(sender2ProcessedCount).toBe(0);

    // Unblock Sender 1
    unblockSender1!();
    await p1;

    expect(sender1ProcessedCount).toBe(1);

    const notifRes = await pool.query('SELECT status, attempts FROM notifications WHERE id = $1', [
      notifId
    ]);
    expect(notifRes.rows[0].status).toBe('sent');
    expect(notifRes.rows[0].attempts).toBe(1);
  });

  it('invalid payload lands in the DLQ', async () => {
    const logger = createLogger({ serviceName: 'test-dlq', level: 'silent' });
    const validator = createEventValidator(config);
    const consumers = createNotificationConsumers({
      config,
      pool,
      rabbitClient,
      validator,
      logger
    });
    await consumers.start();
    activeConsumers.push(consumers);

    const invalidEvent = {
      eventId: crypto.randomUUID(),
      eventType: 'report.submitted',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
      payload: {
        reportId: crypto.randomUUID(),
        reporterId: crypto.randomUUID()
      }
    };

    const pub = rabbitClient.createPublisher({ confirms: true });
    await pub.send(
      {
        exchange: 'civic.events',
        routingKey: 'report.submitted'
      },
      invalidEvent
    );

    let deadBody: Record<string, unknown> | null = null;
    for (let i = 0; i < 30; i++) {
      const dlqMsg = await rabbitClient.basicGet('notification.report-submitted.dlq');
      if (dlqMsg) {
        const body =
          typeof dlqMsg.body === 'object' && dlqMsg.body !== null
            ? (dlqMsg.body as Record<string, unknown>)
            : JSON.parse(dlqMsg.body.toString('utf8'));
        if (body.eventId === invalidEvent.eventId) {
          deadBody = body;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(deadBody).not.toBeNull();
    expect(deadBody!.eventId).toBe(invalidEvent.eventId);

    await consumers.stop();
  });

  it('poison message ends in the DLQ after DELIVERY_LIMIT=2 deliveries', async () => {
    let callCount = 0;
    const logger = createLogger({ serviceName: 'test-poison', level: 'silent' });
    const validator = createEventValidator(config);

    const poisonEventId = crypto.randomUUID();
    const consumers = createNotificationConsumers({
      config: { ...config, DELIVERY_LIMIT: 2 },
      pool,
      rabbitClient,
      validator,
      logger,
      testHook: (id) => {
        if (id === poisonEventId) {
          throw new Error('Poison handler simulated failure');
        }
      },
      onHandlerError: (_type, _err) => {
        callCount++;
      }
    });

    await consumers.start();
    activeConsumers.push(consumers);

    const poisonEvent = {
      eventId: poisonEventId,
      eventType: 'user.created',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
      payload: {
        userId: crypto.randomUUID(),
        email: 'poison@test.local',
        displayName: 'Poison User',
        role: 'citizen',
        createdAt: new Date().toISOString()
      }
    };

    const pub = rabbitClient.createPublisher({ confirms: true });
    await pub.send(
      {
        exchange: 'civic.events',
        routingKey: 'user.created'
      },
      poisonEvent
    );

    let poisonDeadBody: Record<string, unknown> | null = null;
    for (let i = 0; i < 40; i++) {
      const dlqMsg = await rabbitClient.basicGet('notification.user-created.dlq');
      if (dlqMsg) {
        const body =
          typeof dlqMsg.body === 'object' && dlqMsg.body !== null
            ? (dlqMsg.body as Record<string, unknown>)
            : JSON.parse(dlqMsg.body.toString('utf8'));
        if (body.eventId === poisonEventId) {
          poisonDeadBody = body;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(poisonDeadBody).not.toBeNull();
    expect(poisonDeadBody!.eventId).toBe(poisonEventId);
    expect(callCount).toBeGreaterThanOrEqual(2);

    await consumers.stop();
  });

  it('pending rows older than the wait timeout are still sent when data is present', async () => {
    const logger = createLogger({ serviceName: 'test-wait-timeout', level: 'silent' });
    const mailer = createMailer(config);
    const senderLoop = createSenderLoop({
      config,
      pool,
      mailer,
      logger
    });

    const notifId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const targetEmail = `old-pending-${notifId.slice(0, 6)}@testmail.local`;

    // 1. Seed recipient data so data is present
    await pool.query(
      `INSERT INTO recipients (user_id, email, display_name, role) VALUES ($1, $2, $3, $4);`,
      [userId, targetEmail, 'Old Pending User', 'citizen']
    );

    // 2. Insert notification row created 2 hours ago (older than SENDER_WAIT_TIMEOUT_SECONDS = 3600), with waiting_since NULL
    await pool.query(
      `INSERT INTO notifications (
         id, event_id, kind, recipient_user_id, status, created_at, next_attempt_at, waiting_since
       )
       VALUES ($1, $2, 'welcome', $3, 'pending', clock_timestamp() - interval '2 hours', clock_timestamp(), NULL);`,
      [notifId, crypto.randomUUID(), userId]
    );

    // 3. Process batch: since data is present, the row is SENT, NOT failed for age!
    const sentCount = await senderLoop.processBatch();
    expect(sentCount).toBe(1);

    const rowRes = await pool.query<{ status: string; waiting_since: unknown }>(
      'SELECT status, waiting_since FROM notifications WHERE id = $1',
      [notifId]
    );
    expect(rowRes.rows[0].status).toBe('sent');
    expect(rowRes.rows[0].waiting_since).toBeNull();

    // 4. Test missing recipient data timeout: insert row with waiting_since set 2 hours ago
    const missingNotifId = crypto.randomUUID();
    const unknownUserId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO notifications (
         id, event_id, kind, recipient_user_id, status, created_at, next_attempt_at, waiting_since
       )
       VALUES ($1, $2, 'welcome', $3, 'pending', clock_timestamp() - interval '2 hours', clock_timestamp(), clock_timestamp() - interval '2 hours');`,
      [missingNotifId, crypto.randomUUID(), unknownUserId]
    );

    const missingSent = await senderLoop.processBatch();
    expect(missingSent).toBe(0);

    const missingRowRes = await pool.query<{ status: string; last_error: string }>(
      'SELECT status, last_error FROM notifications WHERE id = $1',
      [missingNotifId]
    );
    expect(missingRowRes.rows[0].status).toBe('failed');
    expect(missingRowRes.rows[0].last_error).toContain('waiting for recipient data timeout');
  });
});
