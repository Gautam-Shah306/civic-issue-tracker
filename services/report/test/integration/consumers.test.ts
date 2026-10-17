import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { Connection } from 'rabbitmq-client';
import { PINNED_IMAGES } from '../support/images.js';
import { runMigrations } from '../../src/migrate.js';
import { loadConfig, Config } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createEventValidator } from '../../src/events/validator.js';
import { createReportConsumers, ReportConsumers } from '../../src/events/consumers.js';

describe('Report Consumers Integration Tests', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let rabbitContainer: StartedRabbitMQContainer;
  let pool: pg.Pool;
  let config: Config;
  let rabbitClient: Connection;
  let consumers: ReportConsumers;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer(PINNED_IMAGES.postgres)
      .withDatabase('civic_report_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    rabbitContainer = await new RabbitMQContainer(PINNED_IMAGES.rabbitmq)
      .withEnvironment({
        RABBITMQ_DEFAULT_USER: 'civic_test',
        RABBITMQ_DEFAULT_PASS: 'civic_test_pass'
      })
      .start();

    const rabbitUrl = `amqp://civic_test:civic_test_pass@${rabbitContainer.getHost()}:${rabbitContainer.getMappedPort(5672)}`;

    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const testPublicKeyB64 = Buffer.from(pubPem).toString('base64');

    config = loadConfig({
      DB_HOST: pgContainer.getHost(),
      DB_PORT: String(pgContainer.getPort()),
      DB_NAME: pgContainer.getDatabase(),
      DB_USER: pgContainer.getUsername(),
      DB_PASSWORD: pgContainer.getPassword(),
      RABBITMQ_URL: rabbitUrl,
      JWT_PUBLIC_KEY_B64: testPublicKeyB64,
      LOG_LEVEL: 'silent'
    });

    pool = new pg.Pool({
      host: config.DB_HOST,
      port: config.DB_PORT,
      database: config.DB_NAME,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      max: 10
    });

    const candidateDirs = [
      resolve(process.cwd(), 'migrations'),
      resolve(process.cwd(), 'services/report/migrations')
    ];
    const migrationsDir =
      candidateDirs.find((d) => existsSync(d)) || resolve(process.cwd(), 'migrations');
    await runMigrations(pool, migrationsDir);

    rabbitClient = new Connection(config.RABBITMQ_URL);
    const validator = createEventValidator(config);
    const logger = createLogger({ serviceName: 'report-consumer-test', level: 'silent' });

    consumers = createReportConsumers({
      config,
      pool,
      rabbitClient,
      validator,
      logger
    });

    await consumers.start();
  }, 240000);

  afterAll(async () => {
    if (consumers) await consumers.stop();
    if (rabbitClient) await rabbitClient.close();
    if (pool) await pool.end();
    if (rabbitContainer) await rabbitContainer.stop();
    if (pgContainer) await pgContainer.stop();
  }, 120000);

  it('handles report.assigned transitioning Submitted report to Assigned and staging outbox status-changed event', async () => {
    const reportId = crypto.randomUUID();
    const reporterId = crypto.randomUUID();

    // Insert test report in Submitted state
    await pool.query(
      `INSERT INTO reports (id, reporter_id, title, description, category_slug, lat, lng, status, version, created_at, updated_at)
       VALUES ($1, $2, 'Pothole Test', 'Deep pothole', 'pothole', 23.01, 72.48, 'Submitted', 1, NOW(), NOW());`,
      [reportId, reporterId]
    );

    const eventId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const assignedPayload = {
      reportId,
      wardCode: 'W-R1C1',
      departmentCode: 'roads',
      departmentName: 'Roads & Infrastructure',
      departmentEmail: 'roads@civic.example.test',
      source: 'auto',
      assignedAt: new Date().toISOString()
    };

    const envelope = {
      eventId,
      eventType: 'report.assigned',
      version: 1,
      occurredAt: assignedPayload.assignedAt,
      correlationId,
      payload: assignedPayload
    };

    // Publish to civic.events with routingKey report.assigned
    const pub = rabbitClient.createPublisher({ confirm: true });
    await pub.send(
      {
        exchange: 'civic.events',
        routingKey: 'report.assigned'
      },
      envelope
    );
    await pub.close();

    // Poll until report transitions to Assigned
    let updatedReport: { status: string; wardCode: string; departmentCode: string } | null = null;
    for (let i = 0; i < 30; i++) {
      const res = await pool.query(
        `SELECT status, ward_code as "wardCode", department_code as "departmentCode"
         FROM reports WHERE id = $1`,
        [reportId]
      );
      if (res.rows[0]?.status === 'Assigned') {
        updatedReport = res.rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(updatedReport).not.toBeNull();
    expect(updatedReport?.status).toBe('Assigned');
    expect(updatedReport?.wardCode).toBe('W-R1C1');
    expect(updatedReport?.departmentCode).toBe('roads');

    // Check status history row
    const historyRes = await pool.query(
      `SELECT from_status, to_status, changed_by, note
       FROM status_history WHERE report_id = $1`,
      [reportId]
    );
    expect(historyRes.rows.length).toBeGreaterThanOrEqual(1);
    expect(historyRes.rows[0].from_status).toBe('Submitted');
    expect(historyRes.rows[0].to_status).toBe('Assigned');
    expect(historyRes.rows[0].changed_by).toBe('system');

    // Check outbox event
    const outboxRes = await pool.query(
      `SELECT event_type, correlation_id, payload
       FROM outbox_events WHERE correlation_id = $1 AND event_type = 'report.status-changed'`,
      [correlationId]
    );
    expect(outboxRes.rows.length).toBe(1);
    const outboxPayload = outboxRes.rows[0].payload;
    expect(outboxPayload.toStatus).toBe('Assigned');
    expect(outboxPayload.fromStatus).toBe('Submitted');
  });

  it('handles report.assigned on already Assigned report by updating ward/dept without status change', async () => {
    const reportId = crypto.randomUUID();
    const reporterId = crypto.randomUUID();

    // Insert test report already in Assigned state
    await pool.query(
      `INSERT INTO reports (id, reporter_id, title, description, category_slug, lat, lng, status, version, ward_code, department_code, created_at, updated_at)
       VALUES ($1, $2, 'Already Assigned', 'Desc', 'pothole', 23.01, 72.48, 'Assigned', 2, 'W-R1C1', 'roads', NOW(), NOW());`,
      [reportId, reporterId]
    );

    const eventId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const reassignedPayload = {
      reportId,
      wardCode: 'W-R2C2',
      departmentCode: 'water',
      departmentName: 'Water & Sewerage',
      departmentEmail: 'water@civic.example.test',
      source: 'manual',
      assignedAt: new Date().toISOString()
    };

    const envelope = {
      eventId,
      eventType: 'report.assigned',
      version: 1,
      occurredAt: reassignedPayload.assignedAt,
      correlationId,
      payload: reassignedPayload
    };

    const pub = rabbitClient.createPublisher({ confirm: true });
    await pub.send(
      {
        exchange: 'civic.events',
        routingKey: 'report.assigned'
      },
      envelope
    );
    await pub.close();

    // Poll until ward is updated to W-R2C2
    let updatedReport: { status: string; wardCode: string; departmentCode: string } | null = null;
    for (let i = 0; i < 30; i++) {
      const res = await pool.query(
        `SELECT status, ward_code as "wardCode", department_code as "departmentCode"
         FROM reports WHERE id = $1`,
        [reportId]
      );
      if (res.rows[0]?.wardCode === 'W-R2C2') {
        updatedReport = res.rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(updatedReport).not.toBeNull();
    expect(updatedReport?.status).toBe('Assigned');
    expect(updatedReport?.wardCode).toBe('W-R2C2');
    expect(updatedReport?.departmentCode).toBe('water');

    // No new outbox event should be staged for status-changed
    const outboxRes = await pool.query(
      `SELECT event_type FROM outbox_events WHERE correlation_id = $1`,
      [correlationId]
    );
    expect(outboxRes.rows.length).toBe(0);
  });

  it('handles category.upserted by inserting or updating category in local cache', async () => {
    const slug = `park-bench-${crypto.randomUUID().slice(0, 6)}`;
    const eventId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();

    const categoryPayload = {
      slug,
      name: 'Broken Park Bench',
      active: true,
      departmentCode: 'sanitation',
      updatedAt: new Date().toISOString()
    };

    const envelope = {
      eventId,
      eventType: 'category.upserted',
      version: 1,
      occurredAt: categoryPayload.updatedAt,
      correlationId,
      payload: categoryPayload
    };

    const pub = rabbitClient.createPublisher({ confirm: true });
    await pub.send(
      {
        exchange: 'civic.events',
        routingKey: 'category.upserted'
      },
      envelope
    );
    await pub.close();

    // Poll until category is in categories table
    let categoryRow: {
      slug: string;
      name: string;
      department_code: string;
      active: boolean;
    } | null = null;
    for (let i = 0; i < 30; i++) {
      const res = await pool.query(
        `SELECT slug, name, department_code, active FROM categories WHERE slug = $1`,
        [slug]
      );
      if (res.rows.length > 0) {
        categoryRow = res.rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(categoryRow).not.toBeNull();
    expect(categoryRow?.slug).toBe(slug);
    expect(categoryRow?.name).toBe('Broken Park Bench');
    expect(categoryRow?.department_code).toBe('sanitation');
    expect(categoryRow?.active).toBe(true);
  });

  it('handles image.processed by upserting into images_seen and updating pending report_photos', async () => {
    const reportId = crypto.randomUUID();
    const reporterId = crypto.randomUUID();
    const imageId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const now = new Date();

    // 1. Insert report and pending report_photos entry
    await pool.query(
      `INSERT INTO reports (id, reporter_id, title, description, category_slug, lat, lng, status, version, created_at, updated_at)
       VALUES ($1, $2, 'Pothole with photo', 'Has a photo', 'pothole', 12.9, 77.5, 'Submitted', 1, $3, $3)`,
      [reportId, reporterId, now]
    );

    await pool.query(
      `INSERT INTO report_photos (report_id, image_id, status, created_at, updated_at)
       VALUES ($1, $2, 'pending', $3, $3)`,
      [reportId, imageId, now]
    );

    // 2. Publish image.processed event
    const imageProcessedPayload = {
      imageId,
      ownerId: reporterId,
      status: 'ready',
      width: 1600,
      height: 1200,
      gpsPresent: true,
      rejectReason: null,
      processedAt: now.toISOString()
    };

    const envelope = {
      eventId,
      eventType: 'image.processed',
      version: 1,
      occurredAt: imageProcessedPayload.processedAt,
      correlationId,
      payload: imageProcessedPayload
    };

    const pub = rabbitClient.createPublisher({ confirm: true });
    await pub.send(
      {
        exchange: 'civic.events',
        routingKey: 'image.processed'
      },
      envelope
    );
    await pub.close();

    // 3. Poll until report_photos is updated
    let updatedPhoto: {
      status: string;
      width: number;
      height: number;
      gps_present: boolean;
    } | null = null;

    for (let i = 0; i < 30; i++) {
      const res = await pool.query(
        `SELECT status, width, height, gps_present FROM report_photos WHERE report_id = $1 AND image_id = $2`,
        [reportId, imageId]
      );
      if (res.rows.length > 0 && res.rows[0].status === 'ready') {
        updatedPhoto = res.rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(updatedPhoto).not.toBeNull();
    expect(updatedPhoto?.status).toBe('ready');
    expect(updatedPhoto?.width).toBe(1600);
    expect(updatedPhoto?.height).toBe(1200);
    expect(updatedPhoto?.gps_present).toBe(true);

    // 4. Verify images_seen also has the record
    const seenRes = await pool.query(
      `SELECT status, width, height, gps_present FROM images_seen WHERE image_id = $1`,
      [imageId]
    );
    expect(seenRes.rows.length).toBe(1);
    expect(seenRes.rows[0].status).toBe('ready');
    expect(seenRes.rows[0].width).toBe(1600);
  });

  it('handles report.assigned transitioning Verified and Reopened reports to Assigned', async () => {
    const verifiedReportId = crypto.randomUUID();
    const reopenedReportId = crypto.randomUUID();
    const reporterId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO reports (id, reporter_id, title, description, category_slug, lat, lng, status, version, created_at, updated_at)
       VALUES 
         ($1, $3, 'Verified Report', 'Desc', 'pothole', 23.01, 72.48, 'Verified', 1, NOW(), NOW()),
         ($2, $3, 'Reopened Report', 'Desc', 'pothole', 23.02, 72.49, 'Reopened', 2, NOW(), NOW());`,
      [verifiedReportId, reopenedReportId, reporterId]
    );

    const pub = rabbitClient.createPublisher({ confirm: true });

    for (const reportId of [verifiedReportId, reopenedReportId]) {
      const assignedPayload = {
        reportId,
        wardCode: 'W-R1C1',
        departmentCode: 'roads',
        departmentName: 'Roads & Infrastructure',
        departmentEmail: 'roads@civic.example.test',
        source: 'auto',
        assignedAt: new Date().toISOString()
      };

      await pub.send(
        {
          exchange: 'civic.events',
          routingKey: 'report.assigned'
        },
        {
          eventId: crypto.randomUUID(),
          eventType: 'report.assigned',
          version: 1,
          occurredAt: assignedPayload.assignedAt,
          correlationId: crypto.randomUUID(),
          payload: assignedPayload
        }
      );
    }
    await pub.close();

    // Verify both transitioned to Assigned
    for (const reportId of [verifiedReportId, reopenedReportId]) {
      let status: string | null = null;
      for (let i = 0; i < 30; i++) {
        const res = await pool.query(`SELECT status FROM reports WHERE id = $1`, [reportId]);
        if (res.rows[0]?.status === 'Assigned') {
          status = res.rows[0].status;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(status).toBe('Assigned');
    }
  });

  it('marks photo rejected when uploader differs from reporter (ownership mismatch)', async () => {
    const reportId = crypto.randomUUID();
    const reporterId = crypto.randomUUID();
    const attackerId = crypto.randomUUID();
    const photoId = crypto.randomUUID();
    const now = new Date();

    // Reporter submits report with photoId
    await pool.query(
      `INSERT INTO reports (id, reporter_id, title, description, category_slug, lat, lng, status, version, created_at, updated_at)
       VALUES ($1, $2, 'Reporter Report', 'Desc', 'pothole', 12.9, 77.5, 'Submitted', 1, $3, $3)`,
      [reportId, reporterId, now]
    );

    await pool.query(
      `INSERT INTO report_photos (report_id, image_id, status, created_at, updated_at)
       VALUES ($1, $2, 'pending', $3, $3)`,
      [reportId, photoId, now]
    );

    // image.processed arrives with ownerId = attackerId
    const pub = rabbitClient.createPublisher({ confirm: true });
    await pub.send(
      {
        exchange: 'civic.events',
        routingKey: 'image.processed'
      },
      {
        eventId: crypto.randomUUID(),
        eventType: 'image.processed',
        version: 1,
        occurredAt: now.toISOString(),
        correlationId: crypto.randomUUID(),
        payload: {
          imageId: photoId,
          ownerId: attackerId,
          status: 'ready',
          width: 800,
          height: 600,
          gpsPresent: false,
          rejectReason: null,
          processedAt: now.toISOString()
        }
      }
    );
    await pub.close();

    // Poll until photo is marked rejected for ownership mismatch
    let photoStatus: string | null = null;
    let rejectReason: string | null = null;
    for (let i = 0; i < 30; i++) {
      const res = await pool.query(
        `SELECT status, reject_reason FROM report_photos WHERE report_id = $1 AND image_id = $2`,
        [reportId, photoId]
      );
      if (res.rows[0]?.status === 'rejected') {
        photoStatus = res.rows[0].status;
        rejectReason = res.rows[0].reject_reason;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(photoStatus).toBe('rejected');
    expect(rejectReason).toBe('ownership_mismatch');
  });
});
