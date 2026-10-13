import { Connection, Publisher } from 'rabbitmq-client';
import pg from 'pg';
import { Config } from '../config.js';
import { createLogger } from '../logger.js';

export interface OutboxRelay {
  start(): void;
  stop(): Promise<void>;
  processBatch(): Promise<number>;
  isRabbitConnected(): boolean;
}

export function createOutboxRelay(options: {
  config: Config;
  pool: pg.Pool;
  logger: ReturnType<typeof createLogger>;
  rabbitmqConnection?: Connection;
}): OutboxRelay {
  const { config, pool, logger } = options;
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let rabbitConnected = false;

  const rabbit = options.rabbitmqConnection || new Connection(config.RABBITMQ_URL);

  if (rabbit.ready) {
    rabbitConnected = true;
  }

  rabbit.on('connection', () => {
    rabbitConnected = true;
    logger.info('RabbitMQ connection established for outbox relay');
  });

  rabbit.on('error', (err) => {
    rabbitConnected = false;
    logger.error({ err }, 'RabbitMQ connection error in outbox relay');
  });

  const publisher: Publisher = rabbit.createPublisher({
    confirm: true,
    maxAttempts: 3,
    exchanges: [{ exchange: 'civic.events', type: 'topic', durable: true }]
  });

  async function processBatch(): Promise<number> {
    const client = await pool.connect();
    let publishedCount = 0;

    try {
      await client.query('BEGIN');

      const result = await client.query(`
        SELECT id, event_id, event_type, version, correlation_id, payload, occurred_at
        FROM outbox_events
        WHERE published_at IS NULL
        ORDER BY occurred_at ASC
        LIMIT 50
        FOR UPDATE SKIP LOCKED;
      `);

      const events = result.rows;

      for (const row of events) {
        const occurredAtIso =
          row.occurred_at instanceof Date
            ? row.occurred_at.toISOString()
            : new Date(row.occurred_at).toISOString();

        const envelope = {
          eventId: row.event_id,
          eventType: row.event_type,
          version: Number(row.version),
          occurredAt: occurredAtIso,
          correlationId: row.correlation_id,
          payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
        };

        const epochTimestamp = Math.floor(new Date(occurredAtIso).getTime() / 1000);

        // Publish to topic exchange with confirms and AMQP properties mapping
        await publisher.send(
          {
            exchange: 'civic.events',
            routingKey: row.event_type,
            messageId: row.event_id,
            type: row.event_type,
            correlationId: row.correlation_id,
            contentType: 'application/json',
            contentEncoding: 'utf-8',
            durable: true,
            timestamp: epochTimestamp
          },
          envelope
        );

        await client.query(`UPDATE outbox_events SET published_at = NOW() WHERE id = $1`, [row.id]);

        publishedCount++;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ err }, 'Outbox relay error processing batch');
    } finally {
      client.release();
    }

    return publishedCount;
  }

  async function pollLoop() {
    if (!running || inFlight) return;
    inFlight = true;

    try {
      const processed = await processBatch();
      if (running) {
        if (processed >= 50) {
          // Immediately process next batch if full batch was retrieved
          setImmediate(pollLoop);
          return;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Unexpected error in outbox relay loop');
    } finally {
      inFlight = false;
      if (running) {
        timer = setTimeout(pollLoop, config.OUTBOX_INTERVAL_MS);
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      timer = setTimeout(pollLoop, config.OUTBOX_INTERVAL_MS);
      logger.info('Outbox relay started');
    },

    async stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        await publisher.close();
      } catch {
        // ignore
      }
      try {
        if (!options.rabbitmqConnection) {
          await rabbit.close();
        }
      } catch {
        // ignore
      }
      logger.info('Outbox relay stopped');
    },

    processBatch,

    isRabbitConnected() {
      return rabbitConnected || Boolean(rabbit && rabbit.ready);
    }
  };
}
