import { randomBytes } from 'node:crypto';
import { hash, verify, Algorithm, Version } from '@node-rs/argon2';
import { Config } from '../config.js';

let dummyHash: string | null = null;

export async function hashPassword(password: string, config: Config): Promise<string> {
  return hash(password, {
    algorithm: Algorithm.Argon2id,
    version: Version.V0x13,
    memoryCost: config.ARGON2_MEMORY_KIB,
    timeCost: config.ARGON2_ITERATIONS,
    parallelism: config.ARGON2_PARALLELISM
  });
}

export async function initDummyHash(config: Config): Promise<string> {
  const randomSecret = randomBytes(32).toString('hex');
  dummyHash = await hashPassword(randomSecret, config);
  return dummyHash;
}

export function getDummyHash(): string | null {
  return dummyHash;
}

export async function verifyPassword(hashString: string, password: string): Promise<boolean> {
  try {
    return await verify(hashString, password);
  } catch {
    return false;
  }
}

export async function performDummyVerification(password: string): Promise<void> {
  try {
    if (!dummyHash) {
      const randomSecret = randomBytes(32).toString('hex');
      dummyHash = await hash(randomSecret, {
        algorithm: Algorithm.Argon2id,
        version: Version.V0x13,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1
      });
    }
    await verify(dummyHash, password);
  } catch {
    // Ignore dummy verification failure
  }
}

export function validatePasswordPolicy(password: string, email?: string): string | null {
  if (password.length < 10) {
    return 'Password must be at least 10 characters long';
  }
  if (password.length > 128) {
    return 'Password cannot exceed 128 characters';
  }
  if (email && password.toLowerCase() === email.trim().toLowerCase()) {
    return 'Password cannot be equal to your email address';
  }
  return null;
}
