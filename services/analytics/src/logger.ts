import pino, { Logger } from 'pino';

export interface LoggerOptions {
  serviceName: string;
  level: string;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    base: {
      service: options.serviceName
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'headers.authorization',
        'authorization',
        'DB_PASSWORD',
        'RABBITMQ_URL',
        'JWT_PUBLIC_KEY_B64'
      ],
      censor: '[REDACTED]'
    },
    formatters: {
      level(label) {
        return { level: label };
      }
    },
    timestamp: pino.stdTimeFunctions.isoTime
  });
}
