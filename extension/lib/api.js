/**
 * Meshy web API client.
 *
 * Two classes of endpoint are used:
 *   - Public  (no credentials): showcase listings and task details.
 *   - Session (Bearer token):   follow/subscription lists and asset-url signing.
 *
 * The Bearer token is never stored remotely and never leaves the machine except
 * to the user's own local bridge. See docs/PRIVACY.md.
 */

export const API = 'https://api.meshy.ai';
export const PAGE_SIZE = 50;

/** Deep pagination is capped server-side (~3000 rows per sort order). */
export const OFFSET_CAP_STATUS = 400;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function authHeader(token) {
  if (!token) return null;
  return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
}

async function request(url, { token, retries = 4, signal } = {}) {
  const headers = { Accept: 'application/json' };
  const auth = authHeader(token);
  if (auth) headers.Authorization = auth;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let resp;
    try {
      resp = await fetch(url, { headers, credentials: 'omit', signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (attempt === retries) throw err;
      await sleep(1000 * (attempt + 1));
      continue;
    }

    if (resp.ok) return resp.json();
    // Caller decides what these mean; don't burn retries on them.
    if (resp.status === 400 || resp.status === 401 || resp.status === 403 || resp.status === 404) {
      const error = new Error(`HTTP ${resp.status}`);
      error.status = resp.status;
      throw error;
    }
    if (attempt === retries) {
      const error = new Error(`HTTP ${resp.status}`);
      error.status = resp.status;
      throw error;
    }
    await sleep(Math.min(2 ** attempt, 15) * 1000);
  }
}

/**
 * Identify the signed-in account. Preferred over asking the user to type their
 * own username, and it is what anchors the follow/subscription lookups.
 */
export async function getMe(token) {
  const data = await request(`${API}/web/v1/me/info`, { token });
  const result = data.result ?? data;
  const id = result?.id ?? result?.userId ?? result?.uid;
  if (!id) throw new Error('Could not identify the signed-in Meshy account');
  return { id, username: result.username ?? result.name ?? 'me' };
}

/**
 * Resolve a username to its stable user id. Requires a session token because
 * Meshy does not expose profile lookup publicly.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveUserId(username, token) {
  const clean = String(username).replace(/^@/, '').trim();

  // A raw user id needs no lookup — and enumeration itself is public, so this
  // path works even before a session token has been captured.
  if (UUID_RE.test(clean)) return { id: clean, username: clean };

  const data = await request(
    `${API}/web/v1/users/${encodeURIComponent(clean)}/info?byUid=true`,
    { token }
  );
  const result = data.result ?? data;
  if (!result?.id) throw new Error(`Could not resolve user "${clean}"`);
  return { id: result.id, username: result.username ?? clean };
}

/** Paginate an authenticated relationship list (following / subscribed). */
async function relationshipList(userId, kind, token, signal) {
  const seen = new Map();
  for (let pageNum = 1; ; pageNum++) {
    let data;
    try {
      data = await request(
        `${API}/web/v1/users/${userId}/${kind}?pageSize=${PAGE_SIZE}&pageNum=${pageNum}`,
        { token, signal }
      );
    } catch (err) {
      if (err.status === OFFSET_CAP_STATUS) break;
      throw err;
    }
    const rows = data.result;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      // The payload nests the counterpart user under a few possible keys.
      const user = row.user ?? row.followingUser ?? row.targetUser ?? row;
      const id = user.id ?? user.userId ?? user.uid;
      if (id && !seen.has(id)) {
        seen.set(id, { id, username: user.username ?? user.name ?? id });
      }
    }
    if (rows.length < PAGE_SIZE) break;
    await sleep(120);
  }
  return [...seen.values()];
}

export const listFollowing = (userId, token, signal) =>
  relationshipList(userId, 'following', token, signal);

export const listSubscribed = (userId, token, signal) =>
  relationshipList(userId, 'subscribed', token, signal);

/**
 * Enumerate every published showcase for a user.
 *
 * Deep pagination is capped per sort order, so we sweep newest-first and
 * oldest-first and union the results — that covers catalogues up to ~2x the cap.
 * This endpoint is public; no token is required.
 */
export async function listShowcases(userId, { signal, onProgress } = {}) {
  const found = new Map();
  for (const sortBy of ['-created_at', '+created_at']) {
    for (let pageNum = 1; ; pageNum++) {
      const url =
        `${API}/web/public/v2/showcases?pageSize=${PAGE_SIZE}&pageNum=${pageNum}` +
        `&publishedByUser=${userId}&sortBy=${encodeURIComponent(sortBy)}`;
      let data;
      try {
        data = await request(url, { signal });
      } catch (err) {
        if (err.status === OFFSET_CAP_STATUS) break; // reached the depth cap
        throw err;
      }
      const rows = data.result;
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        if (row?.id && !found.has(row.id)) {
          found.set(row.id, {
            showcaseId: row.id,
            // asset-url is keyed on the underlying task id, NOT the showcase id.
            taskId: row.resultId ?? row.id,
            name: row.name ?? 'untitled',
            license: row.license ?? 'unknown',
            mode: row.mode ?? '',
            animationId: row.animationId ?? '',
            triangleCount: row.triangleCount ?? null
          });
        }
      }
      onProgress?.(found.size);
      if (rows.length < PAGE_SIZE) break;
      await sleep(120);
    }
  }
  return [...found.values()];
}

/**
 * Sign a download URL for one model in one format.
 * Returns a time-limited URL that needs no credentials to fetch.
 */
export async function signAssetUrl(taskId, format, token, { type = 'Showcase', signal } = {}) {
  const data = await request(
    `${API}/web/v2/tasks/${taskId}/asset-url?type=${type}&format=${format}`,
    { token, signal, retries: 2 }
  );
  const url = data.result;
  if (typeof url !== 'string' || !url.startsWith('http')) {
    throw new Error('No signed URL in response');
  }
  return url;
}

/**
 * Animated models expose their clips publicly on the task detail — each action
 * carries a skinned animation GLB plus its armature. No token needed.
 */
export async function listAnimationClips(taskId, { signal } = {}) {
  const data = await request(`${API}/web/public/v2/tasks/${taskId}`, { signal, retries: 2 });
  const result = data.result ?? data;
  const actions = result?.result?.animate?.actions;
  if (!Array.isArray(actions)) return [];

  const clips = [];
  actions.forEach((action, index) => {
    if (!action || typeof action !== 'object') return;
    const label = action.actionType || `action${index}`;
    if (action.animationGlbUrl) {
      clips.push({ action: label, kind: 'animation', url: action.animationGlbUrl });
    }
    if (action.armatureGlbUrl) {
      clips.push({ action: label, kind: 'armature', url: action.armatureGlbUrl });
    }
  });
  return clips;
}
