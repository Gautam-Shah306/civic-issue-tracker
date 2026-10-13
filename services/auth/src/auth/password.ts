import { hash, verify, Algorithm, Version } from '@node-rs/argon2';
import { Config } from '../config.js';

// Precomputed valid argon2id hash of a dummy string for constant-time comparison on missing user
// Created with memory 19456 KiB, 2 iterations, parallelism 1
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXJhbmRvbXNhbHQ$P53+m+0b2xO9l1s+47/e1T2Xg5j7QYk7c9Xm2eZ4aB8';

export async function hashPassword(password: string, config: Config): Promise<string> {
  return hash(password, {
    algorithm: Algorithm.Argon2id,
    version: Version.V0x13,
    memoryCost: config.ARGON2_MEMORY_KIB,
    timeCost: config.ARGON2_ITERATIONS,
    parallelism: config.ARGON2_PARALLELISM
  });
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
    await verify(DUMMY_HASH, password);
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
