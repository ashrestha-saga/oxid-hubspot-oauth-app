import { env } from '../config/env';
import { ExternalApiError } from '../lib/errors';
import { codeChallengeS256 } from './pkce';

export interface OxidTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string | null;
}

export interface OxidProfile {
  sub: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  custnr: string | null;
}

function authorizeUrl(shopBaseUrl: string): string {
  return `${shopBaseUrl.replace(/\/+$/, '')}/index.php?cl=oauthauthorize`;
}

function tokenUrl(shopBaseUrl: string): string {
  return `${shopBaseUrl.replace(/\/+$/, '')}/index.php?cl=oauthtoken&fnc=token`;
}

function meUrl(shopBaseUrl: string): string {
  return `${shopBaseUrl.replace(/\/+$/, '')}/index.php?cl=oauthme&fnc=getProfile`;
}

export interface BuildOxidAuthorizeParams {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeVerifier: string;
}

export function buildOxidAuthorizeUrl(
  shopBaseUrl: string,
  params: BuildOxidAuthorizeParams,
): string {
  const url = new URL(authorizeUrl(shopBaseUrl));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scopes.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', codeChallengeS256(params.codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function postTokenRequest(
  shopBaseUrl: string,
  form: Record<string, string>,
): Promise<OxidTokenResponse> {
  const response = await fetch(tokenUrl(shopBaseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new ExternalApiError('OXID token request failed', {
      system: 'oxid',
      status: response.status,
      details: text.slice(0, 500),
    });
  }

  const body = JSON.parse(text) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
    scope: body.scope ?? null,
  };
}

export function exchangeOxidCodeForTokens(
  shopBaseUrl: string,
  input: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    codeVerifier: string;
  },
): Promise<OxidTokenResponse> {
  return postTokenRequest(shopBaseUrl, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier,
  });
}

export function refreshOxidAccessToken(
  shopBaseUrl: string,
  input: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<OxidTokenResponse> {
  return postTokenRequest(shopBaseUrl, {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
}

export async function getOxidProfile(
  shopBaseUrl: string,
  accessToken: string,
): Promise<OxidProfile> {
  const response = await fetch(meUrl(shopBaseUrl), {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new ExternalApiError('OXID profile request failed', {
      system: 'oxid',
      status: response.status,
      details: text.slice(0, 500),
    });
  }

  const body = JSON.parse(text) as {
    status?: string;
    data?: {
      sub?: string;
      email?: string;
      first_name?: string;
      last_name?: string;
      custnr?: string;
    };
  };

  const data = body.data ?? {};
  return {
    sub: data.sub ?? '',
    email: data.email ?? null,
    firstName: data.first_name ?? null,
    lastName: data.last_name ?? null,
    custnr: data.custnr ?? null,
  };
}

export function oxidOAuthRedirectUri(): string {
  return env.OXID_OAUTH_REDIRECT_URI;
}

export function oxidOAuthScopes(): string[] {
  return env.OXID_OAUTH_SCOPES;
}
