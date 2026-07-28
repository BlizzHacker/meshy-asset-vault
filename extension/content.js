/**
 * Fallback token hint.
 *
 * The service worker captures the session token from request headers, which
 * covers virtually every case. This content script exists only as a safety net
 * for builds where the webRequest permission is unavailable: it reads a Supabase
 * session from localStorage if the app happens to keep one there.
 *
 * It scrapes nothing else and sends nothing but the token to our own worker.
 */

(() => {
  'use strict';

  function readStoredSession() {
    const chunks = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const match = key?.match(/^(sb-.*-auth-token)(?:\.(\d+))?$/);
      if (match) {
        (chunks[match[1]] ??= []).push([match[2] === undefined ? -1 : Number(match[2]), key]);
      }
    }

    for (const parts of Object.values(chunks)) {
      const raw = parts
        .sort((a, b) => a[0] - b[0])
        .map(([, key]) => localStorage.getItem(key))
        .join('');
      try {
        const decoded = raw.startsWith('base64-') ? atob(raw.slice(7)) : raw;
        const parsed = JSON.parse(decoded);
        const session = parsed.currentSession ?? parsed.session ?? parsed;
        if (session?.access_token) return `Bearer ${session.access_token}`;
      } catch {
        /* not a session we understand */
      }
    }
    return null;
  }

  const token = readStoredSession();
  if (token) {
    chrome.runtime.sendMessage({ type: 'TOKEN_HINT', token }).catch(() => {});
  }
})();
