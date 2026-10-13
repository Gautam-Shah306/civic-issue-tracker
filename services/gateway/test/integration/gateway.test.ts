import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  let authPort: number;
  let reportPort: number;
  let analyticsPort: number;
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
        user: { id: 'u-1', email: (req.body as any)?.email },
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
    await authUpstream.listen({ port: 0, host: '127.0.0.1' });
    authPort = (authUpstream.server.address() as any).port;

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
        report: { id: 'rpt-created', ...(req.body as any) },
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
        id: (req.params as any).id,
        receivedHeaders: req.headers
      });
    });
    reportUpstream.post('/api/v1/reports/:id/status', async (req, reply) => {
      return reply.status(200).send({
        status: (req.body as any)?.status,
        receivedHeaders: req.headers
      });
    });
    reportUpstream.get('/api/v1/public/timeout', async () => {
      await new Promise((r) => setTimeout(r, 12000));
      return { ok: true };
    });
    await reportUpstream.listen({ port: 0, host: '127.0.0.1' });
    reportPort = (reportUpstream.server.address() as any).port;

    // 5. Start Mock Analytics Upstream
    analyticsUpstream = Fastify();
    analyticsUpstream.get('/api/v1/analytics/summary', async (req, reply) => {
      return reply.status(200).send({
        totalReports: 10,
        receivedHeaders: req.headers
      });
    });
    await analyticsUpstream.listen({ port: 0, host: '127.0.0.1' });
    analyticsPort = (analyticsUpstream.server.address() as any).port;

    // 6. Start Gateway Application
    const config = loadConfig({
      AUTH_SERVICE_URL: `http://127.0.0.1:${authPort}`,
      REPORT_SERVICE_URL: `http://127.0.0.1:${reportPort}`,
      ANALYTICS_URL: `http://127.0.0.1:${analyticsPort}`,
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
    gatewayPort = (gatewayApp.server.address() as any).port;
  });

  afterAll(async () => {
    if (gatewayApp) await gatewayApp.close();
    if (authUpstream) await authUpstream.close();
    if (reportUpstream) await reportUpstream.close();
    if (analyticsUpstream) await analyticsUpstream.close();
    if (redisClient) redisClient.disconnect();
    if (redisContainer) await redisContainer.stop();
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
      // Disconnect redis client
      redisClient.disconnect();

      const res = await request(gatewayApp.server)
        .post('/api/v1/auth/login')
        .send({ email: 'test@example.com', password: 'password123' });

      // Request must proceed without 500 error
      expect(res.status).toBe(200);

      // Reconnect redis for subsequent tests
      const redisUrl = redisContainer.getConnectionUrl();
      redisClient = new Redis(redisUrl);
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
});
