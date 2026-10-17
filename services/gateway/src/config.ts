import { z } from 'zod';

const configSchema = z
  .object({
    SERVICE_NAME: z.string().min(1).default('gateway'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    AUTH_SERVICE_URL: z.string().default('http://auth:3000'),
    REPORT_SERVICE_URL: z.string().default('http://report:3000'),
    ANALYTICS_URL: z.string().default('http://analytics:3000'),
    ROUTING_URL: z.string().default('http://routing:8000'),
    IMAGE_URL: z.string().default('http://image:8000'),
    REDIS_URL: z.string().default('redis://127.0.0.1:6379/0'),
    UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    JWT_PUBLIC_KEY_B64: z.string().min(1, 'JWT_PUBLIC_KEY_B64 is required'),
    JWT_ISSUER: z.string().default('civic-auth'),
    JWT_AUDIENCE: z.string().default('civic-api'),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    TRUST_PROXY: z
      .union([z.boolean(), z.string(), z.number()])
      .default(false)
      .transform((val) => {
        if (typeof val === 'boolean') return val;
        if (typeof val === 'number') return val;
        if (val === 'true') return true;
        if (val === 'false') return false;
        const num = Number(val);
        if (!Number.isNaN(num)) return num;
        return val;
      })
  })
  .refine(
    (data) => {
      try {
        const pem = Buffer.from(data.JWT_PUBLIC_KEY_B64, 'base64').toString('utf8');
        return pem.includes('PUBLIC KEY');
      } catch {
        return false;
      }
    },
    {
      message: 'JWT_PUBLIC_KEY_B64 must be a valid base64-encoded PEM public key',
      path: ['JWT_PUBLIC_KEY_B64']
    }
  );

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return configSchema.parse(env);
}
