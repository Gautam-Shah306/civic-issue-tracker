import { randomBytes, randomUUID, createHash, createPublicKey, KeyObject } from 'node:crypto';
import {
  importPKCS8,
  importSPKI,
  SignJWT,
  jwtVerify,
  exportJWK,
  calculateJwkThumbprint,
  JWK
} from 'jose';
import { Config } from '../config.js';

type KeyType = import('node:crypto').webcrypto.CryptoKey | KeyObject | Uint8Array;

export interface TokenService {
  issueAccessToken(user: {
    id: string;
    role: string;
  }): Promise<{ token: string; expiresIn: number }>;
  generateRefreshToken(): { rawToken: string; tokenHash: string; expiresInSeconds: number };
  hashRefreshToken(token: string): string;
  verifyAccessToken(token: string): Promise<{ userId: string; role: string }>;
  getPublicJwks(): Promise<{ keys: JWK[] }>;
}

export async function createTokenService(config: Config): Promise<TokenService> {
  // Decode private key PEM from base64
  const privPem = Buffer.from(config.JWT_PRIVATE_KEY_B64, 'base64').toString('utf8');
  const privateKey = (await importPKCS8(privPem, 'EdDSA')) as KeyType;

  // Derive public key SPKI PEM from private key
  const pubKeyObj = createPublicKey(privPem);
  const pubPem = pubKeyObj.export({ type: 'spki', format: 'pem' }) as string;
  const publicKey = (await importSPKI(pubPem, 'EdDSA')) as KeyType;

  // Generate public JWK and calculate key ID thumbprint
  const baseJwk = await exportJWK(publicKey);
  const keyId = await calculateJwkThumbprint(baseJwk);
  const publicJwk: JWK = {
    ...baseJwk,
    kid: keyId,
    alg: 'EdDSA',
    use: 'sig'
  };

  const jwks = {
    keys: [publicJwk]
  };

  return {
    async issueAccessToken(user: { id: string; role: string }) {
      const token = await new SignJWT({ role: user.role })
        .setProtectedHeader({ alg: 'EdDSA', kid: keyId })
        .setSubject(user.id)
        .setIssuer(config.JWT_ISSUER)
        .setAudience(config.JWT_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${config.ACCESS_TTL_SECONDS}s`)
        .setJti(randomUUID())
        .sign(privateKey);

      return {
        token,
        expiresIn: config.ACCESS_TTL_SECONDS
      };
    },

    generateRefreshToken() {
      // 32 cryptographically secure random bytes
      const rawToken = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      const expiresInSeconds = config.REFRESH_TTL_DAYS * 86400;
      return {
        rawToken,
        tokenHash,
        expiresInSeconds
      };
    },

    hashRefreshToken(rawToken: string): string {
      return createHash('sha256').update(rawToken).digest('hex');
    },

    async verifyAccessToken(token: string) {
      const verified = await jwtVerify(token, publicKey, {
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        algorithms: ['EdDSA']
      });

      const userId = verified.payload.sub;
      const role = verified.payload.role;

      if (!userId || typeof role !== 'string') {
        throw new Error('Missing subject or role in token payload');
      }

      return {
        userId,
        role
      };
    },

    async getPublicJwks() {
      return jwks;
    }
  };
}
