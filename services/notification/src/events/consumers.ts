import crypto from 'node:crypto';
import pg from 'pg';
import { Connection, Consumer, ConsumerStatus, AsyncMessage } from 'rabbitmq-client';
import { Logger } from 'pino';
import { Config } from '../config.js';
import { ConsumerEventValidator, EventEnvelope } from './validator.js';

export interface NotificationConsumers {
  start(): Promise<void>;
  stop(): Promise<void>;
  getMetrics(): { waitingCount: number; processedCount: number };
  getWaitingCount(): Promise<number>;
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
  const metrics = { processedCount: 0 };

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

        await client.query(
          `INSERT INTO notifications (id, event_id, kind, recipient_user_id, report_id, data, status, created_at, next_attempt_at)
           VALUES ($1, $2, 'welcome', $3, NULL, NULL, 'pending', clock_timestamp(), clock_timestamp())
           ON CONFLICT (event_id, kind) DO NOTHING;`,
          [crypto.randomUUID(), data.eventId, payload.userId]
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

        await client.query(
          `INSERT INTO notifications (id, event_id, kind, recipient_user_id, report_id, data, status, created_at, next_attempt_at)
           VALUES ($1, $2, 'report_received', $3, $4, NULL, 'pending', clock_timestamp(), clock_timestamp())
           ON CONFLICT (event_id, kind) DO NOTHING;`,
          [crypto.randomUUID(), data.eventId, payload.reporterId, payload.reportId]
        );
      } else if (data.eventType === 'report.status-changed') {
        const payload = data.payload as {
          reportId: string;
          fromStatus: string;
          toStatus: string;
        };

        const repRes = await client.query<{ reporter_id: string }>(
          `SELECT reporter_id FROM report_index WHERE report_id = $1`,
          [payload.reportId]
        );

        const reporterId = repRes.rows.length > 0 ? repRes.rows[0].reporter_id : null;

        await client.query(
          `INSERT INTO notifications (id, event_id, kind, recipient_user_id, report_id, data, status, created_at, next_attempt_at)
           VALUES ($1, $2, 'status_changed', $3, $4, $5, 'pending', clock_timestamp(), clock_timestamp())
           ON CONFLICT (event_id, kind) DO NOTHING;`,
          [
            crypto.randomUUID(),
            data.eventId,
            reporterId,
            payload.reportId,
            JSON.stringify({ toStatus: payload.toStatus, fromStatus: payload.fromStatus })
          ]
        );
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
    async getWaitingCount(): Promise<number> {
      const res = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM notifications WHERE status = 'pending' AND last_error = 'waiting for recipient data';`
      );
      return parseInt(res.rows[0]?.count || '0', 10);
    },
    getMetrics() {
      return { waitingCount: 0, processedCount: metrics.processedCount };
    }
  };
}
