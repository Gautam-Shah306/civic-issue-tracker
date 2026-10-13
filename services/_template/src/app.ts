import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Config } from './config.js';
import { createLogger } from './logger.js';
import { formatProblemDetails, AppError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildApp(config: Config) {
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
        title: config.SERVICE_NAME,
        version: '0.1.0'
      }
    }
  });

  // Serve openapi.json
  app.get('/api/v1/openapi.json', async () => {
    return app.swagger();
  });

  // Health and Readiness probes
  app.get('/healthz', async () => {
    return { status: 'ok' };
  });

  app.get('/readyz', async () => {
    return { status: 'ready', ready: true };
  });

  // Demo route (to be deleted in real services)
  app.get(
    '/api/v1/ping',
    {
      schema: {
        querystring: z.object({
          n: z.coerce.number().int().min(1).max(10)
        })
      }
    },
    async (request) => {
      const { n } = request.query;
      return { pong: true, n, correlationId: request.correlationId };
    }
  );

  // 404 Not Found Handler returning RFC 9457 problem details
  app.setNotFoundHandler(async (request, reply) => {
    const problem = formatProblemDetails({
      title: 'Not Found',
      status: 404,
      detail: `Route ${request.method} ${request.url} not found`,
      instance: request.url,
      code: 'NOT_FOUND',
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
      message?: string;
    };

    // Fastify / Zod validation error
    if (errObj && errObj.validation) {
      const validationErrors = errObj.validation.map((v) => ({
        field:
          (v.instancePath ? v.instancePath.replace(/^\//, '') : v.params?.missingProperty) ||
          'query',
        message: v.message || 'Validation error'
      }));

      const problem = formatProblemDetails({
        title: 'Validation Error',
        status: 400,
        detail: errObj.message || 'Validation error',
        instance: request.url,
        code: 'VALIDATION_ERROR',
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
      code: 'INTERNAL_ERROR',
      correlationId: request.correlationId
    });
    reply.status(500).type('application/problem+json').send(problem);
  });

  return app;
}
