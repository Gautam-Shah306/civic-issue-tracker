import pg from 'pg';
import { Transporter } from 'nodemailer';
import { Logger } from 'pino';
import { Config } from '../config.js';
import {
  renderWelcomeEmail,
  renderReportReceivedEmail,
  renderStatusChangedEmail
} from './mailer.js';

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
    // 1. Claim a batch in a short transaction with a lease (default 60s)
    const client = await pool.connect();
    let claimedRows: Array<{
      id: string;
      event_id: string;
      kind: string;
      recipient_user_id: string | null;
      report_id: string | null;
      data: unknown;
      attempts: number;
      created_at: Date;
    }> = [];

    try {
      await client.query('BEGIN');

      const selectResult = await client.query<{
        id: string;
        event_id: string;
        kind: string;
        recipient_user_id: string | null;
        report_id: string | null;
        data: unknown;
        attempts: number;
        created_at: Date;
      }>(
        `SELECT id, event_id, kind, recipient_user_id, report_id, data, attempts, created_at
         FROM notifications
         WHERE status = 'pending' AND next_attempt_at <= clock_timestamp()
         ORDER BY created_at ASC
         LIMIT 20
         FOR UPDATE SKIP LOCKED;`
      );

      claimedRows = selectResult.rows;

      if (claimedRows.length > 0) {
        const ids = claimedRows.map((r) => r.id);
        await client.query(
          `UPDATE notifications
           SET next_attempt_at = clock_timestamp() + ($2 * interval '1 second')
           WHERE id = ANY($1);`,
          [ids, config.SENDER_LEASE_SECONDS]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ err }, 'Error during notification batch lease claim');
      return 0;
    } finally {
      client.release();
    }

    if (claimedRows.length === 0) {
      return 0;
    }

    // 2. Process each claimed notification outside of any DB transaction
    let sentCount = 0;
    const now = Date.now();

    for (const row of claimedRows) {
      const ageSeconds = (now - new Date(row.created_at).getTime()) / 1000;

      // 1-hour wait timeout for missing recipient data
      if (ageSeconds >= config.SENDER_WAIT_TIMEOUT_SECONDS) {
        await pool.query(
          `UPDATE notifications
           SET status = 'failed',
               last_error = 'waiting for recipient data timeout (1 hour)'
           WHERE id = $1;`,
          [row.id]
        );
        logger.warn(
          { notificationId: row.id, kind: row.kind, ageSeconds },
          'Notification failed after recipient data timeout'
        );
        continue;
      }

      // Resolve recipient data at send time
      let recipientUserId = row.recipient_user_id;
      let reportTitle: string | null = null;
      let recipientEmail: string | null = null;
      let recipientDisplayName: string | null = null;

      if (row.report_id) {
        const repRes = await pool.query<{ reporter_id: string; title: string }>(
          `SELECT reporter_id, title FROM report_index WHERE report_id = $1;`,
          [row.report_id]
        );
        if (repRes.rows.length > 0) {
          reportTitle = repRes.rows[0].title;
          if (!recipientUserId) {
            recipientUserId = repRes.rows[0].reporter_id;
          }
        }
      }

      if (recipientUserId) {
        const recRes = await pool.query<{ email: string; display_name: string }>(
          `SELECT email, display_name FROM recipients WHERE user_id = $1;`,
          [recipientUserId]
        );
        if (recRes.rows.length > 0) {
          recipientEmail = recRes.rows[0].email;
          recipientDisplayName = recRes.rows[0].display_name;
        }
      }

      const isDataMissing =
        !recipientEmail || !recipientDisplayName || (row.kind !== 'welcome' && !reportTitle);

      if (isDataMissing) {
        await pool.query(
          `UPDATE notifications
           SET next_attempt_at = clock_timestamp() + interval '10 second',
               recipient_user_id = COALESCE(recipient_user_id, $2),
               last_error = 'waiting for recipient data'
           WHERE id = $1;`,
          [row.id, recipientUserId || null]
        );
        logger.info(
          { notificationId: row.id, kind: row.kind },
          'Recipient data not yet available, staying pending'
        );
        continue;
      }

      // Render email templates
      let emailSubject: string;
      let emailBody: string;

      const dataObj =
        typeof row.data === 'string'
          ? JSON.parse(row.data)
          : (row.data as Record<string, unknown> | null);

      if (row.kind === 'welcome') {
        const rendered = renderWelcomeEmail(recipientDisplayName!);
        emailSubject = rendered.subject;
        emailBody = rendered.text;
      } else if (row.kind === 'report_received') {
        const rendered = renderReportReceivedEmail(
          recipientDisplayName!,
          reportTitle!,
          row.report_id!
        );
        emailSubject = rendered.subject;
        emailBody = rendered.text;
      } else if (row.kind === 'status_changed') {
        const toStatus = String(dataObj?.toStatus || 'Updated');
        const rendered = renderStatusChangedEmail(
          recipientDisplayName!,
          reportTitle!,
          toStatus,
          row.report_id!
        );
        emailSubject = rendered.subject;
        emailBody = rendered.text;
      } else {
        emailSubject = `Notification: ${row.kind}`;
        emailBody = `Hello ${recipientDisplayName},\n\nYou have an update regarding civic report.`;
      }

      // Send through SMTP (outside of any DB transaction)
      const nextAttempts = row.attempts + 1;
      try {
        await mailer.sendMail({
          from: config.SMTP_FROM,
          to: recipientEmail!,
          subject: emailSubject,
          text: emailBody
        });

        await pool.query(
          `UPDATE notifications
           SET status = 'sent',
               sent_at = clock_timestamp(),
               attempts = $2,
               recipient_user_id = $3,
               recipient_email = $4,
               subject = $5,
               body = $6,
               last_error = NULL
           WHERE id = $1;`,
          [row.id, nextAttempts, recipientUserId, recipientEmail, emailSubject, emailBody]
        );

        logger.info(
          { notificationId: row.id, kind: row.kind, attempts: nextAttempts },
          'Notification sent successfully'
        );
        sentCount++;
      } catch (err) {
        const errMsg = (err as Error).message;
        if (nextAttempts >= config.SENDER_MAX_ATTEMPTS) {
          await pool.query(
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
          const backoffSeconds = Math.min(
            Math.pow(2, nextAttempts),
            config.SENDER_BACKOFF_CAP_SECONDS
          );
          await pool.query(
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
