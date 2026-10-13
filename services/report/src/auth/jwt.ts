import { importSPKI, jwtVerify } from 'jose';
import { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../errors.js';
import { Config } from '../config.js';

export interface JwtUser {
  id: string;
  role: 'citizen' | 'officer' | 'admin';
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtUser;
  }
}

export interface JwtVerifier {
  verifyToken(authHeader?: string): Promise<JwtUser>;
  preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}

export async function createJwtVerifier(config: Config): Promise<JwtVerifier> {
  let publicKey: Awaited<ReturnType<typeof importSPKI>>;
  try {
    const pem = Buffer.from(config.JWT_PUBLIC_KEY_B64, 'base64').toString('utf8');
    publicKey = await importSPKI(pem, 'EdDSA');
  } catch (err) {
    throw new Error(
      `Failed to parse JWT_PUBLIC_KEY_B64 SPKI PEM: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  async function verifyToken(authHeader?: string): Promise<JwtUser> {
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
        role: role as 'citizen' | 'officer' | 'admin'
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError({
        statusCode: 401,
        code: 'unauthorized',
        message: 'Invalid or expired token'
      });
    }
  }

  async function preHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const authHeader = request.headers.authorization;
    request.user = await verifyToken(authHeader);
  }

  return {
    verifyToken,
    preHandler
  };
}
