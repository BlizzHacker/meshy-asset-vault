/**
 * Meshy Asset Vault — background orchestrator.
 *
 * Pipeline per creator:
 *   1. enumerate published showcases        (public API)
 *   2. sign a download URL per model/format (session token)
 *   3. collect animation clips              (public API)
 *   4. hand the signed URLs to the local bridge, which fetches the bytes
 *
 * Signed URLs stay valid long after the token that minted them expires, so a
 * token rotation mid-run costs nothing: we wait for the next one and continue.
 */

import {
  API,
  getMe,
  listAnimationClips,
  listFollowing,
  listShowcases,
  listSubscribed,
  resolveUserId,
  signAssetUrl,
  sleep
} from './lib/api.js';
import * as tokenStore from './lib/token.js';
import { createSink } from './lib/sink.js';

const DEFAULTS = {
  // 'browser' needs no install and works on any Chrome device.
  // 'bridge' unlocks arbitrary destinations (external drives, NAS) via a local server.
  destination: 'browser',
  downloadFolder: 'MeshyAssetVault',
  bridgeUrl: 'http://localhost:19950',
  formats: ['glb'],
  includeAnimations: true,
  resolveConcurrency: 6,
  bridgeWorkers: 4,
  batchSize: 100
};

const ALARM_KEEP_TOKEN_FRESH = 'meshy-vault-token-refresh';
const ALARM_POLL_COMMAND = 'meshy-vault-command-poll';

let job = null;      // active run, if any
let aborter = null;  // AbortController for the active run

// ---------------------------------------------------------------- run state

function blankState() {
  return {
    phase: 'idle',
    sources: [],
    currentSource: null,
    sourceIndex: 0,
    sourceTotal: 0,
    enumerated: 0,
    models: 0,
    resolved: 0,
    failed: 0,
    clips: 0,
    error: '',
    startedAt: 0,
    finishedAt: 0
  };
}

let state = blankState();

let lastMirror = 0;

function patch(changes) {
  state = { ...state, ...changes };
  chrome.storage.local.set({ runState: state }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'STATE', state }).catch(() => {});

  // Mirror to the bridge so scripted runs are observable. Throttled, except for
  // terminal states which should surface immediately.
  const terminal = ['done', 'error', 'stopped'].includes(state.phase);
  const now = Date.now();
  if (terminal || now - lastMirror > 3000) {
    lastMirror = now;
    bridge('/api/state', { method: 'POST', body: { ...state, token: tokenStore.status() } })
      .catch(() => {});
  }
}

async function settings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

// ------------------------------------------------------------------ bridge

async function bridge(path, { method = 'GET', body, bridgeUrl } = {}) {
  const base = bridgeUrl ?? (await settings()).bridgeUrl;
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000)
  });
  if (!resp.ok) throw new Error(`Bridge ${path} → HTTP ${resp.status}`);
  return resp.json();
}

