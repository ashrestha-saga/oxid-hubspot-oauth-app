import { env } from '../config/env';
import { ExternalApiError } from '../lib/errors';

const AUTHORIZE_URL = 'https://app.hubspot.com/oauth/authorize';
const TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const TOKEN_INFO_URL = 'https://api.hubapi.com/oauth/v1/access-tokens';

export interface HubspotTokenResponse {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry, derived from the relative `expires_in` HubSpot returns. */
  expiresAt: Date;
}

export interface HubspotTokenInfo {
  portalId: string;
  hubDomain: string | null;
  appId: number | null;
  scopes: string[];
  user: string | null;
}

export function buildAuthorizeUrl(state?: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', env.HUBSPOT_CLIENT_ID);
  url.searchParams.set('redirect_uri', env.HUBSPOT_REDIRECT_URI);
  url.searchParams.set('scope', env.HUBSPOT_SCOPES.join(' '));
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

async function postTokenRequest(form: Record<string, string>): Promise<HubspotTokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new ExternalApiError('HubSpot token request failed', {
      system: 'hubspot',
      status: response.status,
      details: text.slice(0, 500),
    });
  }

  const body = JSON.parse(text) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
  };
}

export function exchangeCodeForTokens(code: string): Promise<HubspotTokenResponse> {
  return postTokenRequest({
    grant_type: 'authorization_code',
    client_id: env.HUBSPOT_CLIENT_ID,
    client_secret: env.HUBSPOT_CLIENT_SECRET,
    redirect_uri: env.HUBSPOT_REDIRECT_URI,
    code,
  });
}

export function refreshAccessToken(refreshToken: string): Promise<HubspotTokenResponse> {
  return postTokenRequest({
    grant_type: 'refresh_token',
    client_id: env.HUBSPOT_CLIENT_ID,
    client_secret: env.HUBSPOT_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
}

/** Resolves the portal (`hub_id`) an access token belongs to. */
export async function getTokenInfo(accessToken: string): Promise<HubspotTokenInfo> {
  const response = await fetch(`${TOKEN_INFO_URL}/${encodeURIComponent(accessToken)}`);
  const text = await response.text();

  if (!response.ok) {
    throw new ExternalApiError('HubSpot token introspection failed', {
      system: 'hubspot',
      status: response.status,
      details: text.slice(0, 500),
    });
  }

  const body = JSON.parse(text) as {
    hub_id: number;
    hub_domain?: string;
    app_id?: number;
    scopes?: string[];
    user?: string;
  };

  return {
    portalId: String(body.hub_id),
    hubDomain: body.hub_domain ?? null,
    appId: body.app_id ?? null,
    scopes: body.scopes ?? [],
    user: body.user ?? null,
  };
}
