import { existsSync } from 'node:fs';
import { z } from 'zod';

function resolveDefaultContractsDir(): string {
  if (existsSync('/app/contracts')) {
    return '/app/contracts';
  }
  return '../../contracts';
}

const configSchema = z.object({
  SERVICE_NAME: z.string().min(1).default('report'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().default('civic_report'),
  DB_USER: z.string().default('civic_report'),
  DB_PASSWORD: z.string().default(''),
  RABBITMQ_URL: z.string().default('amqp://guest:guest@127.0.0.1:5672'),
  JWT_PUBLIC_KEY_B64: z.string().min(1),
  JWT_ISSUER: z.string().default('civic-auth'),
  JWT_AUDIENCE: z.string().default('civic-api'),
  OUTBOX_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  DELIVERY_LIMIT: z.coerce.number().int().positive().default(5),
  CONTRACTS_DIR: z.string().default(resolveDefaultContractsDir())
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return configSchema.parse(env);
}
