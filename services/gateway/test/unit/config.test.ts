import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('Gateway Config Loader', () => {
  const validKeyB64 = Buffer.from(
    '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----'
  ).toString('base64');

  it('loads valid configuration with defaults', () => {
    const config = loadConfig({
      JWT_PUBLIC_KEY_B64: validKeyB64
    });

    expect(config.SERVICE_NAME).toBe('gateway');
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.AUTH_SERVICE_URL).toBe('http://auth:3000');
    expect(config.REPORT_SERVICE_URL).toBe('http://report:3000');
    expect(config.REDIS_URL).toBe('redis://127.0.0.1:6379/0');
    expect(config.JWT_ISSUER).toBe('civic-auth');
    expect(config.JWT_AUDIENCE).toBe('civic-api');
    expect(config.CORS_ORIGINS).toBe('http://localhost:5173');
    expect(config.TRUST_PROXY).toBe(false);
  });

  it('overrides defaults with provided environment variables', () => {
    const config = loadConfig({
      PORT: '8080',
      LOG_LEVEL: 'debug',
      AUTH_SERVICE_URL: 'http://custom-auth:4000',
      REPORT_SERVICE_URL: 'http://custom-report:5000',
      REDIS_URL: 'redis://custom-redis:6379/1',
      JWT_PUBLIC_KEY_B64: validKeyB64,
      JWT_ISSUER: 'custom-issuer',
      JWT_AUDIENCE: 'custom-audience',
      CORS_ORIGINS: 'http://localhost:3000,http://localhost:5173',
      TRUST_PROXY: '1'
    });

    expect(config.PORT).toBe(8080);
    expect(config.LOG_LEVEL).toBe('debug');
    expect(config.AUTH_SERVICE_URL).toBe('http://custom-auth:4000');
    expect(config.REPORT_SERVICE_URL).toBe('http://custom-report:5000');
    expect(config.REDIS_URL).toBe('redis://custom-redis:6379/1');
    expect(config.JWT_PUBLIC_KEY_B64).toBe(validKeyB64);
    expect(config.JWT_ISSUER).toBe('custom-issuer');
    expect(config.JWT_AUDIENCE).toBe('custom-audience');
    expect(config.CORS_ORIGINS).toBe('http://localhost:3000,http://localhost:5173');
    expect(config.TRUST_PROXY).toBe(1);
  });

  it('throws when JWT_PUBLIC_KEY_B64 is missing or invalid', () => {
    expect(() => loadConfig({})).toThrow();
    expect(() =>
      loadConfig({
        JWT_PUBLIC_KEY_B64: Buffer.from('not-a-key').toString('base64')
      })
    ).toThrow();
  });
});
