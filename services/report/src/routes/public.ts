import { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import pg from 'pg';
import { AppError } from '../errors.js';

export interface PublicRouteOptions {
  pool: pg.Pool;
}

const OPEN_STATUSES = ['Submitted', 'Verified', 'Assigned', 'In Progress', 'Reopened'];

const listPublicReportsQuerySchema = z.object({
  status: z.enum(['open', 'all']).default('open'),
  category: z.string().optional(),
  bbox: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20)
});

export const publicRoutes: FastifyPluginAsync<PublicRouteOptions> = async (fastify, options) => {
  const { pool } = options;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/public/categories
  app.get('/categories', async (_request, reply) => {
    const res = await pool.query(
      'SELECT slug, name FROM categories WHERE active = true ORDER BY name ASC'
    );
    return reply.send(res.rows);
  });

  // GET /api/v1/public/reports
  app.get(
    '/reports',
    {
      schema: {
        querystring: listPublicReportsQuerySchema
      }
    },
    async (request, reply) => {
      const { status, category, bbox, page, pageSize } = request.query;
      const offset = (page - 1) * pageSize;

      const conditions: string[] = [];
      const params: unknown[] = [];

      // 1. Status filter: 'open' vs 'all'
      if (status === 'open') {
        params.push(OPEN_STATUSES);
        conditions.push(`status = ANY($${params.length})`);
      }

      // 2. Category filter
      if (category) {
        params.push(category);
        conditions.push(`category_slug = $${params.length}`);
      }

      // 3. PostGIS Bounding-box filter
      if (bbox) {
        const parts = bbox.split(',').map((s) => Number(s.trim()));
        if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
          throw new AppError({
            statusCode: 400,
            code: 'validation_error',
            message: 'Invalid bbox query parameter. Expected minLng,minLat,maxLng,maxLat'
          });
        }
        const [minLng, minLat, maxLng, maxLat] = parts;
        if (
          minLng > maxLng ||
          minLat > maxLat ||
          minLng < -180 ||
          maxLng > 180 ||
          minLat < -90 ||
          maxLat > 90
        ) {
          throw new AppError({
            statusCode: 400,
            code: 'validation_error',
            message: 'Invalid bbox bounding coordinates'
          });
        }

        params.push(minLng, minLat, maxLng, maxLat);
        const idx = params.length - 3;
        conditions.push(
          `ST_Intersects(geom, ST_MakeEnvelope($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, 4326)::geography)`
        );
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Count total matching
      const countRes = await pool.query(
        `SELECT count(*)::int as total FROM reports ${whereClause}`,
        params
      );
      const total = countRes.rows[0].total;

      // Select matching items (NEVER expose reporter data, round lat/lng to 4 decimals)
      const selectQuery = `
        SELECT id, title, category_slug as category, status, lat, lng, created_at as "createdAt"
        FROM reports
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;

      const itemsRes = await pool.query(selectQuery, [...params, pageSize, offset]);

      const items = itemsRes.rows.map((row) => ({
        id: row.id,
        title: row.title,
        category: row.category,
        status: row.status,
        lat: Number(Number(row.lat).toFixed(4)),
        lng: Number(Number(row.lng).toFixed(4)),
        createdAt: row.createdAt
      }));

      return reply.send({
        items,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize)
        }
      });
    }
  );

  // GET /api/v1/public/reports/:id
  app.get(
    '/reports/:id',
    {
      schema: {
        params: z.object({ id: z.string().uuid() })
      }
    },
    async (request, reply) => {
      const { id } = request.params;

      const reportRes = await pool.query(
        `SELECT id, title, description, category_slug as category, status, lat, lng, created_at as "createdAt"
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

      // Timeline without actor ids
      const timelineRes = await pool.query(
        `SELECT from_status as "fromStatus", to_status as "toStatus",
                reason_code as "reasonCode", note, changed_at as "changedAt"
         FROM status_history
         WHERE report_id = $1
         ORDER BY changed_at ASC, id ASC`,
        [id]
      );

      return reply.send({
        id: report.id,
        title: report.title,
        description: report.description,
        category: report.category,
        status: report.status,
        lat: Number(Number(report.lat).toFixed(4)),
        lng: Number(Number(report.lng).toFixed(4)),
        createdAt: report.createdAt,
        timeline: timelineRes.rows
      });
    }
  );
};
