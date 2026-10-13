import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildApp } from './app.js';

const config = loadConfig();
const logger = createLogger({
  serviceName: config.SERVICE_NAME,
  level: config.LOG_LEVEL
});

let redis: Redis | undefined;
if (config.REDIS_URL) {
  try {
    redis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 1000,
      connectTimeout: 1000,
      lazyConnect: true
    });
    redis.on('error', (err) => {
      logger.warn({ err }, 'Redis connection error, fail-open rate limiting active');
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to initialize Redis, fail-open rate limiting active');
  }
}

async function main() {
  const app = await buildApp(config, {
    redis
  });

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    logger.info(`Gateway service listening on 0.0.0.0:${config.PORT}`);
  } catch (err) {
    logger.fatal({ err }, 'Failed to start Gateway HTTP server');
    process.exit(1);
  }

  let isShuttingDown = false;
  async function gracefulShutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown initiated');

    const timer = setTimeout(() => {
      logger.error('Shutdown timed out, forcing exit');
      process.exit(1);
    }, 10000);

    try {
      await app.close();
      if (redis) {
        redis.disconnect();
      }
      clearTimeout(timer);
      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (err) {
      clearTimeout(timer);
      logger.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Unhandled startup error');
  process.exit(1);
});
