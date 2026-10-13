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
    let notifRow: { kind: string; status: string; subject: string } | null = null;
    for (let i = 0; i < 30; i++) {
      const res = await pool.query<{ kind: string; status: string; subject: string }>(
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
    expect(notifRow.kind).toBe('welcome');
    expect(notifRow.status).toBe('pending');
    expect(notifRow.subject).toBe('Welcome to Civic Issue Tracker');

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

    await consumers.stop();
  });

  it('consumes report.submitted and creates report_received notification using recipient cache', async () => {
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

    // Seed recipient
    const reporterId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO recipients (user_id, email, display_name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING;`,
      [reporterId, 'reporter@example.com', 'Jane Reporter', 'citizen']
    );

    const reportId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const reportSubmittedEvent = {
      eventId,
      eventType: 'report.submitted',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
      payload: {
        reportId,
        reporterId,
        title: 'Broken water main',
        description: 'Water spraying into street',
        category: 'water-leak',
        location: { lat: 23.0225, lng: 72.5714 },
        submittedAt: new Date().toISOString()
      }
    };

    const pub = rabbitClient.createPublisher({ confirms: true });
    await pub.send(
      {
        exchange: 'civic.events',
        routingKey: 'report.submitted'
      },
      reportSubmittedEvent
    );

    let notifRow: { kind: string; subject: string; recipient_email: string } | null = null;
    for (let i = 0; i < 30; i++) {
      const res = await pool.query<{ kind: string; subject: string; recipient_email: string }>(
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
    expect(notifRow.kind).toBe('report_received');
    expect(notifRow.subject).toBe('We received your report: Broken water main');
    expect(notifRow.recipient_email).toBe('reporter@example.com');

    // Check report_index read model
    const indexRes = await pool.query('SELECT * FROM report_index WHERE report_id = $1', [
      reportId
    ]);
    expect(indexRes.rows.length).toBe(1);
    expect(indexRes.rows[0].title).toBe('Broken water main');

    await consumers.stop();
  });

  it('consumes report.status-changed and creates status_changed notification', async () => {
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

    const reporterId = crypto.randomUUID();
    const reportId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO recipients (user_id, email, display_name, role)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING;`,
      [reporterId, 'citizen_status@example.com', 'Alex Citizen', 'citizen']
    );

    await pool.query(
      `INSERT INTO report_index (report_id, reporter_id, title)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;`,
      [reportId, reporterId, 'Streetlight dark']
    );

    const eventId = crypto.randomUUID();
    const statusChangedEvent = {
      eventId,
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
      {
        exchange: 'civic.events',
        routingKey: 'report.status-changed'
      },
      statusChangedEvent
    );

    let notifRow: { kind: string; subject: string; recipient_email: string } | null = null;
    for (let i = 0; i < 30; i++) {
      const res = await pool.query<{ kind: string; subject: string; recipient_email: string }>(
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
    expect(notifRow.kind).toBe('status_changed');
    expect(notifRow.subject).toBe('Your report is now Verified: Streetlight dark');
    expect(notifRow.recipient_email).toBe('citizen_status@example.com');

    await consumers.stop();
  });

  it('unknown recipient does not block consumption and logs warning', async () => {
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

    const eventId = crypto.randomUUID();
    const unknownReporterId = crypto.randomUUID();
    const reportId = crypto.randomUUID();

    const reportSubmittedEvent = {
      eventId,
      eventType: 'report.submitted',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
      payload: {
        reportId,
        reporterId: unknownReporterId,
        title: 'Report with unknown reporter',
        description: 'Details',
        category: 'sanitation',
        location: { lat: 23.0, lng: 72.0 },
        submittedAt: new Date().toISOString()
      }
    };

    const pub = rabbitClient.createPublisher({ confirms: true });
    await pub.send(
      {
        exchange: 'civic.events',
        routingKey: 'report.submitted'
      },
      reportSubmittedEvent
    );

    // Wait for processed_events entry
    let processed = false;
    for (let i = 0; i < 30; i++) {
      const res = await pool.query('SELECT * FROM processed_events WHERE event_id = $1', [eventId]);
      if (res.rows.length > 0) {
        processed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(processed).toBe(true);

    // Verify no notification was created
    const notifRes = await pool.query('SELECT * FROM notifications WHERE event_id = $1', [eventId]);
    expect(notifRes.rows.length).toBe(0);

    const metrics = consumers.getMetrics();
    expect(metrics.unknownRecipientCount).toBeGreaterThanOrEqual(1);

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
    const targetEmail = `verified-${notifId.slice(0, 6)}@testmail.local`;
    const targetSubject = 'We received your report: Pothole repaired';

    await pool.query(
      `INSERT INTO notifications (id, event_id, kind, recipient_email, subject, body, status, created_at, next_attempt_at)
       VALUES ($1, $2, 'report_received', $3, $4, 'Body text', 'pending', clock_timestamp(), clock_timestamp());`,
      [notifId, crypto.randomUUID(), targetEmail, targetSubject]
    );

    // Process batch synchronously
    const sentCount = await senderLoop.processBatch();
    expect(sentCount).toBeGreaterThanOrEqual(1);

    // Check DB status
    const dbRes = await pool.query(
      'SELECT status, sent_at, attempts FROM notifications WHERE id = $1',
      [notifId]
    );
    expect(dbRes.rows[0].status).toBe('sent');
    expect(dbRes.rows[0].sent_at).not.toBeNull();
    expect(dbRes.rows[0].attempts).toBe(1);

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

    // Create mailer pointing to invalid port (simulating SMTP down)
    const brokenConfig = { ...config, SMTP_PORT: 9999 };
    const brokenMailer = createMailer(brokenConfig);
    const brokenSenderLoop = createSenderLoop({
      config: brokenConfig,
      pool,
      mailer: brokenMailer,
      logger
    });

    const notifId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO notifications (id, event_id, kind, recipient_email, subject, body, status, created_at, next_attempt_at)
       VALUES ($1, $2, 'welcome', 'retry@test.local', 'Welcome Retry Test', 'Body', 'pending', clock_timestamp(), clock_timestamp());`,
      [notifId, crypto.randomUUID()]
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

  it('five failures transitions status to failed', async () => {
    const logger = createLogger({ serviceName: 'test-max-failures', level: 'silent' });
    const brokenConfig = { ...config, SMTP_PORT: 9999 };
    const brokenMailer = createMailer(brokenConfig);
    const brokenSenderLoop = createSenderLoop({
      config: brokenConfig,
      pool,
      mailer: brokenMailer,
      logger
    });

    const notifId = crypto.randomUUID();
    // Insert with attempts = 4
    await pool.query(
      `INSERT INTO notifications (id, event_id, kind, recipient_email, subject, body, status, attempts, created_at, next_attempt_at)
       VALUES ($1, $2, 'welcome', 'fail@test.local', 'Max Failures Test', 'Body', 'pending', 4, clock_timestamp(), clock_timestamp());`,
      [notifId, crypto.randomUUID()]
    );

    await brokenSenderLoop.processBatch();

    const dbRes = await pool.query(
      'SELECT status, attempts, last_error FROM notifications WHERE id = $1',
      [notifId]
    );
    expect(dbRes.rows[0].status).toBe('failed');
    expect(dbRes.rows[0].attempts).toBe(5);
    expect(dbRes.rows[0].last_error).not.toBeNull();
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

    // Malformed event payload (missing required title and category)
    const invalidEvent = {
      eventId: crypto.randomUUID(),
      eventType: 'report.submitted',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
      payload: {
        reportId: crypto.randomUUID(),
        reporterId: crypto.randomUUID()
        // Missing title, category, description, etc.
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

    // Check that message was dropped to DLQ (notification.report-submitted.dlq)
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

    // Create consumer with callback that throws on a specific eventId
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

    // Quorum queue retries up to delivery limit 2, then routes to DLQ
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
});
