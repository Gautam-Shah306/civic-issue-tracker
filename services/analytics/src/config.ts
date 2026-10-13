import { z } from 'zod';

export const ConfigSchema = z.object({
  SERVICE_NAME: z.string().default('analytics'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default('info'),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string().default('civic_analytics'),
  DB_USER: z.string().default('civic_analytics_rw'),
  DB_PASSWORD: z.string(),
  RABBITMQ_URL: z.string().default('amqp://guest:guest@localhost:5672'),
  JWT_PUBLIC_KEY_B64: z.string(),
  DELIVERY_LIMIT: z.coerce.number().default(5),
  CONTRACTS_DIR: z.string().optional()
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(overrides: Partial<Record<string, unknown>> = {}): Config {
  const merged = { ...process.env, ...overrides };
  const parsed = ConfigSchema.safeParse(merged);

  if (!parsed.success) {
    const errorMessages = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join(', ');
    throw new Error(`Invalid configuration: ${errorMessages}`);
  }

  return parsed.data;
}
