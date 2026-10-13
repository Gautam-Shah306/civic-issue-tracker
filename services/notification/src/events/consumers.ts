import crypto from 'node:crypto';
import pg from 'pg';
import { Connection, Consumer, ConsumerStatus, AsyncMessage } from 'rabbitmq-client';
import { Logger } from 'pino';
import { Config } from '../config.js';
import { ConsumerEventValidator, EventEnvelope } from './validator.js';
import {
  renderWelcomeEmail,
  renderReportReceivedEmail,
  renderStatusChangedEmail
} from '../sender/mailer.js';

export interface NotificationConsumers {
  start(): Promise<void>;
  stop(): Promise<void>;
  getMetrics(): { unknownRecipientCount: number; processedCount: number };
}

export function createNotificationConsumers(options: {
  config: Config;
  pool: pg.Pool;
  rabbitClient: Connection;
  validator: ConsumerEventValidator;
  logger: Logger;
  onHandlerError?: (eventType: string, err: Error) => void;
  testHook?: (eventId: string) => void;
}): NotificationConsumers {
  const { config, pool, rabbitClient, validator, logger, onHandlerError, testHook } = options;
  const consumers: Consumer[] = [];
  const metrics = { unknownRecipientCount: 0, processedCount: 0 };

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
    const dlqQueues = [
      'notification.user-created.dlq',
      'notification.report-submitted.dlq',
      'notification.report-status-changed.dlq'
    ];

    for (const dlq of dlqQueues) {
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
    const quorumQueues = [
      {
        queue: 'notification.user-created',
        routingKey: 'user.created',
        dlq: 'notification.user-created.dlq'
      },
      {
        queue: 'notification.report-submitted',
        routingKey: 'report.submitted',
        dlq: 'notification.report-submitted.dlq'
      },
      {
        queue: 'notification.report-status-changed',
        routingKey: 'report.status-changed',
        dlq: 'notification.report-status-changed.dlq'
      }
    ];

    for (const q of quorumQueues) {
      await rabbitClient.queueDeclare({
        queue: q.queue,
        durable: true,
        arguments: {
          'x-queue-type': 'quorum',
          'x-delivery-limit': config.DELIVERY_LIMIT,
          'x-dead-letter-exchange': 'civic.dlx',
          'x-dead-letter-routing-key': q.dlq
        }
      });
      await rabbitClient.queueBind({
        queue: q.queue,
        exchange: 'civic.events',
        routingKey: q.routingKey
      });
    }
  }

  async function handleMessage(expectedType: string, msg: AsyncMessage): Promise<ConsumerStatus> {
    let data: EventEnvelope;
    if (typeof msg.body === 'object' && msg.body !== null && !Buffer.isBuffer(msg.body)) {
      data = msg.body as EventEnvelope;
    } else {
      try {
        const raw = Buffer.isBuffer(msg.body) ? msg.body.toString('utf8') : String(msg.body);
        data = JSON.parse(raw);
      } catch {
        logger.warn({ expectedType }, 'Invalid JSON payload received, routing to DLQ');
        return ConsumerStatus.DROP;
      }
    }

    const rawData = data as unknown as Record<string, unknown>;
    const envValidation = validator.validateEnvelope(data);
    if (!envValidation.valid) {
      logger.warn(
        { eventId: rawData?.eventId, eventType: rawData?.eventType, error: envValidation.errors },
        'Event envelope validation failed, routing to DLQ'
      );
      return ConsumerStatus.DROP;
    }

    // Validate payload
    const payloadValidation = validator.validatePayload(data.eventType, data);
    if (!payloadValidation.valid) {
      logger.warn(
        { eventId: data.eventId, eventType: data.eventType, error: payloadValidation.errors },
        'Event payload validation failed, routing to DLQ'
      );
      return ConsumerStatus.DROP;
    }

    const client = await pool.connect();
    try {
      if (testHook) {
        testHook(data.eventId);
      }
      await client.query('BEGIN');

      // Atomic inbox insertion
      const inboxRes = await client.query(
        `INSERT INTO processed_events (event_id, consumer, processed_at)
         VALUES ($1, $2, clock_timestamp())
         ON CONFLICT (event_id, consumer) DO NOTHING
         RETURNING event_id;`,
        [data.eventId, 'notification']
      );

      if (inboxRes.rows.length === 0) {
        await client.query('COMMIT');
        logger.info(
          { eventId: data.eventId, eventType: data.eventType },
          'Event already processed, skipping duplicate'
        );
        return ConsumerStatus.ACK;
      }

      if (data.eventType === 'user.created') {
        const payload = data.payload as {
          userId: string;
          email: string;
          displayName: string;
          role: string;
        };

        await client.query(
          `INSERT INTO recipients (user_id, email, display_name, role, updated_at)
           VALUES ($1, $2, $3, $4, clock_timestamp())
           ON CONFLICT (user_id) DO UPDATE SET
             email = EXCLUDED.email,
             display_name = EXCLUDED.display_name,
             role = EXCLUDED.role,
             updated_at = EXCLUDED.updated_at;`,
          [payload.userId, payload.email, payload.displayName, payload.role]
        );

        const email = renderWelcomeEmail(payload.displayName);
        await client.query(
          `INSERT INTO notifications (id, event_id, kind, recipient_user_id, recipient_email, subject, body, status, created_at, next_attempt_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', clock_timestamp(), clock_timestamp())
           ON CONFLICT (event_id, kind) DO NOTHING;`,
          [
            crypto.randomUUID(),
            data.eventId,
            'welcome',
            payload.userId,
            payload.email,
            email.subject,
            email.text
          ]
        );
      } else if (data.eventType === 'report.submitted') {
        const payload = data.payload as {
          reportId: string;
          reporterId: string;
          title: string;
        };

        await client.query(
          `INSERT INTO report_index (report_id, reporter_id, title, created_at)
           VALUES ($1, $2, $3, clock_timestamp())
           ON CONFLICT (report_id) DO UPDATE SET
             reporter_id = EXCLUDED.reporter_id,
             title = EXCLUDED.title;`,
          [payload.reportId, payload.reporterId, payload.title]
        );

        const recRes = await client.query<{ email: string; display_name: string }>(
          `SELECT email, display_name FROM recipients WHERE user_id = $1`,
          [payload.reporterId]
        );

        if (recRes.rows.length > 0) {
          const rec = recRes.rows[0];
          const email = renderReportReceivedEmail(
            rec.display_name,
            payload.title,
            payload.reportId
          );
          await client.query(
            `INSERT INTO notifications (id, event_id, kind, recipient_user_id, recipient_email, subject, body, status, created_at, next_attempt_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', clock_timestamp(), clock_timestamp())
             ON CONFLICT (event_id, kind) DO NOTHING;`,
            [
              crypto.randomUUID(),
              data.eventId,
              'report_received',
              payload.reporterId,
              rec.email,
              email.subject,
              email.text
            ]
          );
        } else {
          metrics.unknownRecipientCount++;
          logger.warn(
            { reportId: payload.reportId, reporterId: payload.reporterId, eventId: data.eventId },
            'Unknown recipient for report submission; notification skipped'
          );
        }
      } else if (data.eventType === 'report.status-changed') {
        const payload = data.payload as {
          reportId: string;
          fromStatus: string;
          toStatus: string;
        };

        const repRes = await client.query<{ reporter_id: string; title: string }>(
          `SELECT reporter_id, title FROM report_index WHERE report_id = $1`,
          [payload.reportId]
        );

        if (repRes.rows.length > 0) {
          const rep = repRes.rows[0];
          const recRes = await client.query<{ email: string; display_name: string }>(
            `SELECT email, display_name FROM recipients WHERE user_id = $1`,
            [rep.reporter_id]
          );

          if (recRes.rows.length > 0) {
            const rec = recRes.rows[0];
            const email = renderStatusChangedEmail(
              rec.display_name,
              rep.title,
              payload.toStatus,
              payload.reportId
            );
            await client.query(
              `INSERT INTO notifications (id, event_id, kind, recipient_user_id, recipient_email, subject, body, status, created_at, next_attempt_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', clock_timestamp(), clock_timestamp())
               ON CONFLICT (event_id, kind) DO NOTHING;`,
              [
                crypto.randomUUID(),
                data.eventId,
                'status_changed',
                rep.reporter_id,
                rec.email,
                email.subject,
                email.text
              ]
            );
          } else {
            metrics.unknownRecipientCount++;
            logger.warn(
              { reportId: payload.reportId, reporterId: rep.reporter_id, eventId: data.eventId },
              'Unknown recipient for status change; notification skipped'
            );
          }
        } else {
          metrics.unknownRecipientCount++;
          logger.warn(
            { reportId: payload.reportId, eventId: data.eventId },
            'Report not found in index for status change; notification skipped'
          );
        }
      }

      await client.query('COMMIT');
      metrics.processedCount++;
      return ConsumerStatus.ACK;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error(
        { err, eventId: data.eventId, eventType: data.eventType },
        'Error in consumer transaction'
      );
      if (onHandlerError) {
        onHandlerError(data.eventType, err as Error);
      }
      const attemptCount = Number(
        msg.headers?.['x-acquired-count'] ?? msg.headers?.['x-delivery-count'] ?? 1
      );
      if (attemptCount >= config.DELIVERY_LIMIT) {
        logger.warn(
          { eventId: data.eventId, attemptCount, limit: config.DELIVERY_LIMIT },
          'Message reached delivery limit, dropping to DLQ'
        );
        return ConsumerStatus.DROP;
      }
      return ConsumerStatus.REQUEUE;
    } finally {
      client.release();
    }
  }

  function registerConsumer(
    queueName: string,
    routingKey: string,
    dlqRoutingKey: string
  ): Consumer {
    const consumer = rabbitClient.createConsumer(
      {
        queue: queueName,
        queueOptions: {
          durable: true,
          arguments: {
            'x-queue-type': 'quorum',
            'x-delivery-limit': config.DELIVERY_LIMIT,
            'x-dead-letter-exchange': 'civic.dlx',
            'x-dead-letter-routing-key': dlqRoutingKey
          }
        },
        exchanges: [
          { exchange: 'civic.events', type: 'topic', durable: true },
          { exchange: 'civic.dlx', type: 'direct', durable: true }
        ],
        queueBindings: [{ exchange: 'civic.events', routingKey }],
        qos: { prefetchCount: 10 }
      },
      async (msg) => {
        return handleMessage(routingKey, msg);
      }
    );

    consumer.on('error', (err) => {
      logger.warn({ err, queueName }, 'Consumer error caught');
    });

    return consumer;
  }

  return {
    async start() {
      await initTopology();

      consumers.push(
        registerConsumer(
          'notification.user-created',
          'user.created',
          'notification.user-created.dlq'
        ),
        registerConsumer(
          'notification.report-submitted',
          'report.submitted',
          'notification.report-submitted.dlq'
        ),
        registerConsumer(
          'notification.report-status-changed',
          'report.status-changed',
          'notification.report-status-changed.dlq'
        )
      );

      logger.info('Notification consumers registered and started');
    },
    async stop() {
      for (const consumer of consumers) {
        await consumer.close().catch(() => {});
      }
      logger.info('Notification consumers stopped');
    },
    getMetrics() {
      return { ...metrics };
    }
  };
}
