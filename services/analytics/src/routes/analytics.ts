import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import pg from 'pg';
import { JwtVerifier } from '../auth/jwt.js';

export interface AnalyticsRouteOptions {
  pool: pg.Pool;
  jwtVerifier: JwtVerifier;
}

const SummaryResponseSchema = z.object({
  totalReports: z.number(),
  byStatus: z.record(z.string(), z.number()),
  byCategory: z.record(z.string(), z.number()),
  openReports: z.number(),
  averageResolutionHours: z.number()
});

const AuditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  eventType: z.string().optional(),
  subjectId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
});

const AuditItemSchema = z.object({
  id: z.string(),
  eventId: z.string().uuid(),
  eventType: z.string(),
  version: z.number(),
  correlationId: z.string().uuid(),
  occurredAt: z.string(),
  receivedAt: z.string(),
  actor: z.string().nullable(),
  subjectType: z.string().nullable(),
  subjectId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown())
});

const AuditResponseSchema = z.object({
  items: z.array(AuditItemSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  totalPages: z.number()
});

export async function analyticsRoutes(
  app: FastifyInstance,
  options: AnalyticsRouteOptions
): Promise<void> {
  const { pool, jwtVerifier } = options;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // 1. GET /api/v1/analytics/summary (officer, admin)
  typedApp.get(
    '/api/v1/analytics/summary',
    {
      preHandler: jwtVerifier.requireRole(['officer', 'admin']),
      schema: {
        summary: 'Get report summary metrics',
        description:
          'Returns aggregated report counts by status, category, open count, and average resolution time.',
        tags: ['Analytics'],
        response: {
          200: SummaryResponseSchema
        }
      }
    },
    async (_request, reply) => {
      const client = await pool.connect();
      try {
        // Total and open count
        const totalRes = await client.query<{
          total: string;
          open_count: string;
          avg_resolution: string | null;
        }>(
          `SELECT
             COUNT(*)::text AS total,
             COUNT(*) FILTER (WHERE current_status IN ('Submitted', 'Verified', 'Assigned', 'In Progress', 'Reopened'))::text AS open_count,
             AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600.0) FILTER (WHERE resolved_at IS NOT NULL)::text AS avg_resolution
           FROM report_index;`
        );

        // By status
        const statusRes = await client.query<{ current_status: string; count: string }>(
          `SELECT current_status, COUNT(*)::text AS count
           FROM report_index
           GROUP BY current_status;`
        );

        // By category
        const categoryRes = await client.query<{ category: string; count: string }>(
          `SELECT category, COUNT(*)::text AS count
           FROM report_index
           GROUP BY category;`
        );

        const byStatus: Record<string, number> = {};
        for (const row of statusRes.rows) {
          byStatus[row.current_status] = parseInt(row.count, 10);
        }

        const byCategory: Record<string, number> = {};
        for (const row of categoryRes.rows) {
          byCategory[row.category] = parseInt(row.count, 10);
        }

        const totalRow = totalRes.rows[0];
        const totalReports = parseInt(totalRow?.total || '0', 10);
        const openReports = parseInt(totalRow?.open_count || '0', 10);
        const avgHoursRaw = totalRow?.avg_resolution ? parseFloat(totalRow.avg_resolution) : 0;
        const averageResolutionHours = Math.round(avgHoursRaw * 100) / 100;

        return reply.status(200).send({
          totalReports,
          byStatus,
          byCategory,
          openReports,
          averageResolutionHours
        });
      } finally {
        client.release();
      }
    }
  );

  // 2. GET /api/v1/analytics/audit (admin only)
  typedApp.get(
    '/api/v1/analytics/audit',
    {
      preHandler: jwtVerifier.requireRole(['admin']),
      schema: {
        summary: 'Query audit log',
        description: 'Returns paginated and filtered immutable audit log records.',
        tags: ['Audit'],
        querystring: AuditQuerySchema,
        response: {
          200: AuditResponseSchema
        }
      }
    },
    async (request, reply) => {
      const { page, pageSize, eventType, subjectId, from, to } = request.query;

      const client = await pool.connect();
      try {
        const whereClauses: string[] = [];
        const params: unknown[] = [];

        if (eventType) {
          params.push(eventType);
          whereClauses.push(`event_type = $${params.length}`);
        }

        if (subjectId) {
          params.push(subjectId);
          whereClauses.push(`subject_id = $${params.length}`);
        }

        if (from) {
          params.push(from);
          whereClauses.push(`occurred_at >= $${params.length}`);
        }

        if (to) {
          params.push(to);
          whereClauses.push(`occurred_at <= $${params.length}`);
        }

        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        // Count total
        const countRes = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM audit_log ${whereSql}`,
          params
        );
        const total = parseInt(countRes.rows[0]?.count || '0', 10);
        const totalPages = Math.ceil(total / pageSize);

        // Fetch paginated rows
        const offset = (page - 1) * pageSize;
        const pageParams = [...params, pageSize, offset];
        const dataRes = await client.query<{
          id: string;
          event_id: string;
          event_type: string;
          version: number;
          correlation_id: string;
          occurred_at: Date;
          received_at: Date;
          actor: string | null;
          subject_type: string | null;
          subject_id: string | null;
          payload: unknown;
        }>(
          `SELECT id::text, event_id, event_type, version, correlation_id,
                  occurred_at, received_at, actor, subject_type, subject_id, payload
           FROM audit_log
           ${whereSql}
           ORDER BY occurred_at DESC, id DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          pageParams
        );

        const items = dataRes.rows.map((row) => ({
          id: row.id,
          eventId: row.event_id,
          eventType: row.event_type,
          version: row.version,
          correlationId: row.correlation_id,
          occurredAt: row.occurred_at.toISOString(),
          receivedAt: row.received_at.toISOString(),
          actor: row.actor,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          payload:
            typeof row.payload === 'string'
              ? JSON.parse(row.payload)
              : (row.payload as Record<string, unknown>)
        }));

        return reply.status(200).send({
          items,
          total,
          page,
          pageSize,
          totalPages
        });
      } finally {
        client.release();
      }
    }
  );
}
