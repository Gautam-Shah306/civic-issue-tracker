import { importSPKI, jwtVerify, errors as joseErrors } from 'jose';
import { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../errors.js';
import { Config } from '../config.js';

export interface JwtUser {
  id: string;
  role: 'citizen' | 'officer' | 'admin';
  email?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtUser;
    correlationId?: string;
  }
}

export interface JwtVerifier {
  verifyToken(authHeader?: string): Promise<JwtUser>;
  requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  requireRole(
    allowedRoles: Array<'citizen' | 'officer' | 'admin'>
  ): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export async function createJwtVerifier(config: Config): Promise<JwtVerifier> {
  let publicKey: Awaited<ReturnType<typeof importSPKI>> | null = null;

  if (config.JWT_PUBLIC_KEY_B64) {
    try {
      const pem = Buffer.from(config.JWT_PUBLIC_KEY_B64, 'base64').toString('utf8');
      publicKey = await importSPKI(pem, 'EdDSA');
    } catch (err) {
      throw new Error(
        `Failed to parse JWT_PUBLIC_KEY_B64 SPKI PEM: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function verifyToken(authHeader?: string): Promise<JwtUser> {
    if (!publicKey) {
      throw new AppError({
        statusCode: 500,
        code: 'jwt_misconfigured',
        message: 'JWT public key is not configured'
      });
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError({
        statusCode: 401,
        code: 'unauthorized',
        message: 'Missing or malformed Authorization header'
      });
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw new AppError({
        statusCode: 401,
        code: 'unauthorized',
        message: 'Missing access token'
      });
    }

    try {
      const { payload } = await jwtVerify(token, publicKey, {
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        algorithms: ['EdDSA']
      });

      if (!payload.sub || typeof payload.sub !== 'string') {
        throw new AppError({
          statusCode: 401,
          code: 'unauthorized',
          message: 'Token subject (sub) claim is missing or invalid'
        });
      }

      const role = payload.role as string;
      if (!role || !['citizen', 'officer', 'admin'].includes(role)) {
        throw new AppError({
          statusCode: 401,
          code: 'unauthorized',
          message: 'Token role claim is missing or invalid'
        });
      }

      return {
        id: payload.sub,
        role: role as 'citizen' | 'officer' | 'admin',
        email: typeof payload.email === 'string' ? payload.email : undefined
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof joseErrors.JWTExpired) {
        throw new AppError({
          statusCode: 401,
          code: 'unauthorized',
          message: 'Token has expired'
        });
      }
      throw new AppError({
        statusCode: 401,
        code: 'unauthorized',
        message: 'Invalid token'
      });
    }
  }

  async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const authHeader = request.headers.authorization;
    const user = await verifyToken(authHeader);
    request.user = user;
    request.headers['x-user-id'] = user.id;
    request.headers['x-user-role'] = user.role;
    if (user.email) {
      request.headers['x-user-email'] = user.email;
    }
  }

  function requireRole(allowedRoles: Array<'citizen' | 'officer' | 'admin'>) {
    return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      if (!request.user) {
        await requireAuth(request, _reply);
      }
      if (!request.user || !allowedRoles.includes(request.user.role)) {
        throw new AppError({
          statusCode: 403,
          code: 'forbidden',
          message: 'Forbidden: insufficient role privileges'
        });
      }
    };
  }

  return {
    verifyToken,
    requireAuth,
    requireRole
  };
}
