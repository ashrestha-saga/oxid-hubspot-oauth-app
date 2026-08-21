import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hubspotSignedPayload,
  normalizeHubspotUri,
  oxidSignatureFor,
  verifyHubspotSignature,
  verifyOxidSignature,
} from '../src/lib/hmac';

const CLIENT_SECRET = 'test-client-secret';
const URI = 'https://backend.test/webhooks/hubspot';
const BODY = '[{"objectId":123,"portalId":7,"propertyName":"firstname"}]';

function hubspotSignature(
  body = BODY,
  timestamp = String(Date.now()),
  uri = URI,
  method = 'POST',
): { signature: string; timestamp: string } {
  const signature = createHmac('sha256', CLIENT_SECRET)
    .update(hubspotSignedPayload(method, uri, body, timestamp), 'utf8')
    .digest('base64');
  return { signature, timestamp };
}

describe('HubSpot v3 signature', () => {
  it('accepts a correctly signed request', () => {
    const { signature, timestamp } = hubspotSignature();

    expect(
      verifyHubspotSignature({
        method: 'POST',
        fullUri: URI,
        rawBody: BODY,
        signature,
        timestamp,
        clientSecret: CLIENT_SECRET,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const { signature, timestamp } = hubspotSignature();

    const result = verifyHubspotSignature({
      method: 'POST',
      fullUri: URI,
      rawBody: BODY.replace('123', '124'),
      signature,
      timestamp,
      clientSecret: CLIENT_SECRET,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mismatch/);
  });

  it('rejects a signature computed for a different URI', () => {
    const { signature, timestamp } = hubspotSignature(BODY, String(Date.now()), 'https://evil.test/webhooks/hubspot');

    expect(
      verifyHubspotSignature({
        method: 'POST',
        fullUri: URI,
        rawBody: BODY,
        signature,
        timestamp,
        clientSecret: CLIENT_SECRET,
      }).ok,
    ).toBe(false);
  });

  it('rejects the wrong client secret', () => {
    const { signature, timestamp } = hubspotSignature();

    expect(
      verifyHubspotSignature({
        method: 'POST',
        fullUri: URI,
        rawBody: BODY,
        signature,
        timestamp,
        clientSecret: 'other-secret',
      }).ok,
    ).toBe(false);
  });

  it('rejects a replayed request older than five minutes', () => {
    const stale = String(Date.now() - 6 * 60 * 1000);
    const { signature } = hubspotSignature(BODY, stale);

    const result = verifyHubspotSignature({
      method: 'POST',
      fullUri: URI,
      rawBody: BODY,
      signature,
      timestamp: stale,
      clientSecret: CLIENT_SECRET,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/tolerance/);
  });

  it('rejects missing headers', () => {
    expect(
      verifyHubspotSignature({
        method: 'POST',
        fullUri: URI,
        rawBody: BODY,
        signature: undefined,
        timestamp: String(Date.now()),
        clientSecret: CLIENT_SECRET,
      }).reason,
    ).toMatch(/signature/);

    expect(
      verifyHubspotSignature({
        method: 'POST',
        fullUri: URI,
        rawBody: BODY,
        signature: 'whatever',
        timestamp: undefined,
        clientSecret: CLIENT_SECRET,
      }).reason,
    ).toMatch(/timestamp/);
  });

  it('decodes the character set HubSpot decodes before signing', () => {
    expect(normalizeHubspotUri('https://backend.test/a%3Ab%2Fc')).toBe('https://backend.test/a:b/c');
    expect(normalizeHubspotUri('https://backend.test/p?q=%3A')).toBe('https://backend.test/p?q=%3A');
    expect(normalizeHubspotUri('https://backend.test/p#frag')).toBe('https://backend.test/p');
  });
});

describe('OXID webhook signature', () => {
  const SECRET = 'shop-webhook-secret';
  const PAYLOAD = '{"event":"customer.updated","customer":{"id":"c-1"}}';

  it('accepts a correctly signed request', () => {
    const timestamp = String(Date.now());

    expect(
      verifyOxidSignature({
        rawBody: PAYLOAD,
        signature: oxidSignatureFor(PAYLOAD, timestamp, SECRET),
        timestamp,
        secret: SECRET,
      }),
    ).toEqual({ ok: true });
  });

  it('produces the documented sha256=<hex> shape', () => {
    const signature = oxidSignatureFor(PAYLOAD, '1700000000000', SECRET);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('rejects a tampered body', () => {
    const timestamp = String(Date.now());
    const signature = oxidSignatureFor(PAYLOAD, timestamp, SECRET);

    expect(
      verifyOxidSignature({
        rawBody: PAYLOAD.replace('c-1', 'c-2'),
        signature,
        timestamp,
        secret: SECRET,
      }).ok,
    ).toBe(false);
  });

  it("rejects another tenant's secret", () => {
    const timestamp = String(Date.now());

    expect(
      verifyOxidSignature({
        rawBody: PAYLOAD,
        signature: oxidSignatureFor(PAYLOAD, timestamp, 'other-shop-secret'),
        timestamp,
        secret: SECRET,
      }).ok,
    ).toBe(false);
  });

  it('rejects a stale timestamp even when the signature matches it', () => {
    const stale = String(Date.now() - 10 * 60 * 1000);

    expect(
      verifyOxidSignature({
        rawBody: PAYLOAD,
        signature: oxidSignatureFor(PAYLOAD, stale, SECRET),
        timestamp: stale,
        secret: SECRET,
      }).reason,
    ).toMatch(/tolerance/);
  });

  it('rejects missing or non-numeric headers', () => {
    expect(
      verifyOxidSignature({ rawBody: PAYLOAD, signature: undefined, timestamp: '1', secret: SECRET })
        .reason,
    ).toMatch(/signature/);
    expect(
      verifyOxidSignature({ rawBody: PAYLOAD, signature: 'x', timestamp: undefined, secret: SECRET })
        .reason,
    ).toMatch(/timestamp/);
    expect(
      verifyOxidSignature({ rawBody: PAYLOAD, signature: 'x', timestamp: 'nope', secret: SECRET })
        .reason,
    ).toMatch(/not a number/);
  });
});
