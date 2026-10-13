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
        'token',
        'JWT_PUBLIC_KEY_B64',
        'DB_PASSWORD',
        'RABBITMQ_URL'
      ],
      censor: '[REDACTED]'
    },
    timestamp: pino.stdTimeFunctions.isoTime
  });
}
