import { createHmac } from 'node:crypto';
import { safeEqual } from './crypto';

export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export interface VerificationResult {
  ok: boolean;
  reason?: string;
}

/**
 * HubSpot URL-decodes this specific set of characters in the URI before signing.
 * Reproducing it exactly matters: a single character difference in the URI makes
 * every signature mismatch.
 */
const HUBSPOT_DECODED_CHARS: Record<string, string> = {
  '%3A': ':',
  '%2F': '/',
  '%3F': '?',
  '%40': '@',
  '%21': '!',
  '%24': '$',
  '%27': "'",
  '%28': '(',
  '%29': ')',
  '%2A': '*',
  '%2C': ',',
  '%3B': ';',
};

export function normalizeHubspotUri(uri: string): string {
  const withoutFragment = uri.split('#')[0] ?? uri;
  const queryStart = withoutFragment.indexOf('?');
  const path = queryStart === -1 ? withoutFragment : withoutFragment.slice(0, queryStart);
  const query = queryStart === -1 ? '' : withoutFragment.slice(queryStart);

  const decodedPath = path.replace(
    /%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/gi,
    (match) => HUBSPOT_DECODED_CHARS[match.toUpperCase()] ?? match,
  );

  return `${decodedPath}${query}`;
}

export function hubspotSignedPayload(
  method: string,
  fullUri: string,
  rawBody: string,
  timestamp: string,
): string {
  return `${method}${normalizeHubspotUri(fullUri)}${rawBody}${timestamp}`;
}

/**
 * Verifies `X-HubSpot-Signature-v3`: base64 HMAC-SHA256, keyed with the app's
 * client secret, over method + URI + raw body + timestamp. The timestamp is part
 * of the signed string, which is what gives replay protection.
 */
export function verifyHubspotSignature(input: {
  method: string;
  fullUri: string;
  rawBody: string;
  signature: string | undefined;
  timestamp: string | undefined;
  clientSecret: string;
  now?: number;
}): VerificationResult {
  if (!input.signature) return { ok: false, reason: 'missing x-hubspot-signature-v3 header' };
  if (!input.timestamp) return { ok: false, reason: 'missing x-hubspot-request-timestamp header' };

  const timestampMs = Number(input.timestamp);
  if (!Number.isFinite(timestampMs)) return { ok: false, reason: 'timestamp is not a number' };

  const now = input.now ?? Date.now();
  if (Math.abs(now - timestampMs) > SIGNATURE_TOLERANCE_MS) {
    return { ok: false, reason: 'timestamp outside the 5 minute tolerance' };
  }

  const expected = createHmac('sha256', input.clientSecret)
    .update(
      hubspotSignedPayload(input.method, input.fullUri, input.rawBody, input.timestamp),
      'utf8',
    )
    .digest('base64');

  return safeEqual(input.signature, expected)
    ? { ok: true }
    : { ok: false, reason: 'signature mismatch' };
}

export function oxidSignatureFor(rawBody: string, timestamp: string, secret: string): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  return `sha256=${digest}`;
}

/**
 * Verifies `X-Oxid-Signature` as specified in docs/oxid-module-contract.md:
 * hex HMAC-SHA256 over `timestamp + "." + rawBody`, keyed with the shop's
 * per-tenant webhook secret.
 */
export function verifyOxidSignature(input: {
  rawBody: string;
  signature: string | undefined;
  timestamp: string | undefined;
  secret: string;
  now?: number;
}): VerificationResult {
  if (!input.signature) return { ok: false, reason: 'missing x-oxid-signature header' };
  if (!input.timestamp) return { ok: false, reason: 'missing x-oxid-timestamp header' };

  const timestampMs = Number(input.timestamp);
  if (!Number.isFinite(timestampMs)) return { ok: false, reason: 'timestamp is not a number' };

  const now = input.now ?? Date.now();
  if (Math.abs(now - timestampMs) > SIGNATURE_TOLERANCE_MS) {
    return { ok: false, reason: 'timestamp outside the 5 minute tolerance' };
  }

  const expected = oxidSignatureFor(input.rawBody, input.timestamp, input.secret);
  return safeEqual(input.signature, expected)
    ? { ok: true }
    : { ok: false, reason: 'signature mismatch' };
}
