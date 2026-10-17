import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Connection, Consumer, ConsumerStatus, AsyncMessage } from 'rabbitmq-client';
import { Logger } from 'pino';
import { Config } from '../config.js';
import { EventValidator, EventEnvelope } from './validator.js';
import { validateStatusTransition, ReportStatus } from '../domain/transitions.js';

export interface ReportConsumers {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createReportConsumers(options: {
  config: Config;
  pool: pg.Pool;
  rabbitClient: Connection;
  validator: EventValidator;
  logger: Logger;
}): ReportConsumers {
  const { config, pool, rabbitClient, validator, logger } = options;
  const consumers: Consumer[] = [];

  async function initTopology(): Promise<void> {
    // 1. Declare exchanges
    await rabbitClient.exchangeDeclare({
      exchange: 'civic.events',
      type: 'topic',
      durable: true
    });

    await rabbitClient.exchangeDeclare({
      exchange: 'civic.dlx',
      type: 'direct',
      durable: true
    });

    // 2. Declare DLQs
    const dlqs = [
      'report.report-assigned.dlq',
      'report.category-upserted.dlq',
      'report.image-processed.dlq'
    ];
    for (const dlq of dlqs) {
      await rabbitClient.queueDeclare({
        queue: dlq,
        durable: true
      });
      await rabbitClient.queueBind({
        queue: dlq,
        exchange: 'civic.dlx',
        routingKey: dlq
      });
    }

    // 3. Declare quorum queues and bindings
    await rabbitClient.queueDeclare({
      queue: 'report.report-assigned',
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': config.DELIVERY_LIMIT,
        'x-dead-letter-exchange': 'civic.dlx',
        'x-dead-letter-routing-key': 'report.report-assigned.dlq'
      }
    });
    await rabbitClient.queueBind({
      queue: 'report.report-assigned',
      exchange: 'civic.events',
      routingKey: 'report.assigned'
    });

    await rabbitClient.queueDeclare({
      queue: 'report.category-upserted',
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': config.DELIVERY_LIMIT,
        'x-dead-letter-exchange': 'civic.dlx',
        'x-dead-letter-routing-key': 'report.category-upserted.dlq'
      }
    });
    await rabbitClient.queueBind({
      queue: 'report.category-upserted',
      exchange: 'civic.events',
      routingKey: 'category.upserted'
    });

