import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, importPKCS8 } from 'jose';
import { createJwtVerifier } from '../../src/auth/jwt.js';
import { loadConfig } from '../../src/config.js';
import { AppError } from '../../src/errors.js';

describe('Gateway JWT Verifier', () => {
  let publicKeyB64: string;
  let privateKeyPem: string;
  let verifier: Awaited<ReturnType<typeof createJwtVerifier>>;

  beforeAll(async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    publicKeyB64 = Buffer.from(pubPem).toString('base64');

    const config = loadConfig({
      JWT_PUBLIC_KEY_B64: publicKeyB64,
      JWT_ISSUER: 'civic-auth',
      JWT_AUDIENCE: 'civic-api'
    });

    verifier = await createJwtVerifier(config);
  });

  async function issueToken(
    claims: { sub: string; role?: string; email?: string },
    options: { exp?: string; issuer?: string; audience?: string; key?: string } = {}
  ) {
    const key = await importPKCS8(options.key || privateKeyPem, 'EdDSA');
    return new SignJWT({ role: claims.role, email: claims.email })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(claims.sub)
      .setIssuer(options.issuer || 'civic-auth')
      .setAudience(options.audience || 'civic-api')
      .setExpirationTime(options.exp || '15m')
      .sign(key);
  }

  it('verifies valid token and extracts claims', async () => {
    const token = await issueToken({
      sub: 'user-1',
      role: 'citizen',
      email: 'citizen@example.com'
    });
    const user = await verifier.verifyToken(`Bearer ${token}`);

    expect(user.id).toBe('user-1');
    expect(user.role).toBe('citizen');
    expect(user.email).toBe('citizen@example.com');
  });

  it('rejects missing or malformed authorization header', async () => {
    await expect(verifier.verifyToken(undefined)).rejects.toThrow(AppError);
    await expect(verifier.verifyToken('Basic xyz')).rejects.toThrow(AppError);
    await expect(verifier.verifyToken('Bearer ')).rejects.toThrow(AppError);
  });

  it('rejects expired token with clear message', async () => {
    const token = await issueToken({ sub: 'user-1', role: 'citizen' }, { exp: '-10s' });

    await expect(verifier.verifyToken(`Bearer ${token}`)).rejects.toThrow('Token has expired');
  });

  it('rejects token signed with different private key', async () => {
    const foreign = generateKeyPairSync('ed25519');
    const foreignPrivPem = foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const token = await issueToken({ sub: 'user-1', role: 'citizen' }, { key: foreignPrivPem });

    await expect(verifier.verifyToken(`Bearer ${token}`)).rejects.toThrow('Invalid token');
  });

  it('rejects token missing valid role', async () => {
    const token = await issueToken({ sub: 'user-1', role: 'invalid_role' });
    await expect(verifier.verifyToken(`Bearer ${token}`)).rejects.toThrow(
      'Token role claim is missing or invalid'
    );
  });

  it('enforces role policies with requireRole', async () => {
    const guard = verifier.requireRole(['officer', 'admin']);

    const reqMock1: any = {
      headers: {},
      user: { id: 'u1', role: 'citizen' }
    };
    await expect(guard(reqMock1, {} as any)).rejects.toThrow(AppError);

    const reqMock2: any = {
      headers: {},
      user: { id: 'u2', role: 'officer' }
    };
    await expect(guard(reqMock2, {} as any)).resolves.toBeUndefined();
  });
});