export async function checkBridge(bridgeUrl) {
  try {
    return { online: true, info: await bridge('/health', { bridgeUrl }) };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// ------------------------------------------------------------- source build


const SHARE_LINK = /meshy\.ai\/s\/([A-Za-z0-9]+)/i;
const MODEL_LINK = /meshy\.ai\/3d-models\/[^\s"']*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turn share links, model URLs or bare task ids into archivable models.
 * A /s/ link is a redirect, so the task id only appears once it is followed.
 */
async function resolveShareLinks(entries, signal) {
  const models = [];
  const seen = new Set();

  for (const raw of entries) {
    const entry = String(raw).trim();
    if (!entry) continue;

    let taskId = null;
    const modelMatch = entry.match(MODEL_LINK);
    if (modelMatch) {
      taskId = modelMatch[1];
    } else if (BARE_UUID.test(entry)) {
      taskId = entry;
    } else if (SHARE_LINK.test(entry)) {
      try {
        // Following the redirect exposes the canonical /3d-models/ URL.
        const resp = await fetch(entry, { redirect: 'follow', signal });
        const found = (resp.url || '').match(MODEL_LINK);
        if (found) taskId = found[1];
      } catch {
        /* unreachable link: skipped below */
      }
    }
    if (!taskId || seen.has(taskId)) continue;
    seen.add(taskId);

    // Metadata is public; a miss just means a plainer name in the manifest.
    let name = `model_${taskId.slice(0, 8)}`;
    let license = 'unknown';
    let mode = '';
    try {
      const resp = await fetch(`${API}/web/public/v2/tasks/${taskId}`, { signal });
      if (resp.ok) {
        const body = await resp.json();
        const result = body.result ?? body;
        name = (result.name || '').trim() || name;
        license = result.license || license;
        mode = result.mode || '';
      }
    } catch {
      /* keep the fallback metadata */
    }
    models.push({ showcaseId: taskId, taskId, name, license, mode, animationId: '' });
  }
  return models;
}

/** Expand the user's chosen scopes into a concrete list of creators. */
async function buildSources(options, token, signal) {
  const sources = new Map();
  const add = (user, origin) => {
    if (user?.id && !sources.has(user.id)) {
      sources.set(user.id, { ...user, origin });
    }
  };

  const unresolved = [];
  for (const username of options.usernames ?? []) {
    // Links and bare ids identify one model, not a creator, and are archived
    // separately -- enumerating a profile for them would find nothing.
    if (SHARE_LINK.test(username) || MODEL_LINK.test(username) || BARE_UUID.test(username)) continue;
    try {
      add(await resolveUserId(username, token), 'manual');
    } catch {
      unresolved.push(username); // one bad handle shouldn't sink the run
    }
  }
  if (unresolved.length) patch({ error: `Skipped unknown creators: ${unresolved.join(', ')}` });

  if (options.includeFollowing || options.includeSubscribed || options.includeSelf) {
    const me = await getMe(token);
    if (options.includeSelf) add(me, 'self');
    if (options.includeFollowing) {
      for (const user of await listFollowing(me.id, token, signal)) add(user, 'following');
    }
    if (options.includeSubscribed) {
      // Subscriptions are a secondary source; never let them sink a whole run.
      try {
        for (const user of await listSubscribed(me.id, token, signal)) add(user, 'subscribed');
      } catch {
        /* endpoint unavailable for this account */
      }
    }
  }

  const all = [...sources.values()];
  // `maxCreators` supports staged archives and low-risk trial runs.
  const cap = Number(options.maxCreators);
  return Number.isFinite(cap) && cap > 0 ? all.slice(0, cap) : all;
}

// ----------------------------------------------------------------- resolve

/** Resolve one model into zero or more downloadable records. */
async function resolveModel(model, config, signal) {
  const records = [];

  for (const format of config.formats) {
    try {
      const url = await signAssetUrl(model.taskId, format, tokenStore.getToken(), { signal });
      records.push({
        id: model.taskId,
        name: model.name,
        format,
        kind: 'model',
        url,
        license: model.license,
        author: config.author,
        authorUid: config.authorUid
      });
    } catch (err) {
      if (err.status === 401 || err.status === 403) throw err; // handled upstream
      // 400/404 here means "this model has no such format" — normal, not a failure.
    }
  }

  // Animated models publish their clips separately from the static mesh.
  if (config.includeAnimations && model.mode === 'animate') {
    try {
      for (const clip of await listAnimationClips(model.taskId, { signal })) {
        records.push({
          id: model.taskId,
          name: `${model.name}__${clip.action}${clip.kind === 'armature' ? '_armature' : ''}`,
          format: 'glb',
          kind: 'animated',
          url: clip.url,
          license: model.license,
          author: config.author,
          authorUid: config.authorUid
        });
      }
    } catch {
      /* clip listing is best-effort */
    }
  }

  return records;
}

/** Bounded-concurrency worker pool over the model list. */
async function resolveAll(models, config, signal) {
  let cursor = 0;
  let buffer = [];
  let resolved = 0;
  let failed = 0;
  let clips = 0;
  let delivered = 0;

  /**
   * Hand a batch to the sink. A transient delivery failure (bridge restarting,
   * a blip) must not discard hours of resolved work, so retry with backoff and
   * put the batch back if it still will not go through.
   */
  const flush = async () => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const outcome = await config.sink.deliver(batch, {
          author: config.author,
          authorUid: config.authorUid,
          bridgeUrl: config.bridgeUrl,
          rootFolder: config.downloadFolder
        });
        if (outcome) {
          delivered += outcome.delivered ?? 0;
          patch({ delivered });
        }
        return;
      } catch (err) {
        if (signal.aborted) return;
        if (attempt === 3) {
          buffer.unshift(...batch); // retry with the next flush rather than lose it
          patch({ error: `Delivery failing: ${err.message}` });
          return;
        }
        await sleep(2000 * (attempt + 1));
      }
    }
  };

  const worker = async () => {
    while (!signal.aborted) {
      const index = cursor++;
      if (index >= models.length) break;

      let records = null;
      for (let attempt = 0; attempt < 30 && !signal.aborted; attempt++) {
        try {
          records = await resolveModel(models[index], config, signal);
          break;
        } catch (err) {
          if (err.name === 'AbortError') return;
          if (err.status === 401 || err.status === 403) {
            // Token rotated mid-flight. Wait for the next one and retry.
            patch({ phase: 'waiting-for-token' });
            await tokenStore.waitForToken(120_000);
            if (state.phase === 'waiting-for-token') patch({ phase: 'resolving' });
            continue;
          }
          break;
        }
      }

      if (records?.length) {
        resolved++;
        clips += records.filter((r) => r.kind === 'animated').length;
        buffer.push(...records);
      } else {
        failed++;
      }

      if (buffer.length >= config.batchSize) await flush();
      if ((resolved + failed) % 10 === 0) patch({ resolved, failed, clips });
    }
  };

  await Promise.all(
    Array.from({ length: config.resolveConcurrency }, () => worker())
  );
  await flush();
  return { resolved, failed, clips, delivered };
}

