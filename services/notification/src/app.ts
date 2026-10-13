import Fastify from 'fastify';
import pg from 'pg';
import { Config } from './config.js';
import { createLogger } from './logger.js';

export interface AppDependencies {
  pool: pg.Pool;
  isRabbitReady: () => boolean;
  areConsumersReady?: () => boolean;
}

export async function buildApp(config: Config, deps: AppDependencies) {
  const logger = createLogger({
    serviceName: config.SERVICE_NAME,
    level: config.LOG_LEVEL
  });

  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: config.LOG_LEVEL === 'silent'
  });

  // Liveness probe: returns 200 as long as process is running
  app.get('/healthz', async (_req, reply) => {
    return reply.status(200).send({
      status: 'ok',
      service: config.SERVICE_NAME
    });
  });

  // Readiness probe: verifies DB and RabbitMQ connectivity
  app.get('/readyz', async (_req, reply) => {
    const rabbitOk = deps.isRabbitReady();
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

  return app;
}
