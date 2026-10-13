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
        'email',
        'recipientEmail',
        'recipient_email',
        'body',
        'req.body.body',
        'DB_PASSWORD',
        'SMTP_PASSWORD',
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
