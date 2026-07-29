/**
 * Meshy Asset Vault — local bridge.
 *
 * The browser extension resolves signed, time-limited download URLs and posts
 * them here. This process does the actual fetching and writes files to storage
 * you control. Nothing is uploaded anywhere; there is no cloud component.
 *
 * Storage modes
 *   local  (default) — write into STORAGE_DIR on this machine
 *   remote           — hand the manifest to a host over SSH and let it fetch
 *                      (useful when your archive lives on a NAS or server)
 *
 * Configure with environment variables or a .env file — see .env.example.
 */

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
try {
  require('dotenv').config();
} catch {
  /* dotenv is optional */
}

const PORT = Number(process.env.PORT ?? 19950);
// Seeded from the environment, but changeable at runtime from the extension's
// settings page so users never have to hand-edit a config file.
let activeStorageDir = path.resolve(process.env.STORAGE_DIR ?? './vault');
const MODE = (process.env.STORAGE_MODE ?? 'local').toLowerCase();
const DEFAULT_WORKERS = Number(process.env.WORKERS ?? 4);
const ALLOWED_ORIGIN = /^chrome-extension:\/\//;

// Remote mode: ship manifests to a host that owns the storage and let it fetch.
const REMOTE_HOST = process.env.REMOTE_HOST ?? '';        // e.g. root@nas.local
const REMOTE_DIR = process.env.REMOTE_DIR ?? '';          // vault root on that host
const REMOTE_WORKER = process.env.REMOTE_WORKER ?? '~/vault_fetch.py';
const SSH_KEY = process.env.SSH_KEY ?? '';

const GLTF_MAGIC = Buffer.from('glTF');
const USER_AGENT = 'MeshyAssetVault/2.0 (+https://github.com/)';

const app = express();
// Chrome's Private Network Access check: a secure context (the extension's
// service worker) may only call a loopback address if the preflight is answered
// with this header. Without it every request from the worker fails silently,
// which looks exactly like the extension being asleep.
app.use((req, res, next) => {
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});

app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGIN.test(origin)),
  allowedHeaders: ['Content-Type'],
  maxAge: 600
}));
app.use(express.json({ limit: '64mb' }));

/** Per-author download queues, so several creators can be in flight at once. */
const queues = new Map();
const stats = { received: 0, downloaded: 0, skipped: 0, failed: 0, bytes: 0 };

// ------------------------------------------------------------------ helpers

const safeSegment = (value, max = 80) =>
  (String(value ?? '')
    .replace(/[^A-Za-z0-9._ -]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, max)) || 'unnamed';

function destinationFor(record) {
  const author = safeSegment(record.author, 48);
  const bucket = record.kind === 'animated' ? 'animated' : record.format;
  return path.join(activeStorageDir, author, bucket);
}

/**
 * Some models are served as a ZIP wrapping the mesh. Trust the URL over the
 * requested format, so a ZIP never lands on disk labelled `.glb`.
 */
function extensionFor(record) {
  try {
    if (new URL(record.url).pathname.toLowerCase().endsWith('.zip')) return 'zip';
  } catch {
    /* fall back to the declared format */
  }
  return record.kind === 'animated' ? 'glb' : record.format;
}

function filenameFor(record) {
  return `${record.id}__${safeSegment(record.name)}.${extensionFor(record)}`;
}

async function isIntact(file, format) {
  try {
    const { size } = await fsp.stat(file);
    if (size < 256) return false;
    if (format !== 'glb') return true;
    const handle = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(4);
      await handle.read(buf, 0, 4, 0);
      return buf.equals(GLTF_MAGIC);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function fetchToDisk(record) {
  const dir = destinationFor(record);
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, filenameFor(record));
  const ext = extensionFor(record);

  if (await isIntact(target, ext)) return { status: 'skipped', bytes: 0 };

  const partial = `${target}.part`;
  let lastError;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await fetch(record.url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(300_000)
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(partial));

      if (!(await isIntact(partial, ext))) throw new Error('content failed validation');
      const { size } = await fsp.stat(partial);
      await fsp.rename(partial, target);
      return { status: 'downloaded', bytes: size };
    } catch (err) {
      lastError = err;
      await fsp.rm(partial, { force: true });
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return { status: 'failed', bytes: 0, error: lastError?.message };
}

async function appendManifest(author, records) {
  const dir = path.join(activeStorageDir, safeSegment(author, 48), '_manifest');
  await fsp.mkdir(dir, { recursive: true });
  const lines = records.map((r) => JSON.stringify({ ...r, receivedAt: Date.now() })).join('\n');
  await fsp.appendFile(path.join(dir, 'records.jsonl'), `${lines}\n`, 'utf8');
}

// ------------------------------------------------------------- remote mode

const isRemote = () => MODE === 'remote' && REMOTE_HOST && REMOTE_DIR;

function ssh(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const base = SSH_KEY ? ['-i', SSH_KEY] : [];
    const child = spawn('ssh', [...base, '-o', 'BatchMode=yes', REMOTE_HOST, ...args], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `ssh exited ${code}`))
    );
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** Append records to the remote manifest without ever interpolating them into a shell string. */
async function appendManifestRemote(author, records) {
  const dir = `${REMOTE_DIR}/${safeSegment(author, 48)}/_manifest`;
  const payload = records.map((r) => JSON.stringify({ ...r, receivedAt: Date.now() })).join('\n');
  await ssh(
    [`mkdir -p ${shellQuote(dir)} && cat >> ${shellQuote(`${dir}/records.jsonl`)}`],
    { input: `${payload}\n` }
  );
}

