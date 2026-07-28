/**
 * Delivery sinks — where archived files actually end up.
 *
 * browser: Chrome's own download manager writes into the user's Downloads
 *          folder. No install, no server, works on any Chrome device.
 * bridge:  a small local server the user runs, which can write anywhere on
 *          disk (external drives, NAS mounts) and handle very large archives.
 *
 * Both expose the same interface, so the orchestrator does not care which is in
 * use: deliver(records, ctx) -> { delivered, skipped, failed }
 */

const MAX_PARALLEL_DOWNLOADS = 4;
const SEEN_KEY = 'downloadedKeys';

const safeSegment = (value, max = 80) => {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9._ -]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  return cleaned.slice(0, max) || 'untitled';
};

const bucketFor = (record) => (record.kind === 'animated' ? 'animated' : record.format);

/**
 * Meshy serves some models (stylized ones especially) as a ZIP containing the
 * mesh. Naming those `.glb` produces a file nothing can open, so honour what the
 * URL actually points at.
 */
function extFor(record) {
  try {
    if (new URL(record.url).pathname.toLowerCase().endsWith('.zip')) return 'zip';
  } catch {
    /* fall through to the declared format */
  }
  return record.kind === 'animated' ? 'glb' : record.format;
}

export function relativePathFor(record, { rootFolder, author }) {
  return [
    safeSegment(rootFolder, 40),
    safeSegment(author, 48),
    safeSegment(bucketFor(record), 12),
    `${safeSegment(record.id, 40)}__${safeSegment(record.name)}.${extFor(record)}`
  ].join('/');
}

const keyFor = (record) => `${record.id}|${record.format}|${record.kind}|${record.name}`;

// ---------------------------------------------------------------- browser

/** Resolve once Chrome reports the download finished (or failed). */
function awaitDownload(downloadId) {
  return new Promise((resolve) => {
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve({ ok: true });
      } else if (delta.state?.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve({ ok: false, error: delta.error?.current ?? 'interrupted' });
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function loadSeen() {
  const stored = await chrome.storage.local.get({ [SEEN_KEY]: [] });
  return new Set(stored[SEEN_KEY]);
}

async function saveSeen(seen) {
  // Keep the skip-list bounded so storage cannot grow without limit.
  const list = [...seen].slice(-50_000);
  await chrome.storage.local.set({ [SEEN_KEY]: list });
}

async function deliverViaBrowser(records, ctx) {
  const seen = await loadSeen();
  const pending = records.filter((r) => !seen.has(keyFor(r)));
  const result = { delivered: 0, skipped: records.length - pending.length, failed: 0 };

  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const record = pending[cursor++];
      try {
        const downloadId = await chrome.downloads.download({
          url: record.url,
          filename: relativePathFor(record, ctx),
          conflictAction: 'overwrite',
          saveAs: false
        });
        const outcome = await awaitDownload(downloadId);
        if (outcome.ok) {
          result.delivered++;
          seen.add(keyFor(record));
        } else {
          result.failed++;
        }
      } catch {
        result.failed++;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL_DOWNLOADS, pending.length) }, worker)
  );
  await saveSeen(seen);
  return result;
}

// ----------------------------------------------------------------- bridge

async function deliverViaBridge(records, ctx) {
  const resp = await fetch(`${ctx.bridgeUrl}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: ctx.author, authorUid: ctx.authorUid, records }),
    signal: AbortSignal.timeout(60_000)
  });
  if (!resp.ok) throw new Error(`Bridge rejected records (HTTP ${resp.status})`);
  return { delivered: records.length, skipped: 0, failed: 0 };
}

// ------------------------------------------------------------------ facade

export function createSink(mode) {
  return mode === 'bridge'
    ? { mode, deliver: deliverViaBridge, needsBridge: true }
    : { mode: 'browser', deliver: deliverViaBrowser, needsBridge: false };
}

/** Clear the browser-mode skip list so a re-run fetches everything again. */
export async function resetHistory() {
  await chrome.storage.local.set({ [SEEN_KEY]: [] });
}
