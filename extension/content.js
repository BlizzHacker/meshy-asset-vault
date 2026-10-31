/**
 * Session token hint for the service worker.
 *
 * Meshy currently keeps its Supabase session in a chunkable auth-token value.
 * Read only that key from page storage/cookies, then retry briefly because the
 * web app can hydrate its session after document_idle. The bearer remains in
 * memory in the extension worker and is never written to extension storage.
 */
(() => {
  'use strict';

  try {
    document.documentElement.dataset.meshyAssetVault =
      chrome.runtime.getManifest().version;
  } catch {
    /* not fatal */
  }

  const AUTH_KEY = /^sb-.*-auth-token(?:\.(\d+))?$/;
  let lastSent = '';

  function decodeValue(raw) {
    let value = String(raw ?? '');
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep the original cookie value */
    }

    if (value.startsWith('base64-')) {
      let encoded = value.slice(7).replace(/-/g, '+').replace(/_/g, '/');
      encoded += '='.repeat((4 - (encoded.length % 4)) % 4);
      try {
        const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
        value = new TextDecoder().decode(bytes);
      } catch {
        return '';
      }
    }
    return value;
  }

  function tokenFromValue(raw) {
    try {
      let value = decodeValue(raw);
      let parsed = JSON.parse(value);
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      const session =
        parsed?.currentSession ??
        parsed?.session ??
        parsed?.data?.session ??
        parsed;
      const token = session?.access_token ?? session?.accessToken;
      return typeof token === 'string' ? token : '';
    } catch {
      return '';
    }
  }

  function readAuthToken() {
    const groups = new Map();
    const add = (key, value) => {
      const match = key.match(AUTH_KEY);
      if (!match) return;
      const base = key.replace(/\.\d+$/, '');
      const index = match[1] === undefined ? -1 : Number(match[1]);
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push([index, value]);
    };

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) add(key, localStorage.getItem(key));
      }
    } catch {
      /* localStorage can be unavailable in a restricted page */
    }

    try {
      for (const cookie of document.cookie.split(';')) {
        const separator = cookie.indexOf('=');
        if (separator < 0) continue;
        add(cookie.slice(0, separator).trim(), cookie.slice(separator + 1).trim());
      }
    } catch {
      /* HttpOnly cookies are intentionally inaccessible */
    }

    for (const chunks of groups.values()) {
      const raw = chunks
        .sort((a, b) => a[0] - b[0])
        .map(([, value]) => value ?? '')
        .join('');
      const token = tokenFromValue(raw);
      if (token) return token;
    }
    return '';
  }

  function sendHint() {
    const token = readAuthToken();
    if (!token || token === lastSent) return;
    lastSent = token;
    chrome.runtime.sendMessage({ type: 'TOKEN_HINT', token }).catch(() => {});
  }

  sendHint();
  window.addEventListener('storage', sendHint);
  document.addEventListener('visibilitychange', sendHint);

  let attempts = 0;
  const timer = setInterval(() => {
    sendHint();
    if (lastSent || ++attempts >= 30) clearInterval(timer);
  }, 1000);
})();
