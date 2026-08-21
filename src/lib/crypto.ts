import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'v1';

function key(): Buffer {
  return Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64');
}

export class DecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DecryptionError';
  }
}

/**
 * Encrypts a secret for storage. Output layout is `v1:iv:tag:ciphertext`, all
 * base64, with a fresh random IV per call.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [PREFIX, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(
    ':',
  );
}

/** Reverses {@link encrypt}. Throws {@link DecryptionError} on tampering. */
export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new DecryptionError('unrecognized ciphertext format');
  }

  const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
  const iv = Buffer.from(ivPart, 'base64');
  const tag = Buffer.from(tagPart, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new DecryptionError('malformed ciphertext header');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (cause) {
    throw new DecryptionError('authentication failed - ciphertext was altered or key is wrong', {
      cause,
    });
  }
}

export function encryptOptional(plaintext: string | null | undefined): string | null {
  return plaintext == null ? null : encrypt(plaintext);
}

export function decryptOptional(payload: string | null | undefined): string | null {
  return payload == null ? null : decrypt(payload);
}

/** Length-independent constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export { randomUUID };
