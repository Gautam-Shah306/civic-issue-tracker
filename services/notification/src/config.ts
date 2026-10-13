import { z } from 'zod';

export const ConfigSchema = z.object({
  SERVICE_NAME: z.string().default('notification'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default('info'),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string().default('civic_notification'),
  DB_USER: z.string().default('civic_notification'),
  DB_PASSWORD: z.string(),
  RABBITMQ_URL: z.string().default('amqp://guest:guest@localhost:5672'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_FROM: z.string().default('notifications@civic.local'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  DELIVERY_LIMIT: z.coerce.number().default(5),
  CONTRACTS_DIR: z.string().optional(),
  SENDER_INTERVAL_MS: z.coerce.number().default(1000)
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
