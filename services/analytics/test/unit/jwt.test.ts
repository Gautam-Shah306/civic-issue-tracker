import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { createJwtVerifier } from '../../src/auth/jwt.js';
import { loadConfig } from '../../src/config.js';

describe('Analytics JWT Verifier Unit Tests', () => {
  it('throws if public key is malformed', async () => {
    const config = loadConfig({
      JWT_PUBLIC_KEY_B64: 'bm90LWEtcGVsLWtleQ==',
      DB_PASSWORD: 'dummy'
    });
    await expect(createJwtVerifier(config)).rejects.toThrow(/Failed to parse JWT_PUBLIC_KEY_B64/);
  });

  it('rejects empty bearer or missing sub/role claims', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const keyB64 = Buffer.from(pubPem).toString('base64');

    const config = loadConfig({
      JWT_PUBLIC_KEY_B64: keyB64,
      DB_PASSWORD: 'dummy'
    });
    const verifier = await createJwtVerifier(config);

    // Empty Bearer
    await expect(verifier.verifyToken('Bearer ')).rejects.toThrow('Missing access token');

    // Missing sub claim
    const noSubToken = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('civic-auth')
      .setAudience('civic-api')
      .setExpirationTime('1h')
      .sign(privateKey);
    await expect(verifier.verifyToken(`Bearer ${noSubToken}`)).rejects.toThrow(
      'Token subject (sub) claim is missing or invalid'
    );

    // Invalid role claim
    const badRoleToken = await new SignJWT({ role: 'superuser' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject('user-1')
      .setIssuer('civic-auth')
      .setAudience('civic-api')
      .setExpirationTime('1h')
      .sign(privateKey);
    await expect(verifier.verifyToken(`Bearer ${badRoleToken}`)).rejects.toThrow(
      'Token role claim is missing or invalid'
    );
  });
});
