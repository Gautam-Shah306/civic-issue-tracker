import { existsSync } from 'node:fs';
import { z } from 'zod';

function resolveDefaultContractsDir(): string {
  if (existsSync('/app/contracts')) {
    return '/app/contracts';
  }
  return '../../contracts';
}

const configSchema = z.object({
  SERVICE_NAME: z.string().min(1).default('auth'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().default('civic_auth'),
  DB_USER: z.string().default('civic_auth'),
  DB_PASSWORD: z.string().default(''),
  RABBITMQ_URL: z.string().default('amqp://guest:guest@127.0.0.1:5672'),
  JWT_PRIVATE_KEY_B64: z.string().min(1),
  JWT_ISSUER: z.string().default('civic-auth'),
  JWT_AUDIENCE: z.string().default('civic-api'),
  ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  ARGON2_MEMORY_KIB: z.coerce.number().int().positive().default(19456),
  ARGON2_ITERATIONS: z.coerce.number().int().positive().default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),
  OUTBOX_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  CONTRACTS_DIR: z.string().default(resolveDefaultContractsDir())
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return configSchema.parse(env);
}