async function startRemoteFetch(author, workers) {
  const safeAuthor = safeSegment(author, 48);
  const logDir = `${REMOTE_DIR}/${safeAuthor}/_manifest`;
  // `flock -c "... &"` would release the lock the instant the shell backgrounds
  // the job, so it guards nothing. Guard on the worker's own process signature
  // instead: one fetch per author, and re-running is safe anyway (it resumes).
  // Bracket the first character so the pattern cannot match the very shell that
  // is evaluating it — otherwise pgrep always finds "itself" and never starts.
  const signature = `[v]ault_fetch\\.py ${REMOTE_DIR} ${safeAuthor}`;
  const command =
    `mkdir -p ${shellQuote(logDir)}; ` +
    `if pgrep -f ${shellQuote(signature)} > /dev/null; then echo already-running; else ` +
    `setsid nohup python3 ${REMOTE_WORKER} ${shellQuote(REMOTE_DIR)} ${shellQuote(safeAuthor)} ` +
    `--workers ${Number(workers) || DEFAULT_WORKERS} ` +
    `>> ${shellQuote(`${logDir}/fetch.log`)} 2>&1 < /dev/null & echo started; fi`;
  return (await ssh([command])).trim();
}

/**
 * Re-arm the remote fetcher shortly after records land. Debounced so a burst of
 * batches results in one launch, and harmless if a worker is already running —
 * the guard reports "already-running" and the next batch re-arms it again.
 */
const remoteDrainTimers = new Map();

function scheduleRemoteDrain(author, delayMs = 4000) {
  clearTimeout(remoteDrainTimers.get(author));
  remoteDrainTimers.set(
    author,
    setTimeout(() => {
      remoteDrainTimers.delete(author);
      startRemoteFetch(author, DEFAULT_WORKERS).catch(() => {});
    }, delayMs)
  );
}

/** Drain one author's queue with a bounded worker pool. */
async function drain(author, workers) {
  const queue = queues.get(author);
  if (!queue || queue.running) return;
  queue.running = true;

  const run = async () => {
    while (queue.pending.length > 0) {
      const record = queue.pending.shift();
      const result = await fetchToDisk(record);
      stats[result.status] = (stats[result.status] ?? 0) + 1;
      stats.bytes += result.bytes;
      queue.done++;
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.max(1, workers) }, run));
  } finally {
    queue.running = false;
    if (queue.pending.length > 0) drain(author, workers);
  }
}

// ---------------------------------------------------------------- endpoints

app.get('/health', async (_req, res) => {
  const payload = { status: 'ok', version: '2.0.0', mode: isRemote() ? 'remote' : 'local', stats };

  if (isRemote()) {
    payload.storageDir = `${REMOTE_HOST}:${REMOTE_DIR}`;
    try {
      const df = await ssh([`df -h ${shellQuote(REMOTE_DIR)} | tail -1`]);
      payload.freeSpace = df.trim().split(/\s+/)[3] ?? null;
    } catch (err) {
      payload.status = 'remote-unreachable';
      payload.error = err.message;
      return res.status(503).json(payload);
    }
  } else {
    await fsp.mkdir(activeStorageDir, { recursive: true }).catch(() => {});
    payload.storageDir = activeStorageDir;
  }
  res.json(payload);
});

/**
 * Storage folder, readable and settable from the extension's settings page so
 * users are not forced to hand-edit .env. Local mode only — in remote mode the
 * destination is owned by the host configuration.
 */
app.get('/api/config', (_req, res) => {
  res.json({
    ok: true,
    mode: isRemote() ? 'remote' : 'local',
    storageDir: isRemote() ? `${REMOTE_HOST}:${REMOTE_DIR}` : activeStorageDir,
    editable: !isRemote()
  });
});