// --------------------------------------------------------------- main flow

async function run(options) {
  aborter = new AbortController();
  const { signal } = aborter;
  const config = await settings();

  try {
    patch({ ...blankState(), phase: 'authenticating', startedAt: Date.now() });

    const destination = options.destination ?? config.destination;
    const sink = createSink(destination);
    patch({ destination: sink.mode });

    // Only the bridge destination depends on a server being up.
    if (sink.needsBridge) {
      const health = await checkBridge(config.bridgeUrl);
      if (!health.online) {
        throw new Error(
          `Bridge offline at ${config.bridgeUrl}. Start it, or switch the destination to browser downloads.`
        );
      }
    }

    const token = await tokenStore.waitForToken(90_000);
    if (!token) throw new Error('No Meshy session found. Sign in at meshy.ai and retry.');

    patch({ phase: 'listing-creators' });
    const sources = await buildSources(options, token, signal);

    const linkEntries = (options.usernames ?? []).filter(
      (u) => SHARE_LINK.test(u) || MODEL_LINK.test(u) || BARE_UUID.test(u)
    );
    const directModels = linkEntries.length
      ? await resolveShareLinks(linkEntries, signal)
      : [];

    if (sources.length === 0 && directModels.length === 0) {
      throw new Error('No creators or links selected.');
    }

    const directSource = directModels.length
      ? { id: 'shared-links', username: 'shared-links', origin: 'link', models: directModels }
      : null;
    const allSources = directSource ? [...sources, directSource] : sources;

    patch({
      sources: allSources.map((s) => s.username),
      sourceTotal: allSources.length,
      phase: 'enumerating'
    });

    let totals = { resolved: 0, failed: 0, clips: 0, models: 0 };

    for (const [index, source] of allSources.entries()) {
      if (signal.aborted) break;
      patch({
        currentSource: source.username,
        sourceIndex: index + 1,
        phase: 'enumerating',
        enumerated: 0
      });

      const models = source.models
        ? source.models
        : await listShowcases(source.id, {
            signal,
            onProgress: (n) => patch({ enumerated: n })
          });
      if (source.models) patch({ enumerated: models.length });

      patch({ phase: 'resolving', models: models.length, resolved: 0, failed: 0 });

      const result = await resolveAll(
        models,
        {
          ...config,
          sink,
          downloadFolder: options.downloadFolder ?? config.downloadFolder,
          formats: options.formats ?? config.formats,
          includeAnimations: options.includeAnimations ?? config.includeAnimations,
          author: source.username,
          authorUid: source.id
        },
        signal
      );

      totals = {
        models: totals.models + models.length,
        resolved: totals.resolved + result.resolved,
        failed: totals.failed + result.failed,
        clips: totals.clips + result.clips
      };

      // Browser downloads have already landed by this point; the bridge fetches
      // asynchronously, so it needs an explicit nudge per creator.
      if (sink.needsBridge) {
        await bridge('/api/start-download', {
          method: 'POST',
          body: { author: source.username, workers: config.bridgeWorkers },
          bridgeUrl: config.bridgeUrl
        }).catch(() => {});
      }
    }

    patch({
      phase: signal.aborted ? 'stopped' : 'done',
      models: totals.models,
      resolved: totals.resolved,
      failed: totals.failed,
      clips: totals.clips,
      finishedAt: Date.now()
    });
  } catch (err) {
    patch({ phase: 'error', error: err.message, finishedAt: Date.now() });
  } finally {
    job = null;
    aborter = null;
  }
}

