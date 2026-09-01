export interface MappingPageProps {
  state: 'no_session' | 'need_pairing' | 'ready';
  portalId?: string;
  shopUrl?: string | null;
  oxidShopId?: string | null;
  mappingStatus?: string | null;
  installUrl: string;
  connectUrl?: string;
  hubspotAppUrl?: string;
  probeUrl?: string | null;
  webhookUrl?: string | null;
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
  :root { color-scheme: light dark; --accent: #ff5c35; --ink: #1c2330; --muted: #5b6472; --line: #e4e8ee; --card: #fff; --bg: #f5f6f8; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--ink); padding: 28px 16px 48px;
  }
  .wrap { width: min(920px, 100%); margin: 0 auto; }
  .card {
    background: var(--card); border-radius: 14px; padding: 28px;
    box-shadow: 0 1px 2px rgba(16,24,40,.06), 0 12px 32px rgba(16,24,40,.08);
  }
  h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: -.02em; }
  p.sub { margin: 0 0 20px; color: var(--muted); }
  .steps { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 24px; }
  .step-pill {
    padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 600;
    background: #eef1f5; color: var(--muted);
  }
  .step-pill.active { background: #ffe8e1; color: #b33a1a; }
  .step-pill.done { background: #e7f6ec; color: #17603a; }
  .panel { display: none; }
  .panel.active { display: block; }
  label { display: block; font-weight: 600; margin: 0 0 6px; font-size: 13px; }
  textarea, select, input {
    width: 100%; padding: 10px 12px; font-size: 14px; border: 1px solid #d3d8e0;
    border-radius: 8px; background: #fff; color: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  textarea { min-height: 180px; resize: vertical; }
  .hint { margin: 8px 0 16px; font-size: 13px; color: var(--muted); }
  .row-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
  button {
    padding: 11px 16px; font-size: 14px; font-weight: 600; cursor: pointer;
    border: 0; border-radius: 8px; background: var(--accent); color: #fff;
  }
  button:hover { filter: brightness(.96); }
  button.secondary { background: transparent; color: #2f6feb; border: 1px solid #d3d8e0; }
  button.secondary:hover { background: #f0f4ff; }
  button:disabled { opacity: .55; cursor: progress; }
  .code {
    padding: 12px; border-radius: 8px; background: #0f141b; color: #d7e0ea;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; overflow: auto; word-break: break-all;
  }
  .map-grid { display: grid; gap: 12px; }
  .map-row {
    display: grid; grid-template-columns: 140px 1fr 1fr; gap: 10px; align-items: end;
    padding: 12px; border: 1px solid var(--line); border-radius: 10px;
  }
  .map-row .canon { font-weight: 700; font-size: 13px; padding-bottom: 10px; }
  .preview {
    margin-top: 16px; padding: 14px; border-radius: 10px; background: #f7f8fa; border: 1px solid var(--line);
  }
  .preview pre { margin: 8px 0 0; white-space: pre-wrap; font-size: 12px; }
  .error { margin-top: 14px; padding: 10px 12px; border-radius: 8px; background: #fdecea; color: #8a1c13; font-size: 13px; display: none; }
  .ok { margin-top: 14px; padding: 10px 12px; border-radius: 8px; background: #e7f6ec; color: #17603a; font-size: 13px; display: none; }
  .keys { max-height: 220px; overflow: auto; margin: 12px 0; border: 1px solid var(--line); border-radius: 8px; }
  .keys table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .keys th, .keys td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  .keys th { background: #f7f8fa; position: sticky; top: 0; }
  .back { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--line); }
  .back a { color: #2f6feb; font-weight: 600; text-decoration: none; }
  @media (max-width: 720px) {
    .map-row { grid-template-columns: 1fr; }
  }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e6e9ef; --muted: #9aa4b2; --line: #2a313c; --card: #1a1f27; --bg: #12161c; }
    textarea, select, input { background: #12161c; border-color: #333c48; }
    .preview, .keys th { background: #12161c; }
    button.secondary { color: #7eb0ff; border-color: #333c48; }
    button.secondary:hover { background: #1e2633; }
  }
`;

const SCRIPT = `
  const state = { step: 1, map: null, keys: [], properties: [], sample: null };
  const errorBox = document.getElementById('error');
  const okBox = document.getElementById('ok');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.style.display = 'block';
    okBox.style.display = 'none';
  }
  function showOk(message) {
    okBox.textContent = message;
    okBox.style.display = 'block';
    errorBox.style.display = 'none';
  }
  function clearMsgs() {
    errorBox.style.display = 'none';
    okBox.style.display = 'none';
  }

  function setStep(n) {
    state.step = n;
    document.querySelectorAll('.panel').forEach((el) => el.classList.toggle('active', el.dataset.step === String(n)));
    document.querySelectorAll('.step-pill').forEach((el) => {
      const step = Number(el.dataset.step);
      el.classList.toggle('active', step === n);
      el.classList.toggle('done', step < n);
    });
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || 'Request failed');
    return data;
  }

  function renderKeys(keys) {
    const body = document.getElementById('keys-body');
    if (!keys.length) {
      body.innerHTML = '<tr><td colspan="2">No keys yet — send a probe or paste a sample.</td></tr>';
      return;
    }
    body.innerHTML = keys.map((k) =>
      '<tr><td><code>' + escape(k.path) + '</code></td><td>' + escape(k.sample ?? '') + '</td></tr>'
    ).join('');
  }

  function escape(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function propertyOptions(selected) {
    const names = new Set(state.properties.map((p) => p.name));
    if (selected && !names.has(selected)) {
      state.properties = [{ name: selected, label: selected + ' (current)', type: 'string' }, ...state.properties];
    }
    return state.properties.map((p) =>
      '<option value="' + escape(p.name) + '"' + (p.name === selected ? ' selected' : '') + '>' +
      escape(p.label + ' (' + p.name + ')') + '</option>'
    ).join('');
  }

  function oxidOptions(selected) {
    const opts = ['<option value="">— unmapped —</option>'];
    const seen = new Set();
    for (const key of state.keys) {
      seen.add(key.path);
      opts.push(
        '<option value="' + escape(key.path) + '"' + (key.path === selected ? ' selected' : '') + '>' +
        escape(key.path + (key.sample ? ' = ' + key.sample : '')) + '</option>'
      );
    }
    if (selected && !seen.has(selected)) {
      opts.push('<option value="' + escape(selected) + '" selected>' + escape(selected) + ' (saved)</option>');
    }
    return opts.join('');
  }

  function renderMapEditor() {
    const root = document.getElementById('map-grid');
    if (!state.map) return;
    root.innerHTML = state.map.fields.map((field, index) =>
      '<div class="map-row" data-index="' + index + '">' +
        '<div class="canon">' + escape(field.canonical) + (field.canonical === 'email' ? ' *' : '') + '</div>' +
        '<div><label>OXID field</label><select class="oxid-path">' + oxidOptions(field.oxidPath) + '</select></div>' +
        '<div><label>HubSpot property</label><select class="hs-prop">' + propertyOptions(field.hubspotProperty) + '</select></div>' +
      '</div>'
    ).join('');
  }

  function readMapFromEditor() {
    const fields = [...document.querySelectorAll('.map-row')].map((row, index) => {
      const base = state.map.fields[index];
      const oxidPath = row.querySelector('.oxid-path').value || null;
      const hubspotProperty = row.querySelector('.hs-prop').value;
      return { ...base, oxidPath, hubspotProperty };
    });
    return { ...state.map, fields };
  }

  async function refreshState() {
    const data = await api('/oxid/mapping/state');
    state.map = data.map;
    state.keys = data.keys || [];
    state.sample = data.sample;
    renderKeys(state.keys);
    if (data.hasSample) {
      document.getElementById('sample-status').textContent = 'Sample captured (' + state.keys.length + ' keys).';
    }
    return data;
  }

  document.getElementById('use-defaults')?.addEventListener('click', async () => {
    clearMsgs();
    try {
      const data = await api('/oxid/mapping/use-defaults', { method: 'POST', body: '{}' });
      state.map = data.map;
      showOk('Standard OXID → HubSpot map applied. You can customize anytime.');
      setStep(3);
      renderMapEditor();
    } catch (error) {
      showError(error.message);
    }
  });

  document.getElementById('customize')?.addEventListener('click', async () => {
    clearMsgs();
    setStep(2);
    try {
      await refreshState();
    } catch (error) {
      showError(error.message);
    }
  });

  document.getElementById('paste-sample')?.addEventListener('click', async () => {
    clearMsgs();
    try {
      const raw = document.getElementById('sample-json').value.trim();
      if (!raw) throw new Error('Paste a JSON sample first');
      const payload = JSON.parse(raw);
      const data = await api('/oxid/mapping/sample', {
        method: 'POST',
        body: JSON.stringify({ payload }),
      });
      state.keys = data.keys;
      state.map = data.suggestedMap;
      renderKeys(state.keys);
      document.getElementById('sample-status').textContent = 'Sample captured (' + state.keys.length + ' keys).';
      showOk('Keys discovered. Continue to map them.');
    } catch (error) {
      showError(error.message);
    }
  });

  document.getElementById('poll-sample')?.addEventListener('click', async () => {
    clearMsgs();
    try {
      const data = await refreshState();
      if (!data.hasSample) {
        showError('No probe sample yet. POST to the probe URL, then click again.');
        return;
      }
      if (data.keys?.length) {
        const suggested = await api('/oxid/mapping/sample', {
          method: 'POST',
          body: JSON.stringify({ payload: data.sample }),
        });
        state.keys = suggested.keys;
        state.map = suggested.suggestedMap;
        renderKeys(state.keys);
      }
      showOk('Sample loaded from probe.');
    } catch (error) {
      showError(error.message);
    }
  });

  document.getElementById('to-map')?.addEventListener('click', async () => {
    clearMsgs();
    try {
      if (!state.keys.length) {
        const data = await refreshState();
        if (!data.keys.length) throw new Error('Capture a sample first');
      }
      const props = await api('/oxid/mapping/hubspot-properties');
      state.properties = props.properties || [];
      if (!state.map) state.map = (await refreshState()).map;
      renderMapEditor();
      setStep(3);
    } catch (error) {
      showError(error.message);
    }
  });

  document.getElementById('preview')?.addEventListener('click', async () => {
    clearMsgs();
    try {
      const map = readMapFromEditor();
      const data = await api('/oxid/mapping/preview', {
        method: 'POST',
        body: JSON.stringify({ map }),
      });
      document.getElementById('preview-box').style.display = 'block';
      document.getElementById('preview-pre').textContent = JSON.stringify(data, null, 2);
    } catch (error) {
      showError(error.message);
    }
  });

  document.getElementById('save-map')?.addEventListener('click', async () => {
    clearMsgs();
    try {
      const map = readMapFromEditor();
      await api('/oxid/mapping', {
        method: 'PUT',
        body: JSON.stringify({ map, mappingStatus: 'custom' }),
      });
      showOk('Field mapping saved for this HubSpot ↔ OXID pair.');
      setStep(4);
    } catch (error) {
      showError(error.message);
    }
  });

  // Initial load
  if (document.body.dataset.ready === '1') {
    refreshState().catch(() => {});
  }
`;

function shell(body: string, ready = false): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Map OXID fields to HubSpot</title>
<style>${STYLES}</style>
</head>
<body data-ready="${ready ? '1' : '0'}"><div class="wrap"><main class="card">${body}</main></div>
<script>${SCRIPT}</script></body>
</html>`;
}

function backLinks(props: MappingPageProps): string {
  const bits: string[] = [];
  if (props.connectUrl) {
    bits.push(`<a href="${escapeHtml(props.connectUrl)}">← Shop connection</a>`);
  }
  if (props.hubspotAppUrl) {
    bits.push(`<a href="${escapeHtml(props.hubspotAppUrl)}">Back to HubSpot</a>`);
  }
  if (!bits.length) return '';
  return `<p class="back">${bits.join(' · ')}</p>`;
}

export function renderMappingPage(props: MappingPageProps): string {
  if (props.state === 'no_session') {
    return shell(`
      <h1>Session expired</h1>
      <p class="sub">Start again from HubSpot so we know which portal this mapping belongs to.</p>
      <a href="${escapeHtml(props.installUrl)}"><button type="button">Install / reconnect</button></a>
    `);
  }

  if (props.state === 'need_pairing') {
    return shell(`
      <h1>Connect your OXID shop first</h1>
      <p class="sub">Field mapping is per HubSpot ↔ OXID pair. Authorize your shop via OAuth, then come back here.</p>
      <a href="${escapeHtml(props.connectUrl ?? '/oxid/connect')}"><button type="button">Connect OXID shop</button></a>
      ${backLinks(props)}
    `);
  }

  return shell(
    `
    <h1>Map OXID fields → HubSpot</h1>
    <p class="sub">Portal ${escapeHtml(props.portalId ?? '')} · Shop ${escapeHtml(props.shopUrl ?? props.oxidShopId ?? '')}. Current map: <strong>${escapeHtml(props.mappingStatus ?? 'default')}</strong>.</p>

    <div class="steps">
      <span class="step-pill active" data-step="1">1. Choose path</span>
      <span class="step-pill" data-step="2">2. Capture sample</span>
      <span class="step-pill" data-step="3">3. Map fields</span>
      <span class="step-pill" data-step="4">4. Done</span>
    </div>

    <section class="panel active" data-step="1">
      <p class="hint">Most OXID shops work with the standard map (oxusername → email, oxfname → firstname, …). Customize only if this client uses different property names.</p>
      <div class="row-actions">
        <button type="button" id="use-defaults">Use standard map</button>
        <button type="button" class="secondary" id="customize">Customize with a test payload</button>
      </div>
    </section>

    <section class="panel" data-step="2">
      <label>Probe URL (HMAC-signed POST from OXID / Postman)</label>
      <div class="code">${escapeHtml(props.probeUrl ?? '')}</div>
      <p class="hint">Same signing headers as the live webhook (<code>X-Oxid-Timestamp</code>, <code>X-Oxid-Signature</code>). The probe stores keys only — it does not sync to HubSpot.</p>
      <p class="hint" id="sample-status">Waiting for a sample…</p>
      <div class="row-actions">
        <button type="button" class="secondary" id="poll-sample">I sent the probe — refresh</button>
      </div>
      <label style="margin-top:18px">Or paste a sample JSON body</label>
      <textarea id="sample-json" placeholder='{"users":{"oxusername":"a@b.de","oxfname":"Ada",...}}'></textarea>
      <div class="row-actions">
        <button type="button" id="paste-sample">Discover keys from paste</button>
        <button type="button" class="secondary" id="to-map">Continue to mapping</button>
      </div>
      <div class="keys">
        <table>
          <thead><tr><th>OXID path</th><th>Sample value</th></tr></thead>
          <tbody id="keys-body"><tr><td colspan="2">No keys yet</td></tr></tbody>
        </table>
      </div>
    </section>

    <section class="panel" data-step="3">
      <p class="hint">Pick which OXID path feeds each HubSpot contact property. Email is required.</p>
      <div class="map-grid" id="map-grid"></div>
      <div class="preview" id="preview-box" style="display:none">
        <strong>Dry-run preview</strong>
        <pre id="preview-pre"></pre>
      </div>
      <div class="row-actions">
        <button type="button" class="secondary" id="preview">Preview HubSpot write</button>
        <button type="button" id="save-map">Save mapping</button>
      </div>
    </section>

    <section class="panel" data-step="4">
      <h1 style="font-size:18px">Mapping saved</h1>
      <p class="sub">New OXID webhooks for this pair will use your map. Live webhook:</p>
      <div class="code">${escapeHtml(props.webhookUrl ?? '')}</div>
      ${backLinks(props)}
    </section>

    <div class="error" id="error"></div>
    <div class="ok" id="ok"></div>
    ${backLinks(props)}
  `,
    true,
  );
}
