import pg from 'pg';
import { Connection, Consumer, ConsumerStatus, AsyncMessage } from 'rabbitmq-client';
import { Logger } from 'pino';
import { Config } from '../config.js';
import { AnalyticsEventValidator, EventEnvelope } from './validator.js';

export interface AnalyticsConsumers {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createAnalyticsConsumers(options: {
  config: Config;
  pool: pg.Pool;
  rabbitClient: Connection;
  validator: AnalyticsEventValidator;
  logger: Logger;
  onHandlerError?: (queue: string, err: Error) => void;
}): AnalyticsConsumers {
  const { config, pool, rabbitClient, validator, logger, onHandlerError } = options;
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
    const dlqs = ['analytics.audit.dlq', 'analytics.stats.dlq'];
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
      queue: 'analytics.audit',
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': config.DELIVERY_LIMIT,
        'x-dead-letter-exchange': 'civic.dlx',
        'x-dead-letter-routing-key': 'analytics.audit.dlq'
      }
    });
    await rabbitClient.queueBind({
      queue: 'analytics.audit',
      exchange: 'civic.events',
      routingKey: '#'
    });

    await rabbitClient.queueDeclare({
      queue: 'analytics.stats',
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': config.DELIVERY_LIMIT,
        'x-dead-letter-exchange': 'civic.dlx',
        'x-dead-letter-routing-key': 'analytics.stats.dlq'
      }
    });
    await rabbitClient.queueBind({
      queue: 'analytics.stats',
      exchange: 'civic.events',
      routingKey: 'report.submitted'
    });
    await rabbitClient.queueBind({
      queue: 'analytics.stats',
      exchange: 'civic.events',
      routingKey: 'report.status-changed'
    });
  }

  async function handleAuditMessage(msg: AsyncMessage): Promise<ConsumerStatus> {
    let data: EventEnvelope;
    if (typeof msg.body === 'object' && msg.body !== null && !Buffer.isBuffer(msg.body)) {
      data = msg.body as EventEnvelope;
    } else {
      try {
        const raw = Buffer.isBuffer(msg.body) ? msg.body.toString('utf8') : String(msg.body);
        data = JSON.parse(raw);
      } catch {
        logger.warn('Audit consumer: invalid JSON, dropping to DLQ');
        return ConsumerStatus.DROP;
      }
    }

    const envValidation = validator.validateEnvelope(data);
    if (!envValidation.valid) {
      const rawData = data as unknown as Record<string, unknown>;
      logger.warn(
        { eventId: rawData?.eventId, eventType: rawData?.eventType, error: envValidation.errors },
        'Audit consumer: invalid envelope, dropping to DLQ'
      );
      return ConsumerStatus.DROP;
    }

    const payload = (data.payload || {}) as Record<string, unknown>;
    const actor = (payload.changedBy || payload.reporterId || payload.userId || null) as
      string | null;

    let subjectType: string | null = null;
    let subjectId: string | null = null;

    if (data.eventType.startsWith('report.')) {
      subjectType = 'report';
      subjectId = (payload.reportId as string) || null;
    } else if (data.eventType.startsWith('user.')) {
      subjectType = 'user';
      subjectId = (payload.userId as string) || null;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const inboxRes = await client.query(
        `INSERT INTO processed_events (event_id, consumer, processed_at)
         VALUES ($1, 'analytics-audit', clock_timestamp())
         ON CONFLICT (event_id, consumer) DO NOTHING
         RETURNING event_id;`,
        [data.eventId]
      );

      if (inboxRes.rows.length === 0) {
        await client.query('COMMIT');
        return ConsumerStatus.ACK;
      }

      await client.query(
        `INSERT INTO audit_log (
           event_id, event_type, version, correlation_id, occurred_at, received_at,
           actor, subject_type, subject_id, payload
         )
         VALUES ($1, $2, $3, $4, $5, clock_timestamp(), $6, $7, $8, $9)
         ON CONFLICT (event_id) DO NOTHING;`,
        [
          data.eventId,
          data.eventType,
          data.version,
          data.correlationId,
          data.occurredAt,
          actor,
          subjectType,
          subjectId,
          JSON.stringify(payload)
        ]
      );

      await client.query('COMMIT');
      return ConsumerStatus.ACK;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ err, eventId: data.eventId }, 'Error in audit consumer transaction');
      if (onHandlerError) onHandlerError('audit', err as Error);
      const attemptCount = Number(
        msg.headers?.['x-acquired-count'] ?? msg.headers?.['x-delivery-count'] ?? 1
      );
      if (attemptCount >= config.DELIVERY_LIMIT) {
        logger.warn(
          { eventId: data.eventId, attemptCount, limit: config.DELIVERY_LIMIT },
          'Audit message reached delivery limit, dropping to DLQ'
        );
        return ConsumerStatus.DROP;
      }
      return ConsumerStatus.REQUEUE;
    } finally {
      client.release();
    }
  }

  async function handleStatsMessage(msg: AsyncMessage): Promise<ConsumerStatus> {
    let data: EventEnvelope;
    if (typeof msg.body === 'object' && msg.body !== null && !Buffer.isBuffer(msg.body)) {
      data = msg.body as EventEnvelope;
    } else {
      try {
        const raw = Buffer.isBuffer(msg.body) ? msg.body.toString('utf8') : String(msg.body);
        data = JSON.parse(raw);
      } catch {
        logger.warn('Stats consumer: invalid JSON, dropping to DLQ');
        return ConsumerStatus.DROP;
      }
    }

    const envValidation = validator.validateEnvelope(data);
    if (!envValidation.valid) {
      const rawData = data as unknown as Record<string, unknown>;
      logger.warn(
        { eventId: rawData?.eventId, eventType: rawData?.eventType, error: envValidation.errors },
        'Stats consumer: invalid envelope, dropping to DLQ'
      );
      return ConsumerStatus.DROP;
    }

    const payloadValidation = validator.validatePayload(data.eventType, data);
    if (!payloadValidation.valid) {
      logger.warn(
        { eventId: data.eventId, eventType: data.eventType, error: payloadValidation.errors },
        'Stats consumer: invalid payload, dropping to DLQ'
      );
      return ConsumerStatus.DROP;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const inboxRes = await client.query(
        `INSERT INTO processed_events (event_id, consumer, processed_at)
         VALUES ($1, 'analytics-stats', clock_timestamp())
         ON CONFLICT (event_id, consumer) DO NOTHING
         RETURNING event_id;`,
        [data.eventId]
      );

      if (inboxRes.rows.length === 0) {
        await client.query('COMMIT');
        return ConsumerStatus.ACK;
      }

      if (data.eventType === 'report.submitted') {
        const p = data.payload as {
          reportId: string;
          category: string;
          submittedAt?: string;
        };
        const submittedAt = p.submittedAt || data.occurredAt;
        await client.query(
          `INSERT INTO report_index (
             report_id, category, current_status, created_at, resolved_at, last_event_at
           )
           VALUES ($1, $2, 'Submitted', $3, NULL, $3)
           ON CONFLICT (report_id) DO UPDATE SET
             category = EXCLUDED.category,
             created_at = EXCLUDED.created_at;`,
          [p.reportId, p.category, submittedAt]
        );
      } else if (data.eventType === 'report.status-changed') {
        const p = data.payload as {
          reportId: string;
          toStatus: string;
          changedAt?: string;
        };
        const changedAt = p.changedAt || data.occurredAt;
        const resolvedAt = p.toStatus === 'Resolved' ? changedAt : null;

        await client.query(
          `INSERT INTO report_index (
             report_id, category, current_status, created_at, resolved_at, last_event_at
           )
           VALUES ($1, 'unknown', $2, $3, $4, $3)
           ON CONFLICT (report_id) DO UPDATE SET
             current_status = EXCLUDED.current_status,
             resolved_at = CASE
               WHEN EXCLUDED.current_status = 'Resolved' THEN EXCLUDED.resolved_at
               WHEN EXCLUDED.current_status = 'Reopened' THEN NULL
               ELSE report_index.resolved_at
             END,
             last_event_at = EXCLUDED.last_event_at
           WHERE report_index.last_event_at IS NULL OR EXCLUDED.last_event_at > report_index.last_event_at;`,
          [p.reportId, p.toStatus, changedAt, resolvedAt]
        );
      }

      await client.query('COMMIT');
      return ConsumerStatus.ACK;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ err, eventId: data.eventId }, 'Error in stats consumer transaction');
      if (onHandlerError) onHandlerError('stats', err as Error);
      const attemptCount = Number(
        msg.headers?.['x-acquired-count'] ?? msg.headers?.['x-delivery-count'] ?? 1
      );
      if (attemptCount >= config.DELIVERY_LIMIT) {
        logger.warn(
          { eventId: data.eventId, attemptCount, limit: config.DELIVERY_LIMIT },
          'Stats message reached delivery limit, dropping to DLQ'
        );
        return ConsumerStatus.DROP;
      }
      return ConsumerStatus.REQUEUE;
    } finally {
      client.release();
    }
  }

  return {
    async start() {
      await initTopology();

      // 1. Audit queue: binding '#'
      const auditConsumer = rabbitClient.createConsumer(
        {
          queue: 'analytics.audit',
          queueOptions: {
            durable: true,
            arguments: {
              'x-queue-type': 'quorum',
              'x-delivery-limit': config.DELIVERY_LIMIT,
              'x-dead-letter-exchange': 'civic.dlx',
              'x-dead-letter-routing-key': 'analytics.audit.dlq'
            }
          },
          exchanges: [
            { exchange: 'civic.events', type: 'topic', durable: true },
            { exchange: 'civic.dlx', type: 'direct', durable: true }
          ],
          queueBindings: [{ exchange: 'civic.events', routingKey: '#' }],
          qos: { prefetchCount: 10 }
        },
        handleAuditMessage
      );
      auditConsumer.on('error', (err) => {
        logger.warn({ err }, 'Audit consumer error caught');
      });
      consumers.push(auditConsumer);

      // 2. Stats queue: bindings 'report.submitted' and 'report.status-changed'
      const statsConsumer = rabbitClient.createConsumer(
        {
          queue: 'analytics.stats',
          queueOptions: {
            durable: true,
            arguments: {
              'x-queue-type': 'quorum',
              'x-delivery-limit': config.DELIVERY_LIMIT,
              'x-dead-letter-exchange': 'civic.dlx',
              'x-dead-letter-routing-key': 'analytics.stats.dlq'
            }
          },
          exchanges: [
            { exchange: 'civic.events', type: 'topic', durable: true },
            { exchange: 'civic.dlx', type: 'direct', durable: true }
          ],
          queueBindings: [
            { exchange: 'civic.events', routingKey: 'report.submitted' },
            { exchange: 'civic.events', routingKey: 'report.status-changed' }
          ],
          qos: { prefetchCount: 10 }
        },
        handleStatsMessage
      );
      statsConsumer.on('error', (err) => {
        logger.warn({ err }, 'Stats consumer error caught');
      });
      consumers.push(statsConsumer);

      logger.info('Analytics consumers registered and started');
    },
    async stop() {
      for (const consumer of consumers) {
        await consumer.close().catch(() => {});
      }
      logger.info('Analytics consumers stopped');
    }
  };
}
