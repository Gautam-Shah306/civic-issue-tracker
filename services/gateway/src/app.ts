import { randomUUID } from 'node:crypto';
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import replyFrom from '@fastify/reply-from';
import { Redis } from 'ioredis';
import { Config } from './config.js';
import { createLogger } from './logger.js';
import { AppError, formatProblemDetails } from './errors.js';
import { createJwtVerifier, JwtVerifier } from './auth/jwt.js';
import { registerRateLimiter } from './plugins/ratelimit.js';

export interface AppDependencies {
  redis?: Redis;
  jwtVerifier?: JwtVerifier;
}

export async function buildApp(config: Config, deps: AppDependencies = {}) {
  const logger = createLogger({ serviceName: config.SERVICE_NAME, level: config.LOG_LEVEL });

  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 1048576 // 1 MiB limit
  });

  // 1. Security headers (Helmet)
  await app.register(helmet, {
    contentSecurityPolicy: false // API gateway
  });

  // 2. CORS configuration
  await app.register(cors, {
    origin:
      config.CORS_ORIGINS === '*' ? true : config.CORS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: true
  });

  // 3. Upstream Reverse Proxy (reply-from)
  await app.register(replyFrom);

  // 4. Inbound Header Hygiene & Correlation ID
  app.addHook('onRequest', async (request, reply) => {
    // Strip client-supplied user headers to prevent identity spoofing
    delete request.headers['x-user-id'];
    delete request.headers['x-user-role'];
    delete request.headers['x-user-email'];

    const correlationId = (request.headers['x-correlation-id'] as string) || randomUUID();
    request.headers['x-correlation-id'] = correlationId;
    request.correlationId = correlationId;
    reply.header('x-correlation-id', correlationId);
  });

  // Ensure application/problem+json content-type on error status codes
  app.addHook('onSend', async (_request, reply, payload) => {
    if (
      reply.statusCode >= 400 &&
      !reply.getHeader('content-type')?.toString().includes('problem+json')
    ) {
      reply.type('application/problem+json');
    }
    return payload;
  });

  // 5. Rate Limiting backed by Redis (fail-open)
  const redisClient = await registerRateLimiter(app, { config, redis: deps.redis });

  // 6. JWT Verifier
  const jwtVerifier = deps.jwtVerifier || (await createJwtVerifier(config));

  // 7. Health & Readiness probes
  app.get('/healthz', async () => {
    return { status: 'ok' };
  });

  app.get('/readyz', async (_request, reply) => {
    if (redisClient) {
      try {
        await redisClient.ping();
      } catch (err) {
        requestLogRedisError(err);
      }
    }
    return reply.status(200).send({ status: 'ready', ready: true });
  });

  function requestLogRedisError(err: unknown) {
    app.log.warn({ err }, 'Redis ping failed during readiness probe');
  }

  // 8. Error handling
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      const problem = formatProblemDetails({
        title: error.message,
        status: error.statusCode,
        instance: request.url,
        code: error.code,
        correlationId: request.correlationId || '',
        errors: error.errors
      });
      reply.status(error.statusCode).type('application/problem+json').send(problem);
      return;
    }

    const errObj = error as {
      message?: string;
      statusCode?: number;
      status?: number;
      code?: string;
    };
    const statusCode = errObj.statusCode || errObj.status || 500;
    if (statusCode === 429) {
      const problem = formatProblemDetails({
        title: 'Too Many Requests',
        status: 429,
        detail: errObj.message || 'Rate limit exceeded',
        instance: request.url,
        code: 'rate_limit_exceeded',
        correlationId: request.correlationId || ''
      });
      reply.status(429).type('application/problem+json').send(problem);
      return;
    }

    if (statusCode === 413) {
      const problem = formatProblemDetails({
        title: 'Payload Too Large',
        status: 413,
        detail: 'Request body exceeds 1 MiB limit',
        instance: request.url,
        code: 'payload_too_large',
        correlationId: request.correlationId || ''
      });
      reply.status(413).type('application/problem+json').send(problem);
      return;
    }

    if (statusCode >= 400 && statusCode < 500) {
      const errCode = errObj.code || 'client_error';
      const problem = formatProblemDetails({
        title: errObj.message || 'Client Error',
        status: statusCode,
        detail: errObj.message,
        instance: request.url,
        code: errCode.toLowerCase(),
        correlationId: request.correlationId || ''
      });
      reply.status(statusCode).type('application/problem+json').send(problem);
      return;
    }

    request.log.error({ err: error }, 'Unhandled gateway error');
    const problem = formatProblemDetails({
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected internal error occurred',
      instance: request.url,
      code: 'internal_error',
      correlationId: request.correlationId || ''
    });
    reply.status(500).type('application/problem+json').send(problem);
  });

  // 404 Not Found Handler
  app.setNotFoundHandler((request, reply) => {
    const problem = formatProblemDetails({
      title: 'Not Found',
      status: 404,
      detail: `Route ${request.method} ${request.url} not found`,
      instance: request.url,
      code: 'not_found',
      correlationId: request.correlationId || ''
    });
    reply.status(404).type('application/problem+json').send(problem);
  });

  // Helper for proxying to upstream service
  function proxyTo(targetBaseUrl: string) {
    return (request: FastifyRequest, reply: FastifyReply) => {
      const upstreamUrl = `${targetBaseUrl}${request.raw.url}`;
      return reply.from(upstreamUrl, {
        timeout: 10000,
        onError(errReply, { error }) {
          const errMsg = error.message.toLowerCase();
          const errCode = (error as { code?: string }).code;
          const isTimeout =
            errMsg.includes('timeout') ||
            errMsg.includes('aborted') ||
            errCode === 'ETIMEDOUT' ||
            errCode === 'ESOCKETTIMEDOUT' ||
            errCode === 'UND_ERR_SOCKET';

          if (isTimeout) {
            const problem = formatProblemDetails({
              title: 'Gateway Timeout',
              status: 504,
              detail: 'Upstream service timed out',
              instance: request.url,
              code: 'gateway_timeout',
              correlationId: request.correlationId || ''
            });
            errReply.status(504).type('application/problem+json').send(problem);
          } else {
            const problem = formatProblemDetails({
              title: 'Bad Gateway',
              status: 502,
              detail: 'Upstream service unavailable or returned an error',
              instance: request.url,
              code: 'bad_gateway',
              correlationId: request.correlationId || ''
            });
            errReply.status(502).type('application/problem+json').send(problem);
          }
        }
      });
    };
  }

  // 9. Route Table
  // Auth Service - Public
  app.post('/api/v1/auth/register', proxyTo(config.AUTH_SERVICE_URL));
  app.post('/api/v1/auth/login', proxyTo(config.AUTH_SERVICE_URL));
  app.post('/api/v1/auth/refresh', proxyTo(config.AUTH_SERVICE_URL));
  app.get('/.well-known/jwks.json', proxyTo(config.AUTH_SERVICE_URL));

  // Auth Service - Authenticated
  app.post(
    '/api/v1/auth/logout',
    { preHandler: [jwtVerifier.requireAuth] },
    proxyTo(config.AUTH_SERVICE_URL)
  );
  app.get(
    '/api/v1/auth/me',
    { preHandler: [jwtVerifier.requireAuth] },
    proxyTo(config.AUTH_SERVICE_URL)
  );

  // Report Service - Public
  app.get('/api/v1/public/*', proxyTo(config.REPORT_SERVICE_URL));

  // Report Service - Authenticated
  app.post(
    '/api/v1/reports',
    { preHandler: [jwtVerifier.requireRole(['citizen'])] },
    proxyTo(config.REPORT_SERVICE_URL)
  );
  app.get(
    '/api/v1/reports/mine',
    { preHandler: [jwtVerifier.requireRole(['citizen'])] },
    proxyTo(config.REPORT_SERVICE_URL)
  );
  app.get(
    '/api/v1/reports',
    { preHandler: [jwtVerifier.requireRole(['officer', 'admin'])] },
    proxyTo(config.REPORT_SERVICE_URL)
  );
  app.get(
    '/api/v1/reports/:id',
    { preHandler: [jwtVerifier.requireAuth] },
    proxyTo(config.REPORT_SERVICE_URL)
  );
  app.post(
    '/api/v1/reports/:id/status',
    { preHandler: [jwtVerifier.requireAuth] },
    proxyTo(config.REPORT_SERVICE_URL)
  );

  return app;
}
