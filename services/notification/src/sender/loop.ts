import pg from 'pg';
import { Transporter } from 'nodemailer';
import { Logger } from 'pino';
import { Config } from '../config.js';

export interface SenderLoopOptions {
  config: Config;
  pool: pg.Pool;
  mailer: Transporter;
  logger: Logger;
}

export interface SenderLoop {
  start(): void;
  stop(): Promise<void>;
  processBatch(): Promise<number>;
}

export function createSenderLoop(options: SenderLoopOptions): SenderLoop {
  const { config, pool, mailer, logger } = options;
  let isRunning = false;
  let timer: NodeJS.Timeout | null = null;
  let activeExecution: Promise<number> | null = null;

  async function processBatch(): Promise<number> {
    const client = await pool.connect();
    let sentCount = 0;

    try {
      await client.query('BEGIN');

      const selectResult = await client.query<{
        id: string;
        kind: string;
        recipient_email: string;
        subject: string;
        body: string;
        attempts: number;
      }>(
        `SELECT id, kind, recipient_email, subject, body, attempts
         FROM notifications
         WHERE status = 'pending' AND next_attempt_at <= clock_timestamp()
         ORDER BY created_at ASC
         LIMIT 20
         FOR UPDATE SKIP LOCKED;`
      );

      const rows = selectResult.rows;

      for (const row of rows) {
        const nextAttempts = row.attempts + 1;
        try {
          await mailer.sendMail({
            from: config.SMTP_FROM,
            to: row.recipient_email,
            subject: row.subject,
            text: row.body
          });

          await client.query(
            `UPDATE notifications
             SET status = 'sent',
                 sent_at = clock_timestamp(),
                 attempts = $2,
                 last_error = NULL
             WHERE id = $1;`,
            [row.id, nextAttempts]
          );

          logger.info(
            { notificationId: row.id, kind: row.kind, attempts: nextAttempts },
            'Notification sent successfully'
          );
          sentCount++;
        } catch (err) {
          const errMsg = (err as Error).message;
          if (nextAttempts >= 5) {
            await client.query(
              `UPDATE notifications
               SET status = 'failed',
                   attempts = $2,
                   last_error = $3
               WHERE id = $1;`,
              [row.id, nextAttempts, errMsg]
            );

            logger.warn(
              {
                notificationId: row.id,
                kind: row.kind,
                attempts: nextAttempts,
                error: errMsg
              },
              'Notification failed after maximum attempts'
            );
          } else {
            const backoffSeconds = Math.pow(2, nextAttempts);
            await client.query(
              `UPDATE notifications
               SET attempts = $2,
                   next_attempt_at = clock_timestamp() + ($3 * interval '1 second'),
                   last_error = $4
               WHERE id = $1;`,
              [row.id, nextAttempts, backoffSeconds, errMsg]
            );

            logger.warn(
              {
                notificationId: row.id,
                kind: row.kind,
                attempts: nextAttempts,
                backoffSeconds,
                error: errMsg
              },
              'Notification sending failed, scheduled for retry'
            );
          }
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ err }, 'Error during notification sender batch processing');
    } finally {
      client.release();
    }

    return sentCount;
  }

  function scheduleNext() {
    if (!isRunning) return;
    timer = setTimeout(async () => {
      try {
        activeExecution = processBatch();
        await activeExecution;
      } catch (err) {
        logger.error({ err }, 'Unhandled error in sender loop');
      } finally {
        activeExecution = null;
        scheduleNext();
      }
    }, config.SENDER_INTERVAL_MS);
  }

  return {
    start() {
      if (isRunning) return;
      isRunning = true;
      scheduleNext();
      logger.info('Notification sender loop started');
    },
    async stop() {
      isRunning = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (activeExecution) {
        await activeExecution.catch(() => {});
      }
      logger.info('Notification sender loop stopped');
    },
    processBatch
  };
}
