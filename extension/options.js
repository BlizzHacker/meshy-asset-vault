const DEFAULTS = {
  destination: 'browser',
  downloadFolder: 'MeshyAssetVault',
  bridgeUrl: 'http://localhost:19950',
  storageDir: '',
  resolveConcurrency: 6,
  bridgeWorkers: 4
};

const $ = (id) => document.getElementById(id);

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function currentDestination() {
  return $('destBridge').checked ? 'bridge' : 'browser';
}

function syncVisibility() {
  const bridge = currentDestination() === 'bridge';
  $('bridgeOptions').hidden = !bridge;
  $('browserOptions').hidden = bridge;
}

function setBridgeState(message, tone = '') {
  const el = $('bridgeState');
  el.className = `hint ${tone}`.trim();
  el.textContent = message;
}

/** Ask the bridge where it is currently writing, so the field reflects reality. */
async function loadBridgeConfig() {
  const url = $('bridgeUrl').value.trim().replace(/\/$/, '');
  if (!url) return;
  try {
    const resp = await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.storageDir && !$('storageDir').value) $('storageDir').value = data.storageDir;
    setBridgeState(`Bridge reachable · currently writing to ${data.storageDir}`, 'ok');
  } catch {
    setBridgeState('Bridge not reachable. Start it, or use browser downloads instead.', 'err');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get(DEFAULTS);
  $('destBrowser').checked = stored.destination !== 'bridge';
  $('destBridge').checked = stored.destination === 'bridge';
  $('downloadFolder').value = stored.downloadFolder;
  $('bridgeUrl').value = stored.bridgeUrl;
  $('storageDir').value = stored.storageDir;
  $('resolveConcurrency').value = stored.resolveConcurrency;
  $('bridgeWorkers').value = stored.bridgeWorkers;
  syncVisibility();
  if (stored.destination === 'bridge') loadBridgeConfig();

  for (const radio of document.querySelectorAll('input[name="destination"]')) {
    radio.addEventListener('change', () => {
      syncVisibility();
      if (currentDestination() === 'bridge') loadBridgeConfig();
    });
  }

  $('applyStorage').addEventListener('click', async () => {
    const url = $('bridgeUrl').value.trim().replace(/\/$/, '');
    const storageDir = $('storageDir').value.trim();
    if (!storageDir) return setBridgeState('Enter a folder first.', 'err');

    setBridgeState('Applying…');
    try {
      const resp = await fetch(`${url}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storageDir }),
        signal: AbortSignal.timeout(10_000)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ?? `HTTP ${resp.status}`);
      setBridgeState(`Bridge will now write to ${data.storageDir}`, 'ok');
    } catch (err) {
      setBridgeState(`Could not update the bridge: ${err.message}`, 'err');
    }
  });

  $('save').addEventListener('click', async () => {
    await chrome.storage.local.set({
      destination: currentDestination(),
      downloadFolder: $('downloadFolder').value.trim() || DEFAULTS.downloadFolder,
      bridgeUrl: $('bridgeUrl').value.trim().replace(/\/$/, ''),
      storageDir: $('storageDir').value.trim(),
      resolveConcurrency: clamp($('resolveConcurrency').value, 1, 16, DEFAULTS.resolveConcurrency),
      bridgeWorkers: clamp($('bridgeWorkers').value, 1, 16, DEFAULTS.bridgeWorkers)
    });
    const badge = $('saved');
    badge.classList.add('show');
    setTimeout(() => badge.classList.remove('show'), 1600);
  });
});
