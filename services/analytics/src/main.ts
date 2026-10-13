import pg from 'pg';
import { Connection } from 'rabbitmq-client';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildApp } from './app.js';
import { createEventValidator } from './events/validator.js';
import { createAnalyticsConsumers } from './events/consumers.js';

const config = loadConfig();
const logger = createLogger({
  serviceName: config.SERVICE_NAME,
  level: config.LOG_LEVEL
});

const pool = new pg.Pool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  max: 20
});

const rabbit = new Connection(config.RABBITMQ_URL);

let isRabbitConnected = false;
let areConsumersStarted = false;

rabbit.on('connection', () => {
  isRabbitConnected = true;
  logger.info('RabbitMQ connection established');
});

rabbit.on('error', (err) => {
  isRabbitConnected = false;
  logger.error({ err }, 'RabbitMQ connection error');
});

const validator = createEventValidator(config);
const consumers = createAnalyticsConsumers({
  config,
  pool,
  rabbitClient: rabbit,
  validator,
  logger
});

async function main() {
  const app = await buildApp(config, {
    pool,
    isRabbitReady: () => isRabbitConnected,
    areConsumersReady: () => areConsumersStarted
  });

  // Start HTTP server first
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    logger.info(`Analytics service listening on 0.0.0.0:${config.PORT}`);
  } catch (err) {
    logger.fatal({ err }, 'Failed to start HTTP server');
    process.exit(1);
  }

  // Background initialization of messaging consumers
  async function initBackground() {
    let delay = 1000;
    while (!isRabbitConnected) {
      try {
        await rabbit.onConnect();
        break;
      } catch (err) {
        logger.warn({ err }, 'Waiting for RabbitMQ connection...');
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 10000);
      }
    }

    try {
      await consumers.start();
      areConsumersStarted = true;
      logger.info('Analytics consumers active');
    } catch (err) {
      logger.error({ err }, 'Failed to start background consumers');
    }
  }

  initBackground().catch((err) => {
    logger.error({ err }, 'Background initialization error');
  });

  // Graceful shutdown handling
  let isShuttingDown = false;
  async function gracefulShutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown initiated (10s timeout)');

    const timer = setTimeout(() => {
      logger.error('Shutdown timed out, forcing exit');
      process.exit(1);
    }, 10000);

    try {
      await consumers.stop();
      await app.close();
      await pool.end();
      await rabbit.close();
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
