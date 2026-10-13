import { loadConfig } from './config.js';
import { buildApp } from './app.js';

async function start() {
  const config = loadConfig();
  const app = buildApp(config);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Received shutdown signal, closing server gracefully...');
    const timeout = setTimeout(() => {
      app.log.error('Graceful shutdown timed out after 10s, forcing exit');
      process.exit(1);
    }, 10_000);
    timeout.unref();

    try {
      await app.close();
      app.log.info('Server closed cleanly');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    app.log.info(`Service listening on port ${config.PORT}`);
  } catch (err) {
    app.log.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }
}

void start();
