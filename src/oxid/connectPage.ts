export interface ConnectPageProps {
  state: 'no_session' | 'not_connected' | 'connected';
  portalId?: string;
  shopUrl?: string | null;
  installUrl: string;
  hubspotAppUrl?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  label { display: block; font-weight: 600; margin-bottom: 6px; font-size: 13px; }
  input {
    width: 100%; padding: 11px 12px; font-size: 15px; border: 1px solid #d3d8e0;
    border-radius: 8px; background: #fff; color: inherit;
  }
  input:focus { outline: 2px solid #2f6feb; outline-offset: 1px; border-color: #2f6feb; }
  .hint { margin: 8px 0 20px; font-size: 13px; color: #6b7480; }
  button {
    width: 100%; padding: 11px 16px; font-size: 15px; font-weight: 600; cursor: pointer;
    border: 0; border-radius: 8px; background: #ff5c35; color: #fff;
  }
  button:hover { background: #ec4a24; }
  button:disabled { background: #c7ccd4; cursor: progress; }
  .badge {
    display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px;
    font-size: 13px; font-weight: 600; background: #e7f6ec; color: #17603a;
  }
  .badge::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #17603a; }
  .row { margin-top: 20px; font-size: 13px; color: #5b6472; word-break: break-all; }
  .row dt { font-weight: 600; color: #1c2330; }
  .row dd { margin: 2px 0 12px; }
  .error { margin-top: 16px; padding: 10px 12px; border-radius: 8px; background: #fdecea; color: #8a1c13; font-size: 13px; display: none; }
  .back {
    margin-top: 24px; padding-top: 20px; border-top: 1px solid #e4e8ee; text-align: center;
  }
  .back a {
    color: #2f6feb; font-size: 14px; font-weight: 600; text-decoration: none;
  }
  .back a:hover { text-decoration: underline; }
  button.secondary {
    margin-top: 12px; background: transparent; color: #2f6feb; border: 1px solid #d3d8e0;
  }
  button.secondary:hover { background: #f0f4ff; }
  @media (prefers-color-scheme: dark) {
    body { background: #12161c; color: #e6e9ef; }
    .card { background: #1a1f27; box-shadow: none; border: 1px solid #2a313c; }
    input { background: #12161c; border-color: #333c48; }
    p.sub, .hint, .row { color: #9aa4b2; }
    .row dt { color: #e6e9ef; }
    .back { border-top-color: #2a313c; }
    .back a { color: #7eb0ff; }
    button.secondary { color: #7eb0ff; border-color: #333c48; }
    button.secondary:hover { background: #1e2633; }
  }
`;

const SCRIPT = `
  const form = document.getElementById('connect-form');
  const button = document.getElementById('connect-button');
  const errorBox = document.getElementById('error');
  let poll;

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.style.display = 'none';
    button.disabled = true;
    button.textContent = 'Opening your OXID admin...';

    try {
      const response = await fetch('/oxid/pair/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ shopUrl: document.getElementById('shop-url').value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Could not start pairing');

      window.open(data.redirectUrl, '_blank', 'noopener');
      button.textContent = 'Waiting for confirmation in OXID...';

      poll = setInterval(async () => {
        const status = await fetch('/oxid/status', { credentials: 'same-origin' })
          .then((r) => r.json())
          .catch(() => null);
        if (status?.connected) {
          clearInterval(poll);
          window.location.reload();
        }
      }, 3000);
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.style.display = 'block';
      button.disabled = false;
      button.textContent = 'Connect OXID shop';
    }
  });
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
<body><main class="card">${body}</main><script>${SCRIPT}</script></body>
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
      <p class="sub">Your pairing session has expired. Start again from HubSpot to reconnect.</p>
      <a href="${escapeHtml(props.installUrl)}"><button type="button">Install / reconnect app</button></a>
    `);
  }

  if (props.state === 'connected') {
    return shell(`
      <h1>OXID shop connected</h1>
      <p class="sub">Contacts now sync in both directions.</p>
      <span class="badge">Active</span>
      <dl class="row">
        <dt>HubSpot portal</dt><dd>${escapeHtml(props.portalId ?? 'unknown')}</dd>
        <dt>OXID shop</dt><dd>${escapeHtml(props.shopUrl ?? 'unknown')}</dd>
      </dl>
      <form id="connect-form">
        <label for="shop-url">Pair a different shop</label>
        <input id="shop-url" name="shopUrl" placeholder="https://shop.example.com" required />
        <p class="hint">Re-pairing replaces the current connection.</p>
        <button id="connect-button" type="submit">Connect OXID shop</button>
      </form>
      <div class="error" id="error"></div>
      ${backToHubSpotLink(props.hubspotAppUrl)}
    `);
  }

  return shell(`
    <h1>Connect your OXID shop</h1>
    <p class="sub">HubSpot portal ${escapeHtml(props.portalId ?? 'unknown')} is installed. One step left.</p>
    <form id="connect-form">
      <label for="shop-url">Your OXID shop URL</label>
      <input id="shop-url" name="shopUrl" placeholder="https://shop.example.com" required autofocus />
      <p class="hint">We open your shop admin so you can confirm the connection there. You stay logged in to OXID - no credentials are shared with us.</p>
      <button id="connect-button" type="submit">Connect OXID shop</button>
    </form>
    <div class="error" id="error"></div>
    ${backToHubSpotLink(props.hubspotAppUrl)}
  `);
}