// ------------------------------------------------------------------ wiring

tokenStore.installCapture();

function installAlarms() {
  chrome.alarms.create(ALARM_KEEP_TOKEN_FRESH, { periodInMinutes: 4 });
  chrome.alarms.create(ALARM_POLL_COMMAND, { periodInMinutes: 0.5 });
}
chrome.runtime.onInstalled.addListener(installAlarms);
chrome.runtime.onStartup.addListener(installAlarms);

/** Pick up a run queued on the bridge (scheduled or scripted archives). */
async function pollCommand() {
  let reply;
  try {
    reply = await bridge('/api/command');
  } catch {
    return; // bridge not running; nothing to do
  }
  const command = reply?.command;
  if (!command) return;

  if (command.action === 'start' && !job) {
    job = run(command.options ?? {});
  } else if (command.action === 'stop') {
    aborter?.abort();
    patch({ phase: 'stopping' });
  }
}

// Alarms can only fire every ~30-60s, and a dormant worker makes that the floor.
// The worker also wakes for Meshy's own request headers, so piggyback on that:
// whenever a token is seen, opportunistically check for queued work.
let lastOpportunisticPoll = 0;
tokenStore.onChange(() => {
  // Relay the freshly captured token to the bridge. This used to run only from
  // the localStorage fallback, which never fires against a cookie session, so
  // the host copy went stale and server-side tooling could not authenticate.
  const token = tokenStore.getToken();
  if (token) pushTokenToBridge(token);

  const now = Date.now();
  if (now - lastOpportunisticPoll < 5000) return;
  lastOpportunisticPoll = now;
  pollCommand().catch(() => {});
});

// A cold start should never sit idle on queued work.
pollCommand().catch(() => {});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_POLL_COMMAND) {
    pollCommand().catch(() => {});
    return;
  }
  if (alarm.name !== ALARM_KEEP_TOKEN_FRESH) return;
  // Only churn a tab while a run actually needs credentials.
  if (job !== null && tokenStore.isStale()) {
    tokenStore.primeToken({ allowOpen: true }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'TOKEN_HINT':
        // Content-script fallback for environments where webRequest is unavailable.
        tokenStore.setToken(message.token);
        return sendResponse({ ok: true });

      case 'GET_STATE':
        return sendResponse({
          state,
          token: tokenStore.status(),
          running: job !== null
        });

      case 'CHECK_BRIDGE':
        return sendResponse(await checkBridge(message.bridgeUrl));

      case 'PRIME_TOKEN':
        await tokenStore.primeToken({ allowOpen: true }).catch(() => {});
        return sendResponse({ ok: true, token: tokenStore.status() });

      case 'LIST_CREATORS': {
        try {
          const token = await tokenStore.waitForToken(60_000);
          if (!token) throw new Error('No Meshy session found.');
          const me = await getMe(token);
          const [following, subscribed] = await Promise.all([
            listFollowing(me.id, token),
            listSubscribed(me.id, token).catch(() => [])
          ]);
          return sendResponse({ ok: true, me, following, subscribed });
        } catch (err) {
          return sendResponse({ ok: false, error: err.message });
        }
      }

      case 'START':
        if (job) return sendResponse({ ok: false, error: 'A run is already active.' });
        job = run(message.options ?? {});
        return sendResponse({ ok: true });

      case 'STOP':
        aborter?.abort();
        patch({ phase: 'stopping' });
        return sendResponse({ ok: true });

      default:
        return sendResponse({ ok: false, error: 'Unknown message' });
    }
  })();
  return true; // async response
});
