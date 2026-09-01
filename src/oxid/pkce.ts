import { createHash, randomBytes } from 'node:crypto';

const VERIFIER_BYTES = 32;

/** RFC 7636 code_verifier: 43–128 unreserved characters. */
export function generateCodeVerifier(): string {
  return randomBytes(VERIFIER_BYTES).toString('base64url');
}

/** BASE64URL(SHA256(ASCII(code_verifier))) without padding. */
export function codeChallengeS256(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}
