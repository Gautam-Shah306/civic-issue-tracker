import { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import { formatProblemDetails } from '../errors.js';
import { Config } from '../config.js';

export interface RateLimiterOptions {
  config: Config;
  redis?: Redis;
}

export async function registerRateLimiter(
  app: FastifyInstance<any, any, any, any>,
  options: RateLimiterOptions
) {
  const { config, redis } = options;

  let redisClient = redis;
  if (!redisClient && config.REDIS_URL) {
    try {
      redisClient = new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        commandTimeout: 1000,
        connectTimeout: 1000,
        lazyConnect: true
      });
      redisClient.on('error', (err) => {
        app.log.warn({ err }, 'Redis connection error in rate-limiter, fail-open active');
      });
    } catch (err) {
      app.log.warn({ err }, 'Failed to initialize Redis client, fail-open active');
    }
  }

  await app.register(rateLimit, {
    redis: redisClient,
    skipOnError: true,
    hook: 'preHandler',
    timeWindow: 60 * 1000,
    allowList: (req) => {
      const path = req.url.split('?')[0];
      return path === '/healthz' || path === '/readyz';
    },
    max: (req) => {
      const path = req.url.split('?')[0];
      if (
        path === '/api/v1/auth/register' ||
        path === '/api/v1/auth/login' ||
        path === '/api/v1/auth/refresh'
      ) {
        return 10;
      }
      return 120;
    },
    keyGenerator: (req) => {
      const path = req.url.split('?')[0];
      if (
        path === '/api/v1/auth/register' ||
        path === '/api/v1/auth/login' ||
        path === '/api/v1/auth/refresh'
      ) {
        return `auth:${path}:${req.ip}`;
      }
      const userId = req.user?.id;
      return userId ? `user:${userId}` : `ip:${req.ip}`;
    },
    errorResponseBuilder: (req, context) => {
      const problem = formatProblemDetails({
        title: 'Too Many Requests',
        status: 429,
        detail: `Rate limit exceeded. Try again in ${context.after}`,
        instance: req.url,
        code: 'rate_limit_exceeded',
        correlationId: (req as { correlationId?: string }).correlationId || ''
      });
      return {
        ...problem,
        statusCode: 429
      };
    }
  });

  return redisClient;
}
