import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Template Service App', () => {
  const config = loadConfig({
    SERVICE_NAME: 'test-service',
    PORT: '3000',
    LOG_LEVEL: 'silent'
  });
  const app = buildApp(config);

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);

  let validateProblem: ReturnType<typeof ajv.compile>;

  beforeAll(async () => {
    await app.ready();

    // Load RFC 9457 problem schema from repo contracts
    const schemaPath = path.resolve(__dirname, '../../../contracts/openapi/problem.v1.schema.json');
    const problemSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    validateProblem = ajv.compile(problemSchema);
  });

  it('GET /healthz returns 200 and ok status', async () => {
    const res = await request(app.server).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /readyz returns 200 and ready status', async () => {
    const res = await request(app.server).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', ready: true });
  });

  it('generates a new correlation ID if not provided', async () => {
    const res = await request(app.server).get('/healthz');
    expect(res.status).toBe(200);
    const correlationId = res.headers['x-correlation-id'];
    expect(correlationId).toBeDefined();
    expect(correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('echoes valid provided correlation ID in response header', async () => {
    const customCorrelationId = '12345678-1234-4234-8234-123456789abc';
    const res = await request(app.server)
      .get('/healthz')
      .set('x-correlation-id', customCorrelationId);
    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBe(customCorrelationId);
  });

  it('GET /non-existent returns 404 problem details validating against schema', async () => {
    const res = await request(app.server).get('/non-existent');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.status).toBe(404);

    const isValid = validateProblem(res.body);
    expect(validateProblem.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('GET /api/v1/ping with invalid query (n=99) returns 400 problem details validating against schema', async () => {
    const res = await request(app.server).get('/api/v1/ping?n=99');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.status).toBe(400);
    expect(Array.isArray(res.body.errors)).toBe(true);

    const isValid = validateProblem(res.body);
    expect(validateProblem.errors).toBeNull();
    expect(isValid).toBe(true);
  });

  it('GET /api/v1/openapi.json serves OpenAPI specification', async () => {
    const res = await request(app.server).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBeDefined();
    expect(res.body.info.title).toBe('test-service');
  });

  it('formats custom AppError correctly in error handler', async () => {
    // Dynamically test formatProblemDetails directly with AppError
    const { AppError, formatProblemDetails } = await import('../src/errors.js');
    const err = new AppError({
      message: 'Forbidden resource',
      statusCode: 403,
      code: 'FORBIDDEN_ACCESS'
    });
    const problem = formatProblemDetails({
      title: err.message,
      status: err.statusCode,
      code: err.code,
      correlationId: '12345678-1234-4234-8234-123456789abc'
    });
    expect(problem.status).toBe(403);
    expect(problem.code).toBe('FORBIDDEN_ACCESS');
    expect(validateProblem(problem)).toBe(true);
  });
});
