import { randomUUID } from 'node:crypto';
import { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import pg from 'pg';
import { Config } from '../config.js';
import { AppError } from '../errors.js';
import { EventValidator } from '../events/validator.js';
import { JwtVerifier } from '../auth/jwt.js';
import {
  ReportStatus,
  REJECTION_REASON_CODES,
  validateStatusTransition
} from '../domain/transitions.js';

export interface ReportsRouteOptions {
  config: Config;
  pool: pg.Pool;
  eventValidator: EventValidator;
  jwtVerifier: JwtVerifier;
}

const reportStatusEnum = z.enum([
  'Submitted',
  'Verified',
  'Assigned',
  'In Progress',
  'Resolved',
  'Closed',
  'Rejected',
  'Reopened'
]);

const createReportBodySchema = z.object({
  title: z.string().min(1, 'Title is required').max(120, 'Title cannot exceed 120 characters'),
  description: z.string().max(2000, 'Description cannot exceed 2000 characters').default(''),
  category: z.string().regex(/^[a-z0-9-]+$/, 'Category slug must match ^[a-z0-9-]+$'),
  location: z.object({
    lat: z
      .number()
      .min(-90, 'Latitude must be between -90 and 90')
      .max(90, 'Latitude must be between -90 and 90'),
    lng: z
      .number()
      .min(-180, 'Longitude must be between -180 and 180')
      .max(180, 'Longitude must be between -180 and 180'),
    address: z.string().max(300).optional()
  })
});

const updateStatusBodySchema = z.object({
  toStatus: reportStatusEnum,
  reasonCode: z.enum(REJECTION_REASON_CODES).optional(),
  note: z.string().max(500).optional()
});

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  sort: z
    .enum(['created_at:desc', 'created_at:asc', 'updated_at:desc', 'updated_at:asc'])
    .default('created_at:desc')
});

const listOfficerQuerySchema = paginationQuerySchema.extend({
  status: reportStatusEnum.optional(),
  category: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
});

const listMineQuerySchema = paginationQuerySchema.extend({
  status: reportStatusEnum.optional()
});

