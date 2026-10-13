import { z } from 'zod';

const configSchema = z.object({
  SERVICE_NAME: z.string().min(1).default('gateway'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  AUTH_SERVICE_URL: z.string().default('http://auth:3000'),
  REPORT_SERVICE_URL: z.string().default('http://report:3000'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379/0'),
  JWT_PUBLIC_KEY_B64: z.string().default(''),
  JWT_ISSUER: z.string().default('civic-auth'),
  JWT_AUDIENCE: z.string().default('civic-api'),
  CORS_ORIGINS: z.string().default('*')
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return configSchema.parse(env);
}
