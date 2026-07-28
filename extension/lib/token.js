/**
 * Session token capture.
 *
 * Meshy's web app authenticates with a short-lived (~15 min) Bearer JWT that it
 * rotates automatically while a tab is open. Rather than asking the user to dig
 * one out of DevTools, we observe the Authorization header the app already sends
 * on its own API calls and keep the freshest one in memory.
 *
 * The token is held in memory only. It is never written to sync storage, never
 * sent anywhere except the user's own local bridge, and is dropped on sign-out.
 */

const MESHY_TAB_URL = 'https://www.meshy.ai/';
/** Refresh a little before expiry so a rotation is always in flight in time. */
const REFRESH_MARGIN_MS = 90_000;

let current = null; // { value, expiresAt }
const listeners = new Set();

function decodeExpiry(jwt) {
  try {
    const payload = jwt.split('.')[1];
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
    const json = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function setToken(rawValue) {
  if (!rawValue) return false;
  const value = rawValue.startsWith('Bearer ') ? rawValue : `Bearer ${rawValue}`;
  if (!/^Bearer ey/.test(value)) return false;
  if (current?.value === value) return false;

  current = { value, expiresAt: decodeExpiry(value.slice(7)) };
  for (const listener of listeners) {
    try {
      listener(status());
    } catch {
      /* listener errors must not break capture */
    }
  }
  return true;
}

export function getToken() {
  return current?.value ?? null;
}

export function clearToken() {
  current = null;
}

export function status() {
  if (!current) return { present: false, secondsLeft: 0, expired: true };
  const secondsLeft = Math.max(0, Math.round((current.expiresAt - Date.now()) / 1000));
  return { present: true, secondsLeft, expired: current.expiresAt > 0 && secondsLeft === 0 };
}

export function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isStale() {
  if (!current) return true;
  if (!current.expiresAt) return false; // unknown expiry: assume usable
  return current.expiresAt - Date.now() < REFRESH_MARGIN_MS;
}

/**
 * Observe the Authorization header on Meshy's own API traffic.
 * Read-only: we never modify or block a request.
 */
export function installCapture() {
  if (!chrome.webRequest?.onBeforeSendHeaders) return false;

  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const header = details.requestHeaders?.find(
        (h) => h.name.toLowerCase() === 'authorization'
      );
      if (header?.value) setToken(header.value);
    },
    { urls: ['https://api.meshy.ai/*'] },
    ['requestHeaders', 'extraHeaders']
  );
  return true;
}

/**
 * Nudge a Meshy tab so the app issues an API call and rotates its token.
 * Prefers an existing tab; falls back to a background tab the user can close.
 */
export async function primeToken({ allowOpen = true } = {}) {
  const tabs = await chrome.tabs.query({ url: 'https://www.meshy.ai/*' });
  if (tabs.length > 0) {
    await chrome.tabs.reload(tabs[0].id, { bypassCache: false });
    return { primed: true, opened: false };
  }
  if (!allowOpen) return { primed: false, opened: false };
  await chrome.tabs.create({ url: MESHY_TAB_URL, active: false, pinned: true });
  return { primed: true, opened: true };
}

/** Wait until a usable token is captured, or time out. */
export async function waitForToken(timeoutMs = 60_000) {
  if (getToken() && !isStale()) return getToken();
  const started = Date.now();
  let primedAt = 0;

  while (Date.now() - started < timeoutMs) {
    if (getToken() && !isStale()) return getToken();
    if (Date.now() - primedAt > 20_000) {
      primedAt = Date.now();
      await primeToken().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return getToken(); // possibly stale, but better than nothing
}