export const reportsRoutes: FastifyPluginAsync<ReportsRouteOptions> = async (fastify, options) => {
  const { pool, eventValidator, jwtVerifier } = options;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes in this plugin require verified JWT
  app.addHook('preHandler', jwtVerifier.preHandler);

  // POST /api/v1/reports
  app.post(
    '',
    {
      schema: {
        body: createReportBodySchema
      }
    },
    async (request, reply) => {
      const user = request.user!;
      const { title, description, category, location } = request.body;
      const idempotencyKey = (request.headers['idempotency-key'] as string | undefined)?.trim();

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // If Idempotency-Key provided, check if already recorded
        if (idempotencyKey) {
          const idempRes = await client.query(
            'SELECT report_id FROM idempotency_keys WHERE user_id = $1 AND key = $2 FOR UPDATE',
            [user.id, idempotencyKey]
          );

          if (idempRes.rows.length > 0) {
            const existingReportId = idempRes.rows[0].report_id;
            const repRes = await client.query(
              `SELECT id, reporter_id as "reporterId", title, description, category_slug as category,
                      lat, lng, address, status, version, created_at as "createdAt", updated_at as "updatedAt"
               FROM reports WHERE id = $1`,
              [existingReportId]
            );
            await client.query('COMMIT');
            return reply.status(201).send(repRes.rows[0]);
          }
        }

        // Validate category exists and is active
        const catRes = await client.query(
          'SELECT slug FROM categories WHERE slug = $1 AND active = true',
          [category]
        );
        if (catRes.rows.length === 0) {
          await client.query('ROLLBACK');
          throw new AppError({
            statusCode: 400,
            code: 'invalid_category',
            message: `Category '${category}' does not exist or is inactive`
          });
        }

        const reportId = randomUUID();
        const now = new Date();
        const address = location.address || null;

        // 1. Insert report
        const insertReportRes = await client.query(
          `INSERT INTO reports (id, reporter_id, title, description, category_slug, lat, lng, address, status, version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Submitted', 1, $9, $9)
           RETURNING id, reporter_id as "reporterId", title, description, category_slug as category,
                     lat, lng, address, status, version, created_at as "createdAt", updated_at as "updatedAt"`,
          [
            reportId,
            user.id,
            title,
            description,
            category,
            location.lat,
            location.lng,
            address,
            now
          ]
        );

        const createdReport = insertReportRes.rows[0];

        // 2. Insert initial status_history row (null -> Submitted, changed_by user id)
        await client.query(
          `INSERT INTO status_history (report_id, from_status, to_status, reason_code, note, changed_by, changed_at)
           VALUES ($1, NULL, 'Submitted', NULL, NULL, $2, $3)`,
          [reportId, user.id, now]
        );

        // 3. Record idempotency key if provided
        if (idempotencyKey) {
          await client.query(
            `INSERT INTO idempotency_keys (user_id, key, report_id, created_at)
             VALUES ($1, $2, $3, $4)`,
            [user.id, idempotencyKey, reportId, now]
          );
        }

        // 4. Validate and stage domain event report.submitted
        const eventId = randomUUID();
        const occurredAt = now.toISOString();
        const payload = {
          reportId: createdReport.id,
          reporterId: user.id,
          title: createdReport.title,
          description: createdReport.description,
          category: createdReport.category,
          location: {
            lat: createdReport.lat,
            lng: createdReport.lng,
            ...(address ? { address } : {})
          },
          submittedAt: occurredAt
        };

        const eventEnvelope = {
          eventId,
          eventType: 'report.submitted',
          version: 1,
          occurredAt,
          correlationId: request.correlationId,
          payload
        };

        eventValidator.validateEvent('report.submitted', eventEnvelope);

        // 5. Insert outbox row
        await client.query(
          `INSERT INTO outbox_events (event_id, event_type, version, correlation_id, payload, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            eventId,
            'report.submitted',
            1,
            request.correlationId,
            JSON.stringify(payload),
            occurredAt
          ]
        );

        await client.query('COMMIT');

        return reply.status(201).send(createdReport);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
  );

  // GET /api/v1/reports/mine?status=
  app.get(
    '/mine',
    {
      schema: {
        querystring: listMineQuerySchema
      }
    },
    async (request, reply) => {
      const user = request.user!;
      const { page, pageSize, sort, status } = request.query;
      const offset = (page - 1) * pageSize;

      const [sortCol, sortDir] = sort.split(':');
      const orderSql = `${sortCol === 'updated_at' ? 'updated_at' : 'created_at'} ${sortDir.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'}`;

      let whereClause = 'WHERE reporter_id = $1';
      const params: unknown[] = [user.id];

      if (status) {
        params.push(status);
        whereClause += ` AND status = $${params.length}`;
      }

      const countRes = await pool.query(
        `SELECT count(*)::int as total FROM reports ${whereClause}`,
        params
      );
      const total = countRes.rows[0].total;

      const itemsRes = await pool.query(
        `SELECT id, reporter_id as "reporterId", title, description, category_slug as category,
                lat, lng, address, status, version, created_at as "createdAt", updated_at as "updatedAt"
         FROM reports
         ${whereClause}
         ORDER BY ${orderSql}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset]
      );

      return reply.send({
        items: itemsRes.rows,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize)
        }
      });
    }
  );

  // GET /api/v1/reports (officer, admin only)
  app.get(
    '',
    {
      schema: {
        querystring: listOfficerQuerySchema
      }
    },
    async (request, reply) => {
      const user = request.user!;
      if (user.role === 'citizen') {
        throw new AppError({
          statusCode: 403,
          code: 'forbidden',
          message: 'Only department officers and administrators can list all reports'
        });
      }

      const { page, pageSize, sort, status, category, from, to } = request.query;
      const offset = (page - 1) * pageSize;

      const [sortCol, sortDir] = sort.split(':');
      const orderSql = `${sortCol === 'updated_at' ? 'updated_at' : 'created_at'} ${sortDir.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'}`;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }
      if (category) {
        params.push(category);
        conditions.push(`category_slug = $${params.length}`);
      }
      if (from) {
        params.push(from);
        conditions.push(`created_at >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        conditions.push(`created_at <= $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countRes = await pool.query(
        `SELECT count(*)::int as total FROM reports ${whereClause}`,
        params
      );
      const total = countRes.rows[0].total;

      const itemsRes = await pool.query(
        `SELECT id, reporter_id as "reporterId", title, description, category_slug as category,
                lat, lng, address, status, version, created_at as "createdAt", updated_at as "updatedAt"
         FROM reports
         ${whereClause}
         ORDER BY ${orderSql}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset]
      );

      return reply.send({
        items: itemsRes.rows,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize)
        }
      });
    }
  );

  // GET /api/v1/reports/:id
  app.get(
    '/:id',
    {
      schema: {
        params: z.object({ id: z.string().uuid() })
      }
    },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params;

      const reportRes = await pool.query(
        `SELECT id, reporter_id as "reporterId", title, description, category_slug as category,
                lat, lng, address, status, version, created_at as "createdAt", updated_at as "updatedAt"
         FROM reports WHERE id = $1`,
        [id]
      );

      if (reportRes.rows.length === 0) {
        throw new AppError({
          statusCode: 404,
          code: 'report_not_found',
          message: 'Report not found'
        });
      }

      const report = reportRes.rows[0];

      // Non-owners return 404, not 403
      if (user.role === 'citizen' && report.reporterId !== user.id) {
        throw new AppError({
          statusCode: 404,
          code: 'report_not_found',
          message: 'Report not found'
        });
      }

      const historyRes = await pool.query(
        `SELECT id, from_status as "fromStatus", to_status as "toStatus",
                reason_code as "reasonCode", note, changed_by as "changedBy", changed_at as "changedAt"
         FROM status_history
         WHERE report_id = $1
         ORDER BY changed_at ASC, id ASC`,
        [id]
      );

      return reply.send({
        ...report,
        history: historyRes.rows
      });
    }
  );

  // POST /api/v1/reports/:id/status
  app.post(
    '/:id/status',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: updateStatusBodySchema
      }
    },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params;
      const { toStatus, reasonCode, note } = request.body;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Row lock report for concurrent status transition safety
        const reportRes = await client.query(
          `SELECT id, reporter_id, status, version, title, description, category_slug, lat, lng, address, created_at
           FROM reports WHERE id = $1 FOR UPDATE`,
          [id]
        );

        if (reportRes.rows.length === 0) {
          await client.query('ROLLBACK');
          throw new AppError({
            statusCode: 404,
            code: 'report_not_found',
            message: 'Report not found'
          });
        }

        const report = reportRes.rows[0];
        const currentStatus = report.status as ReportStatus;
        const isOwner = report.reporter_id === user.id;

        // Pure status transition validation
        const validation = validateStatusTransition({
          from: currentStatus,
          to: toStatus,
          role: user.role,
          isOwner,
          reasonCode
        });

        if (!validation.valid) {
          await client.query('ROLLBACK');
          if (validation.errorCode === 'missing_reason_code') {
            throw new AppError({
              statusCode: 400,
              code: 'validation_error',
              message: validation.message || 'Rejection requires a reason code'
            });
          }
          if (validation.errorCode === 'invalid_reason_code') {
            throw new AppError({
              statusCode: 400,
              code: 'validation_error',
              message: validation.message || 'Invalid rejection reason code'
            });
          }
          const statusCode = validation.errorCode === 'forbidden_role' ? 403 : 409;
          throw new AppError({
            statusCode,
            code: 'forbidden_transition',
            message: validation.message || 'Status transition forbidden'
          });
        }

        const now = new Date();
        const newVersion = report.version + 1;

        // 1. Update report
        const updateRes = await client.query(
          `UPDATE reports
           SET status = $1, version = $2, updated_at = $3
           WHERE id = $4
           RETURNING id, reporter_id as "reporterId", title, description, category_slug as category,
                     lat, lng, address, status, version, created_at as "createdAt", updated_at as "updatedAt"`,
          [toStatus, newVersion, now, id]
        );
        const updatedReport = updateRes.rows[0];

        // 2. Insert history row
        await client.query(
          `INSERT INTO status_history (report_id, from_status, to_status, reason_code, note, changed_by, changed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, currentStatus, toStatus, reasonCode || null, note || null, user.id, now]
        );

        // 3. Stage report.status-changed domain event
        const eventId = randomUUID();
        const occurredAt = now.toISOString();
        const payload = {
          reportId: id,
          fromStatus: currentStatus,
          toStatus,
          changedBy: user.id,
          changedAt: occurredAt,
          ...(note ? { note } : {})
        };

        const eventEnvelope = {
          eventId,
          eventType: 'report.status-changed',
          version: 1,
          occurredAt,
          correlationId: request.correlationId,
          payload
        };

        eventValidator.validateEvent('report.status-changed', eventEnvelope);

        // 4. Insert into outbox_events
        await client.query(
          `INSERT INTO outbox_events (event_id, event_type, version, correlation_id, payload, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            eventId,
            'report.status-changed',
            1,
            request.correlationId,
            JSON.stringify(payload),
            occurredAt
          ]
        );

        await client.query('COMMIT');

        return reply.status(200).send(updatedReport);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
  );
};
