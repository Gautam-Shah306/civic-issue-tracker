import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import pg from 'pg';
import { Config } from './config.js';
import { createLogger } from './logger.js';
import { formatProblemDetails, AppError } from './errors.js';
import { JwtVerifier, createJwtVerifier } from './auth/jwt.js';
import { analyticsRoutes } from './routes/analytics.js';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AppDependencies {
  pool: pg.Pool;
  jwtVerifier?: JwtVerifier;
  isRabbitReady?: () => boolean;
  areConsumersReady?: () => boolean;
}

export async function buildApp(config: Config, deps: AppDependencies) {
  const rootLogger = createLogger({
    serviceName: config.SERVICE_NAME,
    level: config.LOG_LEVEL
  });

  const app = Fastify({
    loggerInstance: rootLogger
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Correlation ID hook
  app.addHook('onRequest', async (request, reply) => {
    const incomingId = request.headers['x-correlation-id'];
    let correlationId: string;

    if (typeof incomingId === 'string' && UUID_REGEX.test(incomingId)) {
      correlationId = incomingId;
    } else {
      correlationId = randomUUID();
    }

    request.correlationId = correlationId;
    reply.header('x-correlation-id', correlationId);
  });

  // Swagger OpenAPI documentation
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Civic Issue Tracker - Analytics & Audit Service API',
        description: 'Read-model summary metrics and immutable audit log for Civic Issue Tracker',
        version: '1.0.0'
      },
      servers: [
        {
          url: 'http://localhost:8080',
          description: 'Local API Gateway'
        }
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT'
          }
        }
      },
      security: [{ bearerAuth: [] }]
    }
  });

  // Global Error Handler
  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.correlationId || randomUUID();

    if (error instanceof AppError) {
      const problem = formatProblemDetails({
        status: error.statusCode,
        code: error.code,
        title: error.message,
        detail: error.message,
        correlationId,
        type: error.type,
        errors: error.errors
      });
      return reply
        .status(error.statusCode)
        .header('content-type', 'application/problem+json')
        .send(problem);
    }

    // Validation error
    const errObj = error as Record<string, unknown>;
    if (errObj && 'validation' in errObj && Array.isArray(errObj.validation)) {
      const details = (errObj.validation as any[]).map((v: any) => ({
        field: v.instancePath || v.params?.missingProperty || 'unknown',
        message: v.message || 'Validation failed'
      }));

      const problem = formatProblemDetails({
        status: 400,
        code: 'validation_error',
        title: 'Request Validation Failed',
        detail: 'One or more request parameters failed validation',
        correlationId,
        errors: details
      });
      return reply.status(400).header('content-type', 'application/problem+json').send(problem);
    }

    request.log.error({ err: error, correlationId }, 'Unhandled server error');

    const problem = formatProblemDetails({
      status: 500,
      code: 'internal_server_error',
      title: 'Internal Server Error',
      detail: 'An unexpected internal error occurred',
      correlationId
    });
    return reply.status(500).header('content-type', 'application/problem+json').send(problem);
  });

  // Health probe
  app.get('/healthz', async (_req, reply) => {
    return reply.status(200).send({
      status: 'ok',
      service: config.SERVICE_NAME
    });
  });

  // Readiness probe
  app.get('/readyz', async (_req, reply) => {
    const rabbitOk = deps.isRabbitReady ? deps.isRabbitReady() : true;
    const consumersOk = deps.areConsumersReady ? deps.areConsumersReady() : true;
    let dbOk = false;

    try {
      await deps.pool.query('SELECT 1');
      dbOk = true;
    } catch {
      dbOk = false;
    }

    if (rabbitOk && dbOk && consumersOk) {
      return reply.status(200).send({
        status: 'ready',
        service: config.SERVICE_NAME,
        database: 'connected',
        rabbitmq: 'connected'
      });
    }

    return reply.status(503).send({
      type: 'https://api.civic.local/errors/service-unavailable',
      title: 'Service Unavailable',
      status: 503,
      detail: 'Dependencies not ready',
      database: dbOk ? 'connected' : 'unavailable',
      rabbitmq: rabbitOk ? 'connected' : 'unavailable'
    });
  });

  // Register Analytics routes
  const jwtVerifier = deps.jwtVerifier || (await createJwtVerifier(config));
  await app.register(analyticsRoutes, {
    pool: deps.pool,
    jwtVerifier
  });

  return app;
}
