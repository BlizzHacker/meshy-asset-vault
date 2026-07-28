const DEFAULTS = {
  bridgeUrl: 'http://localhost:19950',
  resolveConcurrency: 6,
  bridgeWorkers: 4
};

const $ = (id) => document.getElementById(id);

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get(DEFAULTS);
  $('bridgeUrl').value = stored.bridgeUrl;
  $('resolveConcurrency').value = stored.resolveConcurrency;
  $('bridgeWorkers').value = stored.bridgeWorkers;

  $('save').addEventListener('click', async () => {
    await chrome.storage.local.set({
      bridgeUrl: $('bridgeUrl').value.trim().replace(/\/$/, ''),
      resolveConcurrency: clamp($('resolveConcurrency').value, 1, 16, DEFAULTS.resolveConcurrency),
      bridgeWorkers: clamp($('bridgeWorkers').value, 1, 16, DEFAULTS.bridgeWorkers)
    });
    const badge = $('saved');
    badge.classList.add('show');
    setTimeout(() => badge.classList.remove('show'), 1600);
  });
});
