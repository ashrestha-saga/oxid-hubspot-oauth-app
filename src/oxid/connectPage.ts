export interface ConnectPageProps {
  state: 'no_session' | 'not_connected';
  portalId?: string;
  shopUrl?: string | null;
  installUrl: string;
  hubspotAppUrl?: string;
  oxidOAuthRedirectUri?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f6f8; color: #1c2330; padding: 32px;
  }
  .card {
    width: 100%; max-width: 480px; background: #fff; border-radius: 14px; padding: 32px;
    box-shadow: 0 1px 2px rgba(16,24,40,.06), 0 12px 32px rgba(16,24,40,.08);
  }
  h1 { margin: 0 0 6px; font-size: 20px; letter-spacing: -.01em; }
  p.sub { margin: 0 0 24px; color: #5b6472; }
  label { display: block; font-weight: 600; margin-bottom: 6px; font-size: 13px; margin-top: 16px; }
  label:first-of-type { margin-top: 0; }
  input {
    width: 100%; padding: 11px 12px; font-size: 15px; border: 1px solid #d3d8e0;
    border-radius: 8px; background: #fff; color: inherit;
  }
  input:focus { outline: 2px solid #2f6feb; outline-offset: 1px; border-color: #2f6feb; }
  .hint { margin: 8px 0 20px; font-size: 13px; color: #6b7480; }
  .hint code { font-size: 12px; word-break: break-all; }
  button {
    width: 100%; padding: 11px 16px; font-size: 15px; font-weight: 600; cursor: pointer;
    border: 0; border-radius: 8px; background: #ff5c35; color: #fff; margin-top: 8px;
  }
  button:hover { background: #ec4a24; }
  .back {
    margin-top: 24px; padding-top: 20px; border-top: 1px solid #e4e8ee; text-align: center;
  }
  .back a {
    color: #2f6feb; font-size: 14px; font-weight: 600; text-decoration: none;
  }
  .back a:hover { text-decoration: underline; }
  @media (prefers-color-scheme: dark) {
    body { background: #12161c; color: #e6e9ef; }
    .card { background: #1a1f27; box-shadow: none; border: 1px solid #2a313c; }
    input { background: #12161c; border-color: #333c48; }
    p.sub, .hint { color: #9aa4b2; }
    .back { border-top-color: #2a313c; }
    .back a { color: #7eb0ff; }
  }
`;

function shell(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect your OXID shop</title>
<style>${STYLES}</style>
</head>
<body><main class="card">${body}</main></body>
</html>`;
}

function backToHubSpotLink(url?: string): string {
  if (!url) return '';
  return `<p class="back"><a href="${escapeHtml(url)}">← Back to installed app in HubSpot</a></p>`;
}

export function renderConnectPage(props: ConnectPageProps): string {
  if (props.state === 'no_session') {
    return shell(`
      <h1>Session expired</h1>
      <p class="sub">Your session has expired. Start again from HubSpot to reconnect.</p>
      <a href="${escapeHtml(props.installUrl)}"><button type="button">Install / reconnect app</button></a>
    `);
  }

  const shopValue = props.shopUrl ? escapeAttr(props.shopUrl) : '';
  const redirectUri = props.oxidOAuthRedirectUri ?? '';

  return shell(`
    <h1>Connect your OXID shop</h1>
    <p class="sub">HubSpot portal ${escapeHtml(props.portalId ?? 'unknown')} is installed. Authorize your OXID shop via OAuth, then continue to field mapping.</p>
    <form method="POST" action="/oxid/oauth/start">
      <label for="shop-url">Your OXID shop URL</label>
      <input id="shop-url" name="shopUrl" placeholder="https://shop.example.com" value="${shopValue}" required autofocus />

      <label for="client-id">OAuth Client ID</label>
      <input id="client-id" name="clientId" placeholder="mwv_a1b2c3d4e5f6" required autocomplete="off" />

      <label for="client-secret">OAuth Client Secret</label>
      <input id="client-secret" name="clientSecret" type="password" placeholder="From OXID Admin → OAuth 2.0 Clients" required autocomplete="off" />

      <p class="hint">Create an OAuth client in OXID Admin (MWV API → OAuth 2.0 Clients) with redirect URI:<br /><code>${escapeHtml(redirectUri)}</code><br />Scopes: <code>profile address api</code>. PKCE must be enabled.</p>

      <button type="submit">Authorize with OXID</button>
    </form>
    ${backToHubSpotLink(props.hubspotAppUrl)}
  `);
}
