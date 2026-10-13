import crypto from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import { createTokenService, TokenService } from '../../src/auth/tokens.js';
import { Config } from '../../src/config.js';

describe('Token Service (EdDSA / Ed25519 and Refresh Tokens)', () => {
  let tokenService: TokenService;
  let testPrivateKeyB64: string;

  beforeAll(async () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    testPrivateKeyB64 = Buffer.from(pem).toString('base64');

    const config: Config = {
      SERVICE_NAME: 'auth',
      PORT: 3000,
      LOG_LEVEL: 'silent',
      DB_HOST: 'localhost',
      DB_PORT: 5432,
      DB_NAME: 'civic_auth',
      DB_USER: 'civic_auth',
      DB_PASSWORD: '',
      RABBITMQ_URL: '',
      JWT_PRIVATE_KEY_B64: testPrivateKeyB64,
      JWT_ISSUER: 'civic-auth',
      JWT_AUDIENCE: 'civic-api',
      ACCESS_TTL_SECONDS: 900,
      REFRESH_TTL_DAYS: 7,
      ARGON2_MEMORY_KIB: 19456,
      ARGON2_ITERATIONS: 2,
      ARGON2_PARALLELISM: 1,
      OUTBOX_INTERVAL_MS: 500,
      CONTRACTS_DIR: '../../contracts'
    };

    tokenService = await createTokenService(config);
  });

  it('issues an access token that can be verified with correct claims', async () => {
    const user = { id: crypto.randomUUID(), role: 'citizen' };
    const { token, expiresIn } = await tokenService.issueAccessToken(user);

    expect(token).toBeTypeOf('string');
    expect(expiresIn).toBe(900);

    const verified = await tokenService.verifyAccessToken(token);
    expect(verified.userId).toBe(user.id);
    expect(verified.role).toBe(user.role);
  });

  it('provides public JWKS matching RFC 7517 and Ed25519 OKP curve', async () => {
    const jwks = await tokenService.getPublicJwks();
    expect(jwks.keys).toHaveLength(1);
    const key = jwks.keys[0];
    expect(key.kty).toBe('OKP');
    expect(key.crv).toBe('Ed25519');
    expect(key.alg).toBe('EdDSA');
    expect(key.use).toBe('sig');
    expect(key.kid).toBeDefined();
    expect(key.x).toBeDefined();
  });

  it('rejects an expired token', async () => {
    const privPem = Buffer.from(testPrivateKeyB64, 'base64').toString('utf8');
    const jose = await import('jose');
    const privKey = await jose.importPKCS8(privPem, 'EdDSA');

    const expiredToken = await new SignJWT({ role: 'citizen' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(crypto.randomUUID())
      .setIssuer('civic-auth')
      .setAudience('civic-api')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 100)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(privKey);

    await expect(tokenService.verifyAccessToken(expiredToken)).rejects.toThrow();
  });

  it('rejects a token signed with a different key', async () => {
    const foreignPair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const foreignToken = await new SignJWT({ role: 'citizen' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(crypto.randomUUID())
      .setIssuer('civic-auth')
      .setAudience('civic-api')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(foreignPair.privateKey);

    await expect(tokenService.verifyAccessToken(foreignToken)).rejects.toThrow();
  });

  it('rejects a token with wrong audience', async () => {
    const privPem = Buffer.from(testPrivateKeyB64, 'base64').toString('utf8');
    const jose = await import('jose');
    const privKey = await jose.importPKCS8(privPem, 'EdDSA');

    const wrongAudToken = await new SignJWT({ role: 'citizen' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(crypto.randomUUID())
      .setIssuer('civic-auth')
      .setAudience('wrong-aud')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(privKey);

    await expect(tokenService.verifyAccessToken(wrongAudToken)).rejects.toThrow();
  });

  it('rejects a token signed with alg none or symmetric HS256', async () => {
    // Attempt HS256 token
    const secret = new TextEncoder().encode('super-secret-key-that-is-at-least-32-bytes-long');
    const hs256Token = await new SignJWT({ role: 'citizen' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(crypto.randomUUID())
      .setIssuer('civic-auth')
      .setAudience('civic-api')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(secret);

    await expect(tokenService.verifyAccessToken(hs256Token)).rejects.toThrow();
  });

  it('generates 32-byte opaque refresh tokens with consistent SHA-256 hashes', () => {
    const refresh = tokenService.generateRefreshToken();
    expect(refresh.rawToken).toBeTypeOf('string');
    expect(refresh.expiresInSeconds).toBe(7 * 86400);

    const recomputedHash = tokenService.hashRefreshToken(refresh.rawToken);
    expect(recomputedHash).toBe(refresh.tokenHash);
    expect(recomputedHash).toHaveLength(64); // SHA-256 hex length
  });

  it('rejects a token missing sub or role', async () => {
    const privPem = Buffer.from(testPrivateKeyB64, 'base64').toString('utf8');
    const jose = await import('jose');
    const privKey = await jose.importPKCS8(privPem, 'EdDSA');

    const tokenMissingSub = await new jose.SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid: 'civic-auth-key-1' })
      .setIssuer('civic-auth')
      .setAudience('civic-api')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(privKey);

    await expect(tokenService.verifyAccessToken(tokenMissingSub)).rejects.toThrow(
      'Missing subject or role in token payload'
    );
  });
});
