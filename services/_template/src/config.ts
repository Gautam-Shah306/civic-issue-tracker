import { z } from 'zod';

const configSchema = z.object({
  SERVICE_NAME: z.string().min(1).default('service-template'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env = process.env): Config {
  return configSchema.parse(env);
}
