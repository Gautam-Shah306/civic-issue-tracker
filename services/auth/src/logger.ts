import pino from 'pino';

export interface LoggerOptions {
  serviceName: string;
  level: string;
}

export function createLogger(options: LoggerOptions) {
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
        'req.body.password',
        'body.password',
        'password',
        'req.body.refreshToken',
        'body.refreshToken',
        'refreshToken',
        'token',
        'tokenHash',
        'token_hash',
        'passwordHash',
        'password_hash',
        'JWT_PRIVATE_KEY_B64',
        'DB_PASSWORD',
        'RABBITMQ_URL'
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