    await rabbitClient.queueDeclare({
      queue: 'report.image-processed',
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': config.DELIVERY_LIMIT,
        'x-dead-letter-exchange': 'civic.dlx',
        'x-dead-letter-routing-key': 'report.image-processed.dlq'
      }
    });
    await rabbitClient.queueBind({
      queue: 'report.image-processed',
      exchange: 'civic.events',
      routingKey: 'image.processed'
    });
  }

  async function handleReportAssigned(msg: AsyncMessage): Promise<ConsumerStatus> {
    let data: EventEnvelope<{
      reportId: string;
      wardCode?: string | null;
      departmentCode: string;
      departmentName: string;
      departmentEmail: string;
      source: 'auto' | 'manual';
      assignedAt: string;
    }>;

    if (typeof msg.body === 'object' && msg.body !== null && !Buffer.isBuffer(msg.body)) {
      data = msg.body as unknown as typeof data;
    } else {
      try {
        const raw = Buffer.isBuffer(msg.body) ? msg.body.toString('utf8') : String(msg.body);
        data = JSON.parse(raw);
      } catch {
        logger.warn('Unparseable message JSON in report.report-assigned, rejecting to DLQ');
        return ConsumerStatus.DROP;
      }
    }

    const validation = validator.validateIncomingEvent('report.assigned', data);
    if (!validation.valid) {
      logger.warn(
        { eventId: data?.eventId, error: validation.errors },
        'Schema validation failed for report.assigned, rejecting to DLQ'
      );
      return ConsumerStatus.DROP;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Inbox deduplication
      const inboxRes = await client.query(
        `INSERT INTO processed_events (event_id, consumer, processed_at)
         VALUES ($1, 'report.report-assigned', clock_timestamp())
         ON CONFLICT (event_id, consumer) DO NOTHING
         RETURNING event_id;`,
        [data.eventId]
      );

      if (inboxRes.rows.length === 0) {
        await client.query('COMMIT');
        logger.info({ eventId: data.eventId }, 'report.assigned already processed, skipping');
        return ConsumerStatus.ACK;
      }

      const payload = data.payload;
      const reportRes = await client.query(
        `SELECT id, status, version FROM reports WHERE id = $1 FOR UPDATE;`,
        [payload.reportId]
      );

      if (reportRes.rows.length === 0) {
        await client.query('ROLLBACK');
        logger.warn(
          { reportId: payload.reportId },
          'Report not found for assignment, requeueing as transient error'
        );
        return ConsumerStatus.REQUEUE;
      }

      const report = reportRes.rows[0];
      const currentStatus = report.status as ReportStatus;
      const now = new Date();

      if (['Submitted', 'Verified', 'Reopened'].includes(currentStatus)) {
        const transitionResult = validateStatusTransition({
          from: currentStatus,
          to: 'Assigned',
          role: 'system'
        });

        if (!transitionResult.valid) {
          logger.warn(
            { reportId: payload.reportId, currentStatus, error: transitionResult.message },
            'Invalid status transition to Assigned'
          );
          await client.query('ROLLBACK');
          return ConsumerStatus.DROP;
        }

        // Transition to Assigned
        const newVersion = report.version + 1;
        const note =
          payload.source === 'auto'
            ? 'Automatic assignment by routing service'
            : 'Manual assignment by administrator';

        await client.query(
          `UPDATE reports
           SET status = 'Assigned',
               ward_code = $1,
               department_code = $2,
               version = $3,
               updated_at = $4
           WHERE id = $5;`,
          [payload.wardCode || null, payload.departmentCode, newVersion, now, payload.reportId]
        );

        await client.query(
          `INSERT INTO status_history (report_id, from_status, to_status, note, changed_by, changed_at)
           VALUES ($1, $2, 'Assigned', $3, 'system', $4);`,
          [payload.reportId, currentStatus, note, now]
        );

        // Stage report.status-changed outbox event
        const statusEventId = randomUUID();
        const occurredAt = now.toISOString();
        const statusPayload = {
          reportId: payload.reportId,
          fromStatus: currentStatus,
          toStatus: 'Assigned',
          changedBy: 'system',
          changedAt: occurredAt,
          note
        };

        const statusEnvelope = {
          eventId: statusEventId,
          eventType: 'report.status-changed',
          version: 1,
          occurredAt,
          correlationId: data.correlationId || randomUUID(),
          payload: statusPayload
        };

        validator.validateEvent('report.status-changed', statusEnvelope);

        await client.query(
          `INSERT INTO outbox_events (event_id, event_type, version, correlation_id, payload, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6);`,
          [
            statusEventId,
            'report.status-changed',
            1,
            statusEnvelope.correlationId,
            JSON.stringify(statusPayload),
            occurredAt
          ]
        );
        logger.info(
          { reportId: payload.reportId, wardCode: payload.wardCode, dept: payload.departmentCode },
          'Report transitioned to Assigned'
        );
      } else {
        // Already Assigned or further: update ward/dept metadata without status transition
        await client.query(
          `UPDATE reports
           SET ward_code = $1,
               department_code = $2,
               updated_at = $3
           WHERE id = $4;`,
          [payload.wardCode || null, payload.departmentCode, now, payload.reportId]
        );
        logger.info(
          { reportId: payload.reportId, currentStatus },
          'Report assignment updated without status change'
        );
      }

      await client.query('COMMIT');
      return ConsumerStatus.ACK;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ err, eventId: data.eventId }, 'Transient error processing report.assigned');
      return ConsumerStatus.REQUEUE;
    } finally {
      client.release();
    }
  }

  async function handleCategoryUpserted(msg: AsyncMessage): Promise<ConsumerStatus> {
    let data: EventEnvelope<{
      slug: string;
      name: string;
      active: boolean;
      departmentCode: string;
      updatedAt: string;
    }>;

    if (typeof msg.body === 'object' && msg.body !== null && !Buffer.isBuffer(msg.body)) {
      data = msg.body as unknown as typeof data;
    } else {
      try {
        const raw = Buffer.isBuffer(msg.body) ? msg.body.toString('utf8') : String(msg.body);
        data = JSON.parse(raw);
      } catch {
        logger.warn('Unparseable message JSON in report.category-upserted, rejecting to DLQ');
        return ConsumerStatus.DROP;
      }
    }

    const validation = validator.validateIncomingEvent('category.upserted', data);
    if (!validation.valid) {
      logger.warn(
        { eventId: data?.eventId, error: validation.errors },
        'Schema validation failed for category.upserted, rejecting to DLQ'
      );
      return ConsumerStatus.DROP;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const inboxRes = await client.query(
        `INSERT INTO processed_events (event_id, consumer, processed_at)
         VALUES ($1, 'report.category-upserted', clock_timestamp())
         ON CONFLICT (event_id, consumer) DO NOTHING
         RETURNING event_id;`,
        [data.eventId]
      );

      if (inboxRes.rows.length === 0) {
        await client.query('COMMIT');
        logger.info({ eventId: data.eventId }, 'category.upserted already processed, skipping');
        return ConsumerStatus.ACK;
      }

      const p = data.payload;
      await client.query(
        `INSERT INTO categories (slug, name, active, department_code)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name,
           active = EXCLUDED.active,
           department_code = EXCLUDED.department_code;`,
        [p.slug, p.name, p.active, p.departmentCode]
      );

      await client.query('COMMIT');
      logger.info({ slug: p.slug, dept: p.departmentCode }, 'Upserted category in local cache');
      return ConsumerStatus.ACK;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ err, eventId: data.eventId }, 'Transient error processing category.upserted');
      return ConsumerStatus.REQUEUE;
    } finally {
      client.release();
    }
  }

  async function handleImageProcessed(msg: AsyncMessage): Promise<ConsumerStatus> {
    let data: EventEnvelope<{
      imageId: string;
      ownerId: string;
      status: 'ready' | 'rejected';
      width?: number | null;
      height?: number | null;
      gpsPresent: boolean;
      rejectReason?: string | null;
      processedAt: string;
    }>;

    if (typeof msg.body === 'object' && msg.body !== null && !Buffer.isBuffer(msg.body)) {
      data = msg.body as unknown as typeof data;
    } else {
      try {
        const raw = Buffer.isBuffer(msg.body) ? msg.body.toString('utf8') : String(msg.body);
        data = JSON.parse(raw);
      } catch {
        logger.warn('Unparseable message JSON in report.image-processed, rejecting to DLQ');
        return ConsumerStatus.DROP;
      }
    }

    const validation = validator.validateIncomingEvent('image.processed', data);
    if (!validation.valid) {
      logger.warn(
        { eventId: data?.eventId, error: validation.errors },
        'Schema validation failed for image.processed, rejecting to DLQ'
      );
      return ConsumerStatus.DROP;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Inbox deduplication
      const inboxRes = await client.query(
        `INSERT INTO processed_events (event_id, consumer, processed_at)
         VALUES ($1, 'report.image-processed', clock_timestamp())
         ON CONFLICT (event_id, consumer) DO NOTHING
         RETURNING event_id;`,
        [data.eventId]
      );

      if (inboxRes.rows.length === 0) {
        await client.query('COMMIT');
        logger.info({ eventId: data.eventId }, 'image.processed already processed, skipping');
        return ConsumerStatus.ACK;
      }

      const p = data.payload;

      // 2. Upsert into images_seen (handles out-of-order events where image.processed arrives before report is created)
      await client.query(
        `INSERT INTO images_seen (image_id, owner_id, status, processed_at, width, height, gps_present, reject_reason, seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (image_id) DO UPDATE SET
           owner_id = EXCLUDED.owner_id,
           status = EXCLUDED.status,
           processed_at = EXCLUDED.processed_at,
           width = EXCLUDED.width,
           height = EXCLUDED.height,
           gps_present = EXCLUDED.gps_present,
           reject_reason = EXCLUDED.reject_reason,
           seen_at = NOW();`,
        [
          p.imageId,
          p.ownerId,
          p.status,
          p.processedAt,
          p.width ?? null,
          p.height ?? null,
          p.gpsPresent ?? false,
          p.rejectReason ?? null
        ]
      );

      // 3. Update report_photos if any report already references this image.
      // If the report's reporter_id != p.ownerId, mark photo rejected for ownership mismatch.
      await client.query(
        `UPDATE report_photos rp
         SET status = CASE
               WHEN r.reporter_id != $1 THEN 'rejected'
               ELSE $2
             END,
             reject_reason = CASE
               WHEN r.reporter_id != $1 THEN 'ownership_mismatch'
               ELSE $3
             END,
             width = $4,
             height = $5,
             gps_present = $6,
             updated_at = NOW()
         FROM reports r
         WHERE rp.report_id = r.id AND rp.image_id = $7;`,
        [
          p.ownerId,
          p.status,
          p.rejectReason ?? null,
          p.width ?? null,
          p.height ?? null,
          p.gpsPresent ?? false,
          p.imageId
        ]
      );

      await client.query('COMMIT');
      logger.info({ imageId: p.imageId, status: p.status }, 'Processed image.processed event');
      return ConsumerStatus.ACK;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ err, eventId: data.eventId }, 'Transient error processing image.processed');
      return ConsumerStatus.REQUEUE;
    } finally {
      client.release();
    }
  }

  return {
    async start(): Promise<void> {
      await initTopology();

      const assignedConsumer = rabbitClient.createConsumer(
        {
          queue: 'report.report-assigned',
          queueOptions: {
            durable: true,
            arguments: {
              'x-queue-type': 'quorum',
              'x-delivery-limit': config.DELIVERY_LIMIT,
              'x-dead-letter-exchange': 'civic.dlx',
              'x-dead-letter-routing-key': 'report.report-assigned.dlq'
            }
          },
          qos: { prefetchCount: 10 }
        },
        handleReportAssigned
      );
      consumers.push(assignedConsumer);

      const categoryConsumer = rabbitClient.createConsumer(
        {
          queue: 'report.category-upserted',
          queueOptions: {
            durable: true,
            arguments: {
              'x-queue-type': 'quorum',
              'x-delivery-limit': config.DELIVERY_LIMIT,
              'x-dead-letter-exchange': 'civic.dlx',
              'x-dead-letter-routing-key': 'report.category-upserted.dlq'
            }
          },
          qos: { prefetchCount: 10 }
        },
        handleCategoryUpserted
      );
      consumers.push(categoryConsumer);

      const imageConsumer = rabbitClient.createConsumer(
        {
          queue: 'report.image-processed',
          queueOptions: {
            durable: true,
            arguments: {
              'x-queue-type': 'quorum',
              'x-delivery-limit': config.DELIVERY_LIMIT,
              'x-dead-letter-exchange': 'civic.dlx',
              'x-dead-letter-routing-key': 'report.image-processed.dlq'
            }
          },
          qos: { prefetchCount: 10 }
        },
        handleImageProcessed
      );
      consumers.push(imageConsumer);

      logger.info(
        'Started report consumers for report.report-assigned, report.category-upserted, and report.image-processed'
      );
    },

    async stop(): Promise<void> {
      for (const consumer of consumers) {
        await consumer.close();
      }
      logger.info('Stopped report consumers');
    }
  };
}
