import { randomUUID } from 'node:crypto';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, isNull } from 'drizzle-orm';
import { Config } from '../config.js';
import { AppError } from '../errors.js';
import { TokenService } from '../auth/tokens.js';
import {
  hashPassword,
  verifyPassword,
  performDummyVerification,
  validatePasswordPolicy
} from '../auth/password.js';
import { EventValidator } from '../events/validator.js';
import { users, refreshTokens } from '../db/schema.js';

export interface AuthRouteOptions {
  config: Config;
  pool: pg.Pool;
  tokenService: TokenService;
  eventValidator: EventValidator;
}

const registerBodySchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(10).max(128),
    displayName: z
      .string()
      .min(1)
      .max(100)
      .transform((s) => s.trim())
  })
  .refine((data) => data.password.toLowerCase() !== data.email.toLowerCase(), {
    message: 'Password cannot be equal to your email address',
    path: ['password']
  });

const loginBodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128)
});

const refreshBodySchema = z.object({
  refreshToken: z.string().min(1)
});

const logoutBodySchema = z.object({
  refreshToken: z.string().min(1)
});

export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (
  fastify: FastifyInstance,
  opts: AuthRouteOptions
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { config, pool, tokenService, eventValidator } = opts;
  const db = drizzle(pool);

  // POST /register
  app.post(
    '/register',
    {
      schema: {
        body: registerBodySchema,
        response: {
          201: z.object({
            id: z.string().uuid(),
            email: z.string(),
            displayName: z.string(),
            role: z.string()
          })
        }
      }
    },
    async (request, reply) => {
      const { email, password, displayName } = request.body;
      const emailNormalized = email.trim().toLowerCase();

      // Enforce custom password policy rule
      const policyError = validatePasswordPolicy(password, email);
      if (policyError) {
        throw new AppError({
          statusCode: 400,
          code: 'validation_error',
          message: policyError,
          errors: [{ field: 'password', message: policyError }]
        });
      }

      // Hash password BEFORE acquiring client or opening transaction
      const passwordHash = await hashPassword(password, config);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Check for existing user with same normalized email
        const existingRes = await client.query(
          'SELECT id FROM users WHERE email_normalized = $1 FOR UPDATE',
          [emailNormalized]
        );

        if (existingRes.rows.length > 0) {
          await client.query('ROLLBACK');
          throw new AppError({
            statusCode: 409,
            code: 'email_taken',
            message: 'Email is already registered'
          });
        }

        const userId = randomUUID();
        const now = new Date();
        const role = 'citizen';

        // Insert new user
        const insertUserRes = await client.query(
          `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, true, $7, $7)
           RETURNING id, email, display_name, role, created_at`,
          [userId, email, emailNormalized, displayName, passwordHash, role, now]
        );

        const newUser = insertUserRes.rows[0];

        // Prepare and validate user.created domain event
        const eventId = randomUUID();
        const occurredAt = now.toISOString();
        const payload = {
          userId: newUser.id,
          email: newUser.email,
          displayName: newUser.display_name,
          role: newUser.role,
          createdAt: occurredAt
        };

        const eventEnvelope = {
          eventId,
          eventType: 'user.created',
          version: 1,
          occurredAt,
          correlationId: request.correlationId,
          payload
        };

        // Strict Ajv schema validation before inserting into outbox
        eventValidator.validateUserCreated(eventEnvelope);

        // Insert transactional outbox event
        await client.query(
          `INSERT INTO outbox_events (event_id, event_type, version, correlation_id, payload, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [eventId, 'user.created', 1, request.correlationId, JSON.stringify(payload), occurredAt]
        );

        await client.query('COMMIT');

        return reply.status(201).send({
          id: newUser.id,
          email: newUser.email,
          displayName: newUser.display_name,
          role: newUser.role
        });
      } catch (err: unknown) {
        await client.query('ROLLBACK').catch(() => {});
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code?: string }).code === '23505'
        ) {
          throw new AppError({
            statusCode: 409,
            code: 'email_taken',
            message: 'Email is already registered'
          });
        }
        throw err;
      } finally {
        client.release();
      }
    }
  );

  // POST /login
  app.post(
    '/login',
    {
      schema: {
        body: loginBodySchema
      }
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const emailNormalized = email.trim().toLowerCase();

      const existingUsers = await db
        .select()
        .from(users)
        .where(eq(users.emailNormalized, emailNormalized))
        .limit(1);

      if (existingUsers.length === 0) {
        // Unknown email: perform dummy hash verification to equalize timing
        await performDummyVerification(password);
        throw new AppError({
          statusCode: 401,
          code: 'invalid_credentials',
          message: 'Invalid email or password'
        });
      }

      const user = existingUsers[0];

      if (!user.isActive) {
        await performDummyVerification(password);
        throw new AppError({
          statusCode: 401,
          code: 'invalid_credentials',
          message: 'Invalid email or password'
        });
      }

      const validPassword = await verifyPassword(user.passwordHash, password);
      if (!validPassword) {
        throw new AppError({
          statusCode: 401,
          code: 'invalid_credentials',
          message: 'Invalid email or password'
        });
      }

      // Generate access token (EdDSA) and refresh token (family)
      const accessToken = await tokenService.issueAccessToken({
        id: user.id,
        role: user.role
      });

      const refresh = tokenService.generateRefreshToken();
      const familyId = randomUUID();
      const expiresAt = new Date(Date.now() + refresh.expiresInSeconds * 1000);

      await db.insert(refreshTokens).values({
        userId: user.id,
        familyId,
        tokenHash: refresh.tokenHash,
        expiresAt
      });

      return reply.status(200).send({
        accessToken: accessToken.token,
        tokenType: 'Bearer',
        expiresIn: accessToken.expiresIn,
        refreshToken: refresh.rawToken,
        refreshExpiresIn: refresh.expiresInSeconds,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role
        }
      });
    }
  );

  // POST /refresh
  app.post(
    '/refresh',
    {
      schema: {
        body: refreshBodySchema
      }
    },
    async (request, reply) => {
      const { refreshToken: rawToken } = request.body;
      const tokenHash = tokenService.hashRefreshToken(rawToken);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const tokenRes = await client.query(
          `SELECT id, user_id, family_id, token_hash, expires_at, revoked_at, replaced_by
           FROM refresh_tokens
           WHERE token_hash = $1
           FOR UPDATE`,
          [tokenHash]
        );

        if (tokenRes.rows.length === 0) {
          await client.query('ROLLBACK');
          throw new AppError({
            statusCode: 401,
            code: 'invalid_refresh_token',
            message: 'Invalid or expired refresh token'
          });
        }

        const tokenRow = tokenRes.rows[0];

        // REUSE DETECTION: If this token was already revoked, revoke the entire family!
        if (tokenRow.revoked_at !== null) {
          await client.query(
            `UPDATE refresh_tokens
             SET revoked_at = NOW()
             WHERE family_id = $1 AND revoked_at IS NULL`,
            [tokenRow.family_id]
          );
          await client.query('COMMIT');
          throw new AppError({
            statusCode: 401,
            code: 'invalid_refresh_token',
            message: 'Refresh token reuse detected; session revoked'
          });
        }

        // Check expiration
        if (new Date(tokenRow.expires_at) < new Date()) {
          await client.query('ROLLBACK');
          throw new AppError({
            statusCode: 401,
            code: 'invalid_refresh_token',
            message: 'Refresh token expired'
          });
        }

        // Fetch user
        const userRes = await client.query(
          `SELECT id, email, display_name, role, is_active FROM users WHERE id = $1`,
          [tokenRow.user_id]
        );

        if (userRes.rows.length === 0 || !userRes.rows[0].is_active) {
          await client.query('ROLLBACK');
          throw new AppError({
            statusCode: 401,
            code: 'invalid_credentials',
            message: 'User not found or inactive'
          });
        }

        const user = userRes.rows[0];

        // Rotate: issue new refresh token with same family_id
        const newRefresh = tokenService.generateRefreshToken();
        const newRefreshTokenId = randomUUID();
        const newExpiresAt = new Date(Date.now() + newRefresh.expiresInSeconds * 1000);

        // Mark old token revoked and replaced
        await client.query(
          `UPDATE refresh_tokens
           SET revoked_at = NOW(), replaced_by = $1
           WHERE id = $2`,
          [newRefreshTokenId, tokenRow.id]
        );

        // Insert new rotated token
        await client.query(
          `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [newRefreshTokenId, user.id, tokenRow.family_id, newRefresh.tokenHash, newExpiresAt]
        );

        await client.query('COMMIT');

        const newAccessToken = await tokenService.issueAccessToken({
          id: user.id,
          role: user.role
        });

        return reply.status(200).send({
          accessToken: newAccessToken.token,
          tokenType: 'Bearer',
          expiresIn: newAccessToken.expiresIn,
          refreshToken: newRefresh.rawToken,
          refreshExpiresIn: newRefresh.expiresInSeconds,
          user: {
            id: user.id,
            email: user.email,
            displayName: user.display_name,
            role: user.role
          }
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
  );

  // POST /logout
  app.post(
    '/logout',
    {
      schema: {
        body: logoutBodySchema
      }
    },
    async (request, reply) => {
      const { refreshToken: rawToken } = request.body;
      const tokenHash = tokenService.hashRefreshToken(rawToken);

      const tokenRows = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .limit(1);

      if (tokenRows.length > 0) {
        const familyId = tokenRows[0].familyId;
        // Revoke the whole token family
        await db
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
      }

      return reply.status(204).send();
    }
  );

  // GET /me
  app.get('/me', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError({
        statusCode: 401,
        code: 'unauthorized',
        message: 'Missing or malformed Authorization header'
      });
    }

    const token = authHeader.substring(7).trim();
    let tokenPayload: { userId: string; role: string };

    try {
      tokenPayload = await tokenService.verifyAccessToken(token);
    } catch {
      throw new AppError({
        statusCode: 401,
        code: 'unauthorized',
        message: 'Invalid or expired access token'
      });
    }

    const userRows = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        isActive: users.isActive
      })
      .from(users)
      .where(eq(users.id, tokenPayload.userId))
      .limit(1);

    if (userRows.length === 0 || !userRows[0].isActive) {
      throw new AppError({
        statusCode: 401,
        code: 'unauthorized',
        message: 'User account not found or deactivated'
      });
    }

    const user = userRows[0];
    return reply.status(200).send({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role
    });
  });

  // GET /.well-known/jwks.json (also mounted under prefix if desired, but root path is registered in app.ts)
  app.get('/jwks.json', async () => {
    return tokenService.getPublicJwks();
  });

  const userRoleEnum = z.enum(['citizen', 'officer', 'admin']);

  const adminCreateUserBodySchema = z
    .object({
      email: z.string().email().max(254),
      password: z.string().min(10).max(128),
      displayName: z
        .string()
        .min(1)
        .max(100)
        .transform((s) => s.trim()),
      role: userRoleEnum
    })
    .refine((data) => data.password.toLowerCase() !== data.email.toLowerCase(), {
      message: 'Password cannot be equal to your email address',
      path: ['password']
    });

  const listUsersQuerySchema = z.object({
    role: userRoleEnum.optional(),
    active: z
      .enum(['true', 'false'])
      .optional()
      .transform((val) => (val === undefined ? undefined : val === 'true')),
    q: z.string().max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20)
  });

  const updateUserParamsSchema = z.object({
    id: z.string().uuid()
  });

  const updateUserBodySchema = z
    .object({
      isActive: z.boolean().optional(),
      role: userRoleEnum.optional(),
      displayName: z
        .string()
        .min(1)
        .max(100)
        .transform((s) => s.trim())
        .optional()
    })
    .refine(
      (data) =>
        data.isActive !== undefined || data.role !== undefined || data.displayName !== undefined,
      {
        message: 'At least one field to update must be provided'
      }
    );

  async function requireAdmin(req: {
    headers: Record<string, string | string[] | undefined>;
  }): Promise<{ userId: string; role: string }> {
    const authHeader = req.headers.authorization;
    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      throw new AppError({
        statusCode: 401,
        code: 'unauthorized',
        message: 'Missing or malformed Authorization header'
      });
    }

    const token = authHeader.substring(7).trim();
    let tokenPayload: { userId: string; role: string };

    try {
      tokenPayload = await tokenService.verifyAccessToken(token);
    } catch {
      throw new AppError({
        statusCode: 401,
        code: 'unauthorized',
        message: 'Invalid or expired access token'
      });
    }

    if (tokenPayload.role !== 'admin') {
      throw new AppError({
        statusCode: 403,
        code: 'forbidden',
        message: 'Administrator role required'
      });
    }

    const res = await pool.query('SELECT id, is_active FROM users WHERE id = $1', [
      tokenPayload.userId
    ]);
    if (res.rows.length === 0 || !res.rows[0].is_active) {
      throw new AppError({
        statusCode: 401,
        code: 'unauthorized',
        message: 'User account not found or deactivated'
      });
    }

    return tokenPayload;
  }

  // POST /users (admin only)
  app.post(
    '/users',
    {
      preValidation: async (request) => {
        await requireAdmin(request);
      },
      schema: {
        body: adminCreateUserBodySchema,
        response: {
          201: z.object({
            id: z.string().uuid(),
            email: z.string(),
            displayName: z.string(),
            role: userRoleEnum,
            isActive: z.boolean()
          })
        }
      }
    },
    async (request, reply) => {
      await requireAdmin(request);

      const { email, password, displayName, role } = request.body;
      const emailNormalized = email.trim().toLowerCase();

      // Enforce custom password policy rule
      const policyError = validatePasswordPolicy(password, email);
      if (policyError) {
        throw new AppError({
          statusCode: 400,
          code: 'validation_error',
          message: policyError,
          errors: [{ field: 'password', message: policyError }]
        });
      }

      // Hash password BEFORE acquiring client or opening transaction
      const passwordHash = await hashPassword(password, config);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Check for existing user with same normalized email
        const existingRes = await client.query(
          'SELECT id FROM users WHERE email_normalized = $1 FOR UPDATE',
          [emailNormalized]
        );

        if (existingRes.rows.length > 0) {
          await client.query('ROLLBACK');
          throw new AppError({
            statusCode: 409,
            code: 'email_taken',
            message: 'Email is already registered'
          });
        }

        const userId = randomUUID();
        const now = new Date();

        const insertUserRes = await client.query(
          `INSERT INTO users (id, email, email_normalized, display_name, password_hash, role, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, true, $7, $7)
           RETURNING id, email, display_name, role, is_active`,
          [userId, email, emailNormalized, displayName, passwordHash, role, now]
        );

        const newUser = insertUserRes.rows[0];

        // Prepare and validate user.created domain event
        const eventId = randomUUID();
        const occurredAt = now.toISOString();
        const payload = {
          userId: newUser.id,
          email: newUser.email,
          displayName: newUser.display_name,
          role: newUser.role,
          createdAt: occurredAt
        };

        const eventEnvelope = {
          eventId,
          eventType: 'user.created',
          version: 1,
          occurredAt,
          correlationId: request.correlationId,
          payload
        };

        eventValidator.validateUserCreated(eventEnvelope);

        await client.query(
          `INSERT INTO outbox_events (event_id, event_type, version, correlation_id, payload, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [eventId, 'user.created', 1, request.correlationId, JSON.stringify(payload), occurredAt]
        );

        await client.query('COMMIT');

        return reply.status(201).send({
          id: newUser.id,
          email: newUser.email,
          displayName: newUser.display_name,
          role: newUser.role,
          isActive: newUser.is_active
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
  );

  // GET /users (admin only)
  app.get(
    '/users',
    {
      preValidation: async (request) => {
        await requireAdmin(request);
      },
      schema: {
        querystring: listUsersQuerySchema,
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                email: z.string(),
                displayName: z.string(),
                role: userRoleEnum,
                isActive: z.boolean(),
                createdAt: z.string()
              })
            ),
            pagination: z.object({
              page: z.number().int(),
              pageSize: z.number().int(),
              total: z.number().int(),
              totalPages: z.number().int()
            })
          })
        }
      }
    },
    async (request, reply) => {
      await requireAdmin(request);

      const { role, active, q, page, pageSize } = request.query;
      const offset = (page - 1) * pageSize;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (role) {
        params.push(role);
        conditions.push(`role = $${params.length}`);
      }

      if (active !== undefined) {
        params.push(active);
        conditions.push(`is_active = $${params.length}`);
      }

      if (q && q.trim().length > 0) {
        const escapedQ = q.trim().replace(/[%_\\]/g, '\\$&');
        params.push(`%${escapedQ}%`);
        conditions.push(`(email ILIKE $${params.length} OR display_name ILIKE $${params.length})`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countRes = await pool.query(
        `SELECT count(*)::int AS total FROM users ${whereClause}`,
        params
      );
      const total = countRes.rows[0]?.total ?? 0;

      const queryParams = [...params, pageSize, offset];
      const itemsRes = await pool.query(
        `SELECT id, email, display_name AS "displayName", role, is_active AS "isActive", created_at AS "createdAt"
         FROM users
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
        queryParams
      );

      const items = itemsRes.rows.map((row) => ({
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        role: row.role,
        isActive: row.isActive,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : new Date(row.createdAt).toISOString()
      }));

      return reply.status(200).send({
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

  // PATCH /users/:id (admin only)
  app.patch(
    '/users/:id',
    {
      preValidation: async (request) => {
        await requireAdmin(request);
      },
      schema: {
        params: updateUserParamsSchema,
        body: updateUserBodySchema,
        response: {
          200: z.object({
            id: z.string().uuid(),
            email: z.string(),
            displayName: z.string(),
            role: userRoleEnum,
            isActive: z.boolean()
          })
        }
      }
    },
    async (request, reply) => {
      const callingAdmin = await requireAdmin(request);
      const targetUserId = request.params.id;
      const { isActive, role, displayName } = request.body;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const targetRes = await client.query(
          'SELECT id, email, display_name, role, is_active FROM users WHERE id = $1 FOR UPDATE',
          [targetUserId]
        );

        if (targetRes.rows.length === 0) {
          await client.query('ROLLBACK');
          throw new AppError({
            statusCode: 404,
            code: 'not_found',
            message: 'User not found'
          });
        }

        const targetUser = targetRes.rows[0];

        // Guard 1: An admin cannot deactivate or demote THEMSELVES
        if (targetUser.id === callingAdmin.userId) {
          if (isActive === false || (role !== undefined && role !== 'admin')) {
            await client.query('ROLLBACK');
            throw new AppError({
              statusCode: 400,
              code: 'self_modification_forbidden',
              message: 'Administrators cannot deactivate or demote their own account'
            });
          }
        }

        // Guard 2: The last active admin cannot be deactivated or demoted (409 last_admin)
        const isDemotingOrDeactivatingAdmin =
          targetUser.role === 'admin' &&
          targetUser.is_active === true &&
          (isActive === false || (role !== undefined && role !== 'admin'));

        if (isDemotingOrDeactivatingAdmin) {
          const countAdminRes = await client.query(
            "SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND is_active = true"
          );
          const activeAdminCount = countAdminRes.rows[0]?.count ?? 0;
          if (activeAdminCount <= 1) {
            await client.query('ROLLBACK');
            throw new AppError({
              statusCode: 409,
              code: 'last_admin',
              message: 'Cannot deactivate or demote the last active administrator'
            });
          }
        }

        const newIsActive = isActive !== undefined ? isActive : targetUser.is_active;
        const newRole = role !== undefined ? role : targetUser.role;
        const newDisplayName = displayName !== undefined ? displayName : targetUser.display_name;
        const now = new Date();
        const occurredAt = now.toISOString();

        await client.query(
          `UPDATE users
           SET is_active = $1, role = $2, display_name = $3, updated_at = $4
           WHERE id = $5`,
          [newIsActive, newRole, newDisplayName, now, targetUser.id]
        );

        // Deactivation revokes all the user's refresh tokens in the same transaction
        if (isActive === false) {
          await client.query(
            'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
            [targetUser.id]
          );
        }

        // Writes a user.updated outbox event in the same transaction
        const eventId = randomUUID();
        const changes: {
          isActive?: boolean;
          role?: 'citizen' | 'officer' | 'admin';
          displayName?: string;
          updatedAt: string;
        } = {
          updatedAt: occurredAt
        };
        if (isActive !== undefined) changes.isActive = isActive;
        if (role !== undefined) changes.role = role;
        if (displayName !== undefined) changes.displayName = displayName;

        const payload = {
          userId: targetUser.id,
          changedBy: callingAdmin.userId,
          changes,
          updatedAt: occurredAt
        };

        const eventEnvelope = {
          eventId,
          eventType: 'user.updated',
          version: 1,
          occurredAt,
          correlationId: request.correlationId,
          payload
        };

        eventValidator.validateUserUpdated(eventEnvelope);

        await client.query(
          `INSERT INTO outbox_events (event_id, event_type, version, correlation_id, payload, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [eventId, 'user.updated', 1, request.correlationId, JSON.stringify(payload), occurredAt]
        );

        await client.query('COMMIT');

        return reply.status(200).send({
          id: targetUser.id,
          email: targetUser.email,
          displayName: newDisplayName,
          role: newRole,
          isActive: newIsActive
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
  );
};