app.post('/api/config', async (req, res) => {
  if (isRemote()) {
    return res.status(409).json({
      error: 'This bridge is in remote mode; set REMOTE_DIR in its .env instead.'
    });
  }
  const requested = String(req.body?.storageDir ?? '').trim();
  if (!requested) return res.status(400).json({ error: 'storageDir is required' });

  const resolved = path.resolve(requested);
  try {
    await fsp.mkdir(resolved, { recursive: true });
    await fsp.access(resolved, fs.constants.W_OK);
  } catch (err) {
    return res.status(400).json({ error: `Cannot write to "${resolved}": ${err.code ?? err.message}` });
  }

  activeStorageDir = resolved;
  console.log(`Storage folder changed to ${resolved}`);
  res.json({ ok: true, storageDir: resolved });
});

app.post('/api/records', async (req, res) => {
  const { author, records } = req.body ?? {};
  if (!author || !Array.isArray(records)) {
    return res.status(400).json({ error: 'author and records[] are required' });
  }

  const valid = records.filter((r) => r?.id && r?.url && (r.format || r.kind === 'animated'));
  if (valid.length === 0) return res.json({ ok: true, accepted: 0 });

  try {
    if (isRemote()) {
      await appendManifestRemote(author, valid);
      stats.received += valid.length;
      // The remote worker exits once it drains the records it loaded, so newly
      // arrived ones would sit idle until something kicked it. Re-arm it here,
      // debounced, so a long resolve keeps feeding a live fetcher.
      scheduleRemoteDrain(author);
      return res.json({ ok: true, accepted: valid.length, mode: 'remote' });
    }

    await appendManifest(author, valid);
    if (!queues.has(author)) queues.set(author, { pending: [], done: 0, running: false });
    queues.get(author).pending.push(...valid);
    stats.received += valid.length;
    res.json({ ok: true, accepted: valid.length, queued: queues.get(author).pending.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/start-download', async (req, res) => {
  const { author, workers = DEFAULT_WORKERS } = req.body ?? {};

  if (isRemote()) {
    if (!author) return res.status(400).json({ error: 'author is required in remote mode' });
    try {
      return res.json({ ok: true, mode: 'remote', result: await startRemoteFetch(author, workers) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const targets = author ? [author] : [...queues.keys()];
  for (const name of targets) drain(name, Number(workers) || DEFAULT_WORKERS);
  res.json({ ok: true, draining: targets });
});

/**
 * Local control channel.
 *
 * Lets you kick off a run without opening the popup — useful for scheduled or
 * scripted archives. The bridge only ever listens on 127.0.0.1, and a queued
 * command can do nothing the user could not do from the popup themselves.
 */
let pendingCommand = null;
let lastRunState = null;

/** The extension mirrors its run state here so scripts can watch progress. */
app.post('/api/state', (req, res) => {
  lastRunState = { ...req.body, reportedAt: Date.now() };
  res.json({ ok: true });
});

app.get('/api/state', (_req, res) => res.json({ ok: true, state: lastRunState }));

app.post('/api/command', (req, res) => {
  const { action, options } = req.body ?? {};
  if (action !== 'start' && action !== 'stop') {
    return res.status(400).json({ error: 'action must be "start" or "stop"' });
  }
  pendingCommand = { action, options: options ?? {}, queuedAt: Date.now() };
  res.json({ ok: true, queued: pendingCommand });
});

// Claimed (and cleared) by the extension's poll. Exactly one consumer wins.
app.get('/api/command', (_req, res) => {
  const command = pendingCommand;
  pendingCommand = null;
  res.json({ ok: true, command });
});

// Read-only view for diagnostics — deliberately does NOT consume, so watching
// the queue can never steal a command from the extension.
app.get('/api/command/peek', (_req, res) =>
  res.json({ ok: true, pending: pendingCommand })
);

app.get('/api/status', (req, res) => {
  const author = req.query.author;
  const summary = [...queues.entries()].map(([name, q]) => ({
    author: name,
    pending: q.pending.length,
    done: q.done,
    running: q.running
  }));
  res.json({
    ok: true,
    stats,
    queues: author ? summary.filter((q) => q.author === author) : summary
  });
});

app.listen(PORT, '127.0.0.1', async () => {
  await fsp.mkdir(activeStorageDir, { recursive: true }).catch(() => {});
  console.log(`Meshy Asset Vault bridge  ·  http://localhost:${PORT}`);
  console.log(`Storage (${MODE}): ${isRemote() ? `${REMOTE_HOST}:${REMOTE_DIR}` : activeStorageDir}`);
});
