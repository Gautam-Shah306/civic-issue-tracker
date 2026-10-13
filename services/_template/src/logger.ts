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
      paths: ['req.headers.authorization', 'headers.authorization', 'authorization'],
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
