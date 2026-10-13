import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import pg from 'pg';
import { Config } from './config.js';
import { createLogger } from './logger.js';
import { formatProblemDetails, AppError } from './errors.js';
import { JwtVerifier, createJwtVerifier } from './auth/jwt.js';
import { EventValidator, createEventValidator } from './events/validator.js';
import { reportsRoutes } from './routes/reports.js';
import { publicRoutes } from './routes/public.js';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AppDependencies {
  pool?: pg.Pool;
  jwtVerifier?: JwtVerifier;
  eventValidator?: EventValidator;
  isRabbitReady?: () => boolean;
}

export async function buildApp(config: Config, deps: AppDependencies = {}) {
  const rootLogger = createLogger({
    serviceName: config.SERVICE_NAME,
    level: config.LOG_LEVEL
  });

  const app = Fastify({
    loggerInstance: rootLogger
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Correlation ID hook: validate incoming x-correlation-id or generate new UUID, echo in response
  app.addHook('onRequest', async (request, reply) => {
    const headerVal = request.headers['x-correlation-id'];
    let correlationId: string;
    if (typeof headerVal === 'string' && UUID_REGEX.test(headerVal)) {
      correlationId = headerVal;
    } else {
      correlationId = randomUUID();
    }
    request.correlationId = correlationId;
    reply.header('x-correlation-id', correlationId);

    // Bind correlation_id to request child logger
    request.log = rootLogger.child({
      correlation_id: correlationId
    });
  });

  // Register OpenAPI documentation generator
  app.register(swagger, {
    openapi: {
      info: {
        title: 'Report Service',
        version: '0.1.0',
        description: 'Report intake, status state machine, and public spatial queries'
      }
    }
  });

  // Serve openapi.json
  app.get('/api/v1/openapi.json', async () => {
    return app.swagger();
  });

  // Resolve dependencies
  const jwtVerifier = deps.jwtVerifier || (await createJwtVerifier(config));
  const eventValidator = deps.eventValidator || createEventValidator(config);
  const pool =
    deps.pool ||
    new pg.Pool({
      host: config.DB_HOST,
      port: config.DB_PORT,
      database: config.DB_NAME,
      user: config.DB_USER,
      password: config.DB_PASSWORD
    });

  // Health probe: liveness is always 200 once HTTP server starts
  app.get('/healthz', async () => {
    return { status: 'ok' };
  });

  // Readiness probe: checks Postgres and RabbitMQ
  app.get('/readyz', async (request, reply) => {
    let dbOk = false;
    try {
      await pool.query('SELECT 1');
      dbOk = true;
    } catch {
      dbOk = false;
    }

    const rabbitOk = deps.isRabbitReady ? deps.isRabbitReady() : true;

    if (dbOk && rabbitOk) {
      return { status: 'ready', ready: true };
    }

    const problem = formatProblemDetails({
      title: 'Service Unavailable',
      status: 503,
      detail: `Dependencies not ready (db: ${dbOk ? 'ok' : 'down'}, rabbitmq: ${rabbitOk ? 'ok' : 'down'})`,
      instance: request.url,
      code: 'service_unavailable',
      correlationId: request.correlationId
    });

    return reply.status(503).type('application/problem+json').send(problem);
  });

  // 404 Not Found Handler returning RFC 9457 problem details
  app.setNotFoundHandler(async (request, reply) => {
    const problem = formatProblemDetails({
      title: 'Not Found',
      status: 404,
      detail: `Route ${request.method} ${request.url} not found`,
      instance: request.url,
      code: 'not_found',
      correlationId: request.correlationId
    });
    reply.status(404).type('application/problem+json').send(problem);
  });

  // Central Error Handler returning RFC 9457 problem details
  app.setErrorHandler(async (error: unknown, request, reply) => {
    if (error instanceof AppError) {
      const problem = formatProblemDetails({
        type: error.type,
        title: error.message,
        status: error.statusCode,
        instance: request.url,
        code: error.code,
        correlationId: request.correlationId,
        errors: error.errors
      });
      reply.status(error.statusCode).type('application/problem+json').send(problem);
      return;
    }

    const errObj = error as {
      validation?: Array<{
        instancePath?: string;
        params?: { missingProperty?: string };
        message?: string;
      }>;
      code?: string;
      message?: string;
    };

    // Fastify / Zod schema validation error
    if (errObj && (errObj.validation || errObj.code === 'FST_ERR_VALIDATION')) {
      const validationErrors = (errObj.validation || []).map((v) => ({
        field:
          (v.instancePath ? v.instancePath.replace(/^\//, '') : v.params?.missingProperty) ||
          'body',
        message: v.message || 'Validation error'
      }));

      const problem = formatProblemDetails({
        title: 'Validation Error',
        status: 400,
        detail: errObj.message || 'Validation error',
        instance: request.url,
        code: 'validation_error',
        correlationId: request.correlationId,
        errors: validationErrors
      });
      reply.status(400).type('application/problem+json').send(problem);
      return;
    }

    request.log.error({ err: error }, 'Unhandled server error');

    const problem = formatProblemDetails({
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected internal error occurred',
      instance: request.url,
      code: 'internal_error',
      correlationId: request.correlationId
    });
    reply.status(500).type('application/problem+json').send(problem);
  });

  // Register routes
  await app.register(reportsRoutes, {
    prefix: '/api/v1/reports',
    config,
    pool,
    eventValidator,
    jwtVerifier
  });

  await app.register(publicRoutes, {
    prefix: '/api/v1/public',
    pool
  });

  return app;
}
