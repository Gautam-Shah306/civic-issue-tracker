import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import Fastify, { FastifyInstance } from 'fastify';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { SignJWT, importPKCS8 } from 'jose';
import { PINNED_IMAGES } from '../support/images.js';
import { loadConfig } from '../../src/config.js';
import { buildApp } from '../../src/app.js';

describe('Gateway Service Integration Tests', () => {
  let redisContainer: StartedRedisContainer;
  let redisClient: Redis;
  let authUpstream: FastifyInstance;
  let reportUpstream: FastifyInstance;
  let analyticsUpstream: FastifyInstance;
  let routingUpstream: FastifyInstance;
  let imageUpstream: FastifyInstance;
  let authPort: number;
  let reportPort: number;
  let analyticsPort: number;
  let routingPort: number;
  let imagePort: number;
  let gatewayPort: number;
  let gatewayApp: Awaited<ReturnType<typeof buildApp>>;
  let privateKeyPem: string;
  let publicKeyB64: string;

  beforeAll(async () => {
    // 1. Generate Ed25519 Keypair
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    publicKeyB64 = Buffer.from(pubPem).toString('base64');

    // 2. Start Pinned Redis Testcontainer
    redisContainer = await new RedisContainer(PINNED_IMAGES.redis).start();
    const redisUrl = redisContainer.getConnectionUrl();
    redisClient = new Redis(redisUrl);

    // 3. Start Mock Auth Upstream
    authUpstream = Fastify();
    authUpstream.post('/api/v1/auth/register', async (req, reply) => {
      return reply.status(201).send({
        user: { id: 'u-1', email: (req.body as { email?: string })?.email },
        receivedHeaders: req.headers
      });
    });
    authUpstream.post('/api/v1/auth/login', async (_req, reply) => {
      return reply.status(200).send({ accessToken: 'mock-token', refreshToken: 'mock-refresh' });
    });
    authUpstream.post('/api/v1/auth/refresh', async (_req, reply) => {
      return reply.status(200).send({ accessToken: 'new-token' });
    });
    authUpstream.post('/api/v1/auth/logout', async (req, reply) => {
      return reply.status(200).send({ ok: true, receivedHeaders: req.headers });
    });
    authUpstream.get('/api/v1/auth/me', async (req, reply) => {
      return reply
        .status(200)
        .send({ id: req.headers['x-user-id'], role: req.headers['x-user-role'] });
    });
    authUpstream.get('/api/v1/auth/users', async (req, reply) => {
      return reply.status(200).send({
        items: [{ id: 'u-1', email: 'admin@civic.test' }],
        receivedHeaders: req.headers
      });
    });
    authUpstream.post('/api/v1/auth/users', async (req, reply) => {
      return reply.status(201).send({
        user: { id: 'u-created', ...(req.body as Record<string, unknown>) },
        receivedHeaders: req.headers
      });
    });
    await authUpstream.listen({ port: 0, host: '127.0.0.1' });
    authPort = (authUpstream.server.address() as AddressInfo).port;

    // 4. Start Mock Report Upstream
    reportUpstream = Fastify();
    reportUpstream.get('/api/v1/public/reports', async (req, reply) => {
      return reply.status(200).send({
        items: [{ id: 'rpt-1', title: 'Pothole' }],
        query: req.query,
        receivedHeaders: req.headers
      });
    });
    reportUpstream.post('/api/v1/reports', async (req, reply) => {
      return reply.status(201).send({
        report: { id: 'rpt-created', ...(req.body as Record<string, unknown>) },
        receivedHeaders: req.headers
      });
    });
    reportUpstream.get('/api/v1/reports/mine', async (req, reply) => {
      return reply.status(200).send({
        items: [{ id: 'rpt-mine-1' }],
        receivedHeaders: req.headers
      });
    });
    reportUpstream.get('/api/v1/reports', async (req, reply) => {
      return reply.status(200).send({
        items: [{ id: 'rpt-officer-1' }],
        receivedHeaders: req.headers
      });
    });
    reportUpstream.get('/api/v1/reports/:id', async (req, reply) => {
      return reply.status(200).send({
        id: (req.params as { id: string }).id,
        receivedHeaders: req.headers
      });
    });
    reportUpstream.post('/api/v1/reports/:id/status', async (req, reply) => {
      return reply.status(200).send({
        status: (req.body as { status?: string })?.status,
        receivedHeaders: req.headers
      });
    });
    reportUpstream.get('/api/v1/public/timeout', async () => {
      await new Promise((r) => setTimeout(r, 12000));
      return { ok: true };
    });
    await reportUpstream.listen({ port: 0, host: '127.0.0.1' });
    reportPort = (reportUpstream.server.address() as AddressInfo).port;

    // 5. Start Mock Analytics Upstream
    analyticsUpstream = Fastify();
    analyticsUpstream.get('/api/v1/analytics/summary', async (req, reply) => {
      return reply.status(200).send({
        totalReports: 10,
        receivedHeaders: req.headers
      });
    });
    await analyticsUpstream.listen({ port: 0, host: '127.0.0.1' });
    analyticsPort = (analyticsUpstream.server.address() as AddressInfo).port;

    // 6. Start Mock Routing Upstream
    routingUpstream = Fastify();
    routingUpstream.get('/api/v1/routing/wards', async (req, reply) => {
      return reply.status(200).send({
        items: [{ code: 'WARD-001', name: 'Ward 1' }],
        receivedHeaders: req.headers
      });
    });
    routingUpstream.get('/api/v1/routing/departments', async (req, reply) => {
      return reply.status(200).send({
        items: [{ code: 'ROADS', name: 'Roads & Bridges' }],
        receivedHeaders: req.headers
      });
    });
    routingUpstream.get('/api/v1/routing/categories', async (req, reply) => {
      return reply.status(200).send({
        items: [{ id: 'pothole', departmentCode: 'ROADS' }],
        receivedHeaders: req.headers
      });
    });
    routingUpstream.post('/api/v1/routing/assignments', async (req, reply) => {
      return reply.status(200).send({
        assigned: true,
        receivedHeaders: req.headers
      });
    });
    await routingUpstream.listen({ port: 0, host: '127.0.0.1' });
    routingPort = (routingUpstream.server.address() as AddressInfo).port;

    // 7. Start Mock Image Upstream
    imageUpstream = Fastify({ bodyLimit: 20 * 1024 * 1024 });
    const upstreamParserOpts = { parseAs: 'buffer' as const, bodyLimit: 20 * 1024 * 1024 };
    const upstreamParser = (
      _req: unknown,
      body: Buffer,
      done: (err: Error | null, body?: Buffer) => void
    ) => {
      done(null, body);
    };
    imageUpstream.addContentTypeParser(
      ['application/octet-stream', 'multipart/form-data'],
      upstreamParserOpts,
      upstreamParser
    );
    imageUpstream.addContentTypeParser(/^multipart\//, upstreamParserOpts, upstreamParser);
    imageUpstream.addContentTypeParser(/^image\//, upstreamParserOpts, upstreamParser);
    imageUpstream.post('/api/v1/images', async (req, reply) => {
      return reply.status(202).send({
        imageId: 'img-123',
        status: 'pending',
        receivedHeaders: req.headers
      });
    });
    imageUpstream.get('/api/v1/images/:imageId', async (req, reply) => {
      return reply.status(200).send({
        id: (req.params as { imageId: string }).imageId,
        status: 'ready',
        receivedHeaders: req.headers
      });
    });
    imageUpstream.get('/api/v1/images/:imageId/thumbnail', async (_req, reply) => {
      return reply.status(200).type('image/webp').send(Buffer.from('fake-thumb'));
    });
    imageUpstream.get('/api/v1/images/:imageId/file', async (_req, reply) => {
      return reply.status(200).type('image/jpeg').send(Buffer.from('fake-file'));
    });
    await imageUpstream.listen({ port: 0, host: '127.0.0.1' });
    imagePort = (imageUpstream.server.address() as AddressInfo).port;

    // 8. Start Gateway Application
    const config = loadConfig({
      AUTH_SERVICE_URL: `http://127.0.0.1:${authPort}`,
      REPORT_SERVICE_URL: `http://127.0.0.1:${reportPort}`,
      ANALYTICS_URL: `http://127.0.0.1:${analyticsPort}`,
      ROUTING_URL: `http://127.0.0.1:${routingPort}`,
      IMAGE_URL: `http://127.0.0.1:${imagePort}`,
      REDIS_URL: redisUrl,
      JWT_PUBLIC_KEY_B64: publicKeyB64,
      JWT_ISSUER: 'civic-auth',
      JWT_AUDIENCE: 'civic-api',
      LOG_LEVEL: 'silent'
    });

    gatewayApp = await buildApp(config, {
      redis: redisClient
    });
    await gatewayApp.listen({ port: 0, host: '127.0.0.1' });
    gatewayPort = (gatewayApp.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (gatewayApp) await gatewayApp.close();
    if (authUpstream) await authUpstream.close();
    if (reportUpstream) await reportUpstream.close();
    if (analyticsUpstream) await analyticsUpstream.close();
    if (routingUpstream) await routingUpstream.close();
    if (imageUpstream) await imageUpstream.close();
    if (redisClient) redisClient.disconnect();
    if (redisContainer) await redisContainer.stop();
  });

  beforeEach(async () => {
    if (redisClient && redisClient.status === 'ready') {
      await redisClient.flushall();
    }
  });

  async function createToken(claims: { sub: string; role: string; email?: string }, exp = '15m') {
    const key = await importPKCS8(privateKeyPem, 'EdDSA');
    return new SignJWT({ role: claims.role, email: claims.email })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(claims.sub)
      .setIssuer('civic-auth')
      .setAudience('civic-api')
      .setExpirationTime(exp)
      .sign(key);
  }

  describe('Health Probes', () => {
    it('returns 200 on /healthz', async () => {
      const res = await request(gatewayApp.server).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('returns 200 on /readyz with active redis', async () => {
      const res = await request(gatewayApp.server).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
    });
  });

  describe('Public Routing & Header Hygiene', () => {
    it('proxies public auth registration and strips client-injected x-user-* headers', async () => {
      const res = await request(gatewayApp.server)
        .post('/api/v1/auth/register')
        .set('x-user-id', 'spoofed-id')
        .set('x-user-role', 'admin')
        .send({ email: 'new@example.com', password: 'password123' });

      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe('new@example.com');
      // Verify upstream never saw the spoofed headers
      expect(res.body.receivedHeaders['x-user-id']).toBeUndefined();
      expect(res.body.receivedHeaders['x-user-role']).toBeUndefined();
      expect(res.body.receivedHeaders['x-correlation-id']).toBeDefined();
    });

    it('proxies public auth logout without requiring a token', async () => {
      const res = await request(gatewayApp.server)
        .post('/api/v1/auth/logout')
        .send({ refreshToken: 'dummy-token' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('proxies public report listings preserving query parameters', async () => {
      const res = await request(gatewayApp.server)
        .get('/api/v1/public/reports?status=open&category=pothole')
        .set('x-correlation-id', 'custom-corr-id');

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.query).toEqual({ status: 'open', category: 'pothole' });
      expect(res.headers['x-correlation-id']).toBe('custom-corr-id');
    });
  });

  describe('JWT Verification & Injected Identity', () => {
    it('requires JWT on /api/v1/auth/users and /api/v1/analytics', async () => {
      const resUsersNoToken = await request(gatewayApp.server).get('/api/v1/auth/users');
      expect(resUsersNoToken.status).toBe(401);
      expect(resUsersNoToken.body.code).toBe('unauthorized');

      const resAnalyticsNoToken = await request(gatewayApp.server).get('/api/v1/analytics/summary');
      expect(resAnalyticsNoToken.status).toBe(401);
      expect(resAnalyticsNoToken.body.code).toBe('unauthorized');

      // With valid token, both pass through to upstream
      const adminToken = await createToken({ sub: 'admin-1', role: 'admin' });
      const resUsersWithToken = await request(gatewayApp.server)
        .get('/api/v1/auth/users')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(resUsersWithToken.status).toBe(200);
      expect(resUsersWithToken.body.items).toBeDefined();

      const resAnalyticsWithToken = await request(gatewayApp.server)
        .get('/api/v1/analytics/summary')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(resAnalyticsWithToken.status).toBe(200);
    });
    it('rejects unauthenticated requests to protected endpoints with 401 Problem Details', async () => {
      const res = await request(gatewayApp.server).post('/api/v1/reports').send({ title: 'test' });

      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.code).toBe('unauthorized');
      expect(res.body.status).toBe(401);
    });

    it('rejects expired token with 401 Problem Details', async () => {
      const expiredToken = await createToken({ sub: 'user-expired', role: 'citizen' }, '-10s');
      const res = await request(gatewayApp.server)
        .post('/api/v1/reports')
        .set('Authorization', `Bearer ${expiredToken}`)
        .send({ title: 'test' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
      expect(res.body.title).toContain('expired');
    });

    it('authenticates valid citizen token, overwrites spoofed headers, and forwards verified identity', async () => {
      const citizenToken = await createToken({
        sub: 'citizen-uuid-42',
        role: 'citizen',
        email: 'cit@example.com'
      });

      const res = await request(gatewayApp.server)
        .post('/api/v1/reports')
        .set('Authorization', `Bearer ${citizenToken}`)
        .set('x-user-id', 'hacker-attempt')
        .set('x-user-role', 'admin')
        .send({ title: 'Pothole on 5th', description: 'Deep pothole' });

      expect(res.status).toBe(201);
      expect(res.body.receivedHeaders['x-user-id']).toBe('citizen-uuid-42');
      expect(res.body.receivedHeaders['x-user-role']).toBe('citizen');
      expect(res.body.receivedHeaders['x-user-email']).toBe('cit@example.com');
      expect(res.body.receivedHeaders.authorization).toContain('Bearer');
    });
  });

  describe('Role-Based Access Control', () => {
    it('forbids officer from creating reports (POST /api/v1/reports is citizen-only)', async () => {
      const officerToken = await createToken({ sub: 'officer-1', role: 'officer' });
      const res = await request(gatewayApp.server)
        .post('/api/v1/reports')
        .set('Authorization', `Bearer ${officerToken}`)
        .send({ title: 'Officer attempt' });

      expect(res.status).toBe(403);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.code).toBe('forbidden');
    });

    it('forbids officer from viewing citizen-only /mine endpoint', async () => {
      const officerToken = await createToken({ sub: 'officer-1', role: 'officer' });
      const res = await request(gatewayApp.server)
        .get('/api/v1/reports/mine')
        .set('Authorization', `Bearer ${officerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
    });

    it('forbids citizen from viewing officer triage list (GET /api/v1/reports is officer/admin)', async () => {
      const citizenToken = await createToken({ sub: 'cit-1', role: 'citizen' });
      const res = await request(gatewayApp.server)
        .get('/api/v1/reports')
        .set('Authorization', `Bearer ${citizenToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
    });

    it('allows officer to view officer triage list', async () => {
      const officerToken = await createToken({ sub: 'officer-1', role: 'officer' });
      const res = await request(gatewayApp.server)
        .get('/api/v1/reports')
        .set('Authorization', `Bearer ${officerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.items[0].id).toBe('rpt-officer-1');
    });

    it('requires JWT on /api/v1/analytics/summary (returns 401)', async () => {
      const res = await request(gatewayApp.server).get('/api/v1/analytics/summary');
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
    });

    it('proxies to analytics upstream when valid JWT provided', async () => {
      const token = await createToken({
        sub: 'admin-1',
        role: 'admin',
        email: 'admin@example.com'
      });
      const res = await request(gatewayApp.server)
        .get('/api/v1/analytics/summary')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.totalReports).toBe(10);
      expect(res.body.receivedHeaders['x-user-id']).toBe('admin-1');
      expect(res.body.receivedHeaders['x-user-role']).toBe('admin');
    });
  });

  describe('Rate Limiting & Fail-Open', () => {
    it('returns 429 Problem Details when auth route exceeds 10 req/min rate limit', async () => {
      const uniqueIp = `198.51.100.${Math.floor(Math.random() * 200) + 10}`;

      // Send 10 requests
      for (let i = 0; i < 10; i++) {
        const res = await request(gatewayApp.server)
          .post('/api/v1/auth/refresh')
          .set('x-forwarded-for', uniqueIp);
        expect(res.status).toBe(200);
      }

      // 11th request must be rate limited with 429
      const r11 = await request(gatewayApp.server)
        .post('/api/v1/auth/refresh')
        .set('x-forwarded-for', uniqueIp);

      expect(r11.status).toBe(429);
      expect(r11.headers['content-type']).toContain('application/problem+json');
      expect(r11.headers['retry-after']).toBeDefined();
      expect(r11.body.code).toBe('rate_limit_exceeded');
      expect(r11.body.status).toBe(429);
    });

    it('fails open when Redis connection is broken', async () => {
      const brokenRedis = new Redis('redis://127.0.0.1:1/0', {
        maxRetriesPerRequest: 0,
        enableOfflineQueue: false,
        lazyConnect: true
      });
      const failConfig = loadConfig({
        AUTH_SERVICE_URL: `http://127.0.0.1:${authPort}`,
        REPORT_SERVICE_URL: `http://127.0.0.1:${reportPort}`,
        ANALYTICS_URL: `http://127.0.0.1:${analyticsPort}`,
        REDIS_URL: 'redis://127.0.0.1:1/0',
        JWT_PUBLIC_KEY_B64: publicKeyB64,
        LOG_LEVEL: 'silent'
      });
      const failOpenApp = await buildApp(failConfig, { redis: brokenRedis });
      await failOpenApp.listen({ port: 0, host: '127.0.0.1' });

      const res = await request(failOpenApp.server)
        .post('/api/v1/auth/login')
        .send({ email: 'test@example.com', password: 'password123' });

      // Request must proceed without 500 error
      expect(res.status).toBe(200);

      await failOpenApp.close();
      brokenRedis.disconnect();
    });

    it('with TRUST_PROXY=1 client IP comes from x-forwarded-for', async () => {
      const tpConfig = loadConfig({
        AUTH_SERVICE_URL: `http://127.0.0.1:${authPort}`,
        REPORT_SERVICE_URL: `http://127.0.0.1:${reportPort}`,
        ANALYTICS_URL: `http://127.0.0.1:${analyticsPort}`,
        REDIS_URL: redisContainer.getConnectionUrl(),
        JWT_PUBLIC_KEY_B64: publicKeyB64,
        TRUST_PROXY: '1',
        LOG_LEVEL: 'silent'
      });
      const tpRedis = new Redis(redisContainer.getConnectionUrl());
      await tpRedis.flushall();
      const tpApp = await buildApp(tpConfig, { redis: tpRedis });
      await tpApp.listen({ port: 0, host: '127.0.0.1' });

      const uniqueForwardedIp = '198.51.100.42';
      for (let i = 0; i < 10; i++) {
        const res = await request(tpApp.server)
          .post('/api/v1/auth/refresh')
          .set('x-forwarded-for', uniqueForwardedIp);
        expect(res.status).toBe(200);
      }
      const r11 = await request(tpApp.server)
        .post('/api/v1/auth/refresh')
        .set('x-forwarded-for', uniqueForwardedIp);
      expect(r11.status).toBe(429);

      // Different IP gets 200 because IP bucket is separated
      const differentIp = '198.51.100.254';
      const rOther = await request(tpApp.server)
        .post('/api/v1/auth/refresh')
        .set('x-forwarded-for', differentIp);
      expect(rOther.status).toBe(200);

      await tpApp.close();
      tpRedis.disconnect();
    });

    it('with TRUST_PROXY=false spoofed x-forwarded-for does NOT change rate-limit bucket', async () => {
      const noTpConfig = loadConfig({
        AUTH_SERVICE_URL: `http://127.0.0.1:${authPort}`,
        REPORT_SERVICE_URL: `http://127.0.0.1:${reportPort}`,
        ANALYTICS_URL: `http://127.0.0.1:${analyticsPort}`,
        REDIS_URL: redisContainer.getConnectionUrl(),
        JWT_PUBLIC_KEY_B64: publicKeyB64,
        TRUST_PROXY: false,
        LOG_LEVEL: 'silent'
      });
      const noTpRedis = new Redis(redisContainer.getConnectionUrl());
      await noTpRedis.flushall();
      const noTpApp = await buildApp(noTpConfig, { redis: noTpRedis });
      await noTpApp.listen({ port: 0, host: '127.0.0.1' });

      // Send 10 requests with different spoofed x-forwarded-for values
      for (let i = 0; i < 10; i++) {
        const res = await request(noTpApp.server)
          .post('/api/v1/auth/refresh')
          .set('x-forwarded-for', `203.0.113.${i + 1}`);
        expect(res.status).toBe(200);
      }
      // 11th request with another spoofed IP is still 429 because socket IP bucket is shared
      const r11 = await request(noTpApp.server)
        .post('/api/v1/auth/refresh')
        .set('x-forwarded-for', '203.0.113.99');
      expect(r11.status).toBe(429);

      await noTpApp.close();
      noTpRedis.disconnect();
    });

    it('per-user rate limit keys by user ID when token is present', async () => {
      if (redisClient && redisClient.status === 'ready') {
        await redisClient.flushall();
      }
      const userId1 = `rate-user-1-${Date.now()}`;
      const token1 = await createToken({ sub: userId1, role: 'citizen' });

      for (let i = 0; i < 120; i++) {
        const res = await request(gatewayApp.server)
          .get('/api/v1/public/reports')
          .set('Authorization', `Bearer ${token1}`);
        expect(res.status).toBe(200);
      }

      const r121 = await request(gatewayApp.server)
        .get('/api/v1/public/reports')
        .set('Authorization', `Bearer ${token1}`);
      expect(r121.status).toBe(429);
      expect(r121.body.code).toBe('rate_limit_exceeded');

      // Different user gets 200
      const userId2 = `rate-user-2-${Date.now()}`;
      const token2 = await createToken({ sub: userId2, role: 'citizen' });
      const rUser2 = await request(gatewayApp.server)
        .get('/api/v1/public/reports')
        .set('Authorization', `Bearer ${token2}`);
      expect(rUser2.status).toBe(200);
    });
  });

  describe('Configuration Validation', () => {
    it('fails when JWT_PUBLIC_KEY_B64 is missing', () => {
      expect(() => {
        loadConfig({
          AUTH_SERVICE_URL: 'http://auth:3000',
          REPORT_SERVICE_URL: 'http://report:3000',
          ANALYTICS_URL: 'http://analytics:3000',
          REDIS_URL: 'redis://127.0.0.1:6379/0'
        });
      }).toThrow();
    });

    it('fails when JWT_PUBLIC_KEY_B64 is unparsable or not a public key', () => {
      expect(() => {
        loadConfig({
          AUTH_SERVICE_URL: 'http://auth:3000',
          REPORT_SERVICE_URL: 'http://report:3000',
          ANALYTICS_URL: 'http://analytics:3000',
          REDIS_URL: 'redis://127.0.0.1:6379/0',
          JWT_PUBLIC_KEY_B64: Buffer.from('invalid-key-data').toString('base64')
        });
      }).toThrow();
    });
  });

  describe('Upstream Error Mapping', () => {
    it('maps upstream timeout to 504 Gateway Timeout Problem Details', async () => {
      const res = await request(gatewayApp.server).get('/api/v1/public/timeout');

      expect(res.status).toBe(504);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.code).toBe('gateway_timeout');
      expect(res.body.status).toBe(504);
    }, 20000);

    it('maps upstream failure to 502 Bad Gateway Problem Details', async () => {
      // Temporarily close report upstream
      await reportUpstream.close();

      const res = await request(gatewayApp.server).get('/api/v1/public/reports');

      expect(res.status).toBe(502);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.code).toBe('bad_gateway');
      expect(res.body.status).toBe(502);

      // Restart report upstream
      reportUpstream = Fastify();
      reportUpstream.get('/api/v1/public/reports', async () => ({ items: [] }));
      await reportUpstream.listen({ port: reportPort, host: '127.0.0.1' });
    });
  });

  describe('Security Headers, CORS & 404', () => {
    it('serves Helmet security headers', async () => {
      const res = await request(gatewayApp.server).get('/healthz');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    });

    it('serves CORS preflight response', async () => {
      const res = await request(gatewayApp.server)
        .options('/api/v1/auth/login')
        .set('Origin', 'http://localhost:5173')
        .set('Access-Control-Request-Method', 'POST');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    });

    it('returns 404 Problem Details on unknown routes', async () => {
      const res = await request(gatewayApp.server).get('/api/v1/non-existent-endpoint');

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.code).toBe('not_found');
      expect(res.body.status).toBe(404);
    });

    it('rejects oversized payload with 413 Problem Details', async () => {
      const bigBuffer = Buffer.alloc(1.2 * 1024 * 1024, 'a').toString();
      const res = await fetch(`http://127.0.0.1:${gatewayPort}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ huge: bigBuffer })
      });

      expect(res.status).toBe(413);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('payload_too_large');
    });
  });

  describe('Routing Service Reverse Proxy', () => {
    it('proxies public GET /api/v1/routing/wards without authentication', async () => {
      const res = await request(gatewayApp.server).get('/api/v1/routing/wards');
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].code).toBe('WARD-001');
    });

    it('proxies public GET /api/v1/routing/departments without authentication', async () => {
      const res = await request(gatewayApp.server).get('/api/v1/routing/departments');
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].code).toBe('ROADS');
    });

    it('proxies public GET /api/v1/routing/categories without authentication', async () => {
      const res = await request(gatewayApp.server).get('/api/v1/routing/categories');
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].id).toBe('pothole');
    });

    it('rejects unauthenticated requests to protected routing routes with 401', async () => {
      const res = await request(gatewayApp.server)
        .post('/api/v1/routing/assignments')
        .send({ reportId: '00000000-0000-0000-0000-000000000001' });

      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.code).toBe('unauthorized');
    });

    it('proxies authenticated requests to protected routing routes and passes identity headers', async () => {
      const token = await createToken({
        sub: 'user-officer-99',
        role: 'officer',
        email: 'officer99@civic.local'
      });
      const res = await request(gatewayApp.server)
        .post('/api/v1/routing/assignments')
        .set('Authorization', `Bearer ${token}`)
        .send({ reportId: '00000000-0000-0000-0000-000000000001' });

      expect(res.status).toBe(200);
      expect(res.body.assigned).toBe(true);
      expect(res.body.receivedHeaders['x-user-id']).toBe('user-officer-99');
      expect(res.body.receivedHeaders['x-user-role']).toBe('officer');
      expect(res.body.receivedHeaders['x-user-email']).toBe('officer99@civic.local');
    });
  });

  describe('Image Service Reverse Proxy', () => {
    it('allows 5 MiB upload through gateway with authentication', async () => {
      const token = await createToken({
        sub: 'user-citizen-42',
        role: 'citizen',
        email: 'citizen42@civic.local'
      });
      const fiveMbBuffer = Buffer.alloc(5 * 1024 * 1024, 0x42);

      const res = await fetch(`http://127.0.0.1:${gatewayPort}/api/v1/images`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream'
        },
        body: fiveMbBuffer
      });

      expect(res.status).toBe(202);
      const data = (await res.json()) as {
        imageId: string;
        status: string;
        receivedHeaders: Record<string, string>;
      };
      expect(data.imageId).toBe('img-123');
      expect(data.receivedHeaders['x-user-id']).toBe('user-citizen-42');
      expect(data.receivedHeaders['x-user-role']).toBe('citizen');
    });

    it('rejects 10 MiB upload with 413 Payload Too Large (exceeds 9 MiB limit)', async () => {
      const token = await createToken({
        sub: 'user-citizen-42',
        role: 'citizen'
      });
      const totalBytes = 10 * 1024 * 1024;

      const res = await new Promise<{ status: number; body: { code: string } }>(
        (resolve, reject) => {
          const clientReq = http.request(
            `http://127.0.0.1:${gatewayPort}/api/v1/images`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/octet-stream',
                'Content-Length': totalBytes
              }
            },
            (clientRes) => {
              let data = '';
              clientRes.on('data', (chunk) => {
                data += chunk;
              });
              clientRes.on('end', () => {
                try {
                  resolve({ status: clientRes.statusCode!, body: JSON.parse(data) });
                } catch (e) {
                  reject(e);
                }
              });
            }
          );

          clientReq.on('error', (err: unknown) => {
            if ((err as { code?: string }).code !== 'ECONNRESET') {
              reject(err);
            }
          });

          // Write initial chunk; Fastify checks Content-Length against 9 MiB limit and sends 413
          const chunk = Buffer.alloc(64 * 1024, 0x42);
          clientReq.write(chunk);
        }
      );

      expect(res.status).toBe(413);
      expect(res.body.code).toBe('payload_too_large');
    });

    it('proxies public GET /api/v1/images/:imageId/thumbnail without authentication', async () => {
      const res = await request(gatewayApp.server).get('/api/v1/images/img-123/thumbnail');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/webp');
    });

    it('proxies public GET /api/v1/images/:imageId/file without authentication', async () => {
      const res = await request(gatewayApp.server).get('/api/v1/images/img-123/file');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/jpeg');
    });

    it('rejects unauthenticated GET /api/v1/images/:imageId with 401', async () => {
      const res = await request(gatewayApp.server).get('/api/v1/images/img-123');
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.code).toBe('unauthorized');
    });

    it('proxies authenticated GET /api/v1/images/:imageId', async () => {
      const token = await createToken({
        sub: 'user-citizen-42',
        role: 'citizen'
      });
      const res = await request(gatewayApp.server)
        .get('/api/v1/images/img-123')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('img-123');
      expect(res.body.status).toBe('ready');
      expect(res.body.receivedHeaders['x-user-id']).toBe('user-citizen-42');
    });
  });
});
