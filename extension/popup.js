const $ = (id) => document.getElementById(id);

const PHASE_LABEL = {
  idle: 'idle',
  authenticating: 'signing in',
  'listing-creators': 'listing creators',
  enumerating: 'enumerating models',
  resolving: 'resolving downloads',
  'waiting-for-token': 'waiting for session',
  stopping: 'stopping',
  stopped: 'stopped',
  done: 'complete',
  error: 'error'
};

const ACTIVE_PHASES = new Set([
  'authenticating', 'listing-creators', 'enumerating', 'resolving',
  'waiting-for-token', 'stopping'
]);

const SETTING_KEYS = {
  includeFollowing: true,
  includeSubscribed: true,
  includeSelf: false,
  includeAnimations: true,
  usernames: '',
  formats: ['glb'],
  bridgeUrl: 'http://localhost:19950'
};

function selectedFormats() {
  return [...document.querySelectorAll('.chip input:checked')].map((el) => el.value);
}

function setBanner(el, textEl, tone, message) {
  el.className = `banner banner--${tone}`;
  textEl.textContent = message;
}

function renderToken(token) {
  if (!token?.present) {
    return setBanner($('tokenStatus'), $('tokenText'), 'pending',
      'No Meshy session yet — open meshy.ai while signed in.');
  }
  if (token.expired) {
    return setBanner($('tokenStatus'), $('tokenText'), 'pending',
      'Session expired — refreshing automatically.');
  }
  const mins = Math.floor(token.secondsLeft / 60);
  const label = mins >= 1 ? `${mins}m` : `${token.secondsLeft}s`;
  setBanner($('tokenStatus'), $('tokenText'), 'ok', `Meshy session captured (${label} left)`);
}

function renderState(state) {
  if (!state) return;

  $('phase').textContent = PHASE_LABEL[state.phase] ?? state.phase;
  $('statModels').textContent = state.models ?? 0;
  $('statResolved').textContent = state.resolved ?? 0;
  $('statClips').textContent = state.clips ?? 0;
  $('statFailed').textContent = state.failed ?? 0;

  if (state.phase === 'error') {
    $('sourceLine').textContent = state.error || 'Run failed';
  } else if (state.currentSource) {
    const enumerating = state.phase === 'enumerating';
    $('sourceLine').textContent =
      `@${state.currentSource} — creator ${state.sourceIndex}/${state.sourceTotal}` +
      (enumerating ? ` · found ${state.enumerated}` : '');
  } else if (state.phase === 'done') {
    $('sourceLine').textContent =
      `Archived ${state.resolved} models across ${state.sourceTotal} creators`;
  } else if (state.phase === 'idle') {
    $('sourceLine').textContent = 'No run in progress';
  }

  const denom = state.models || 0;
  const pct = denom > 0 ? Math.min(100, Math.round(((state.resolved + state.failed) / denom) * 100)) : 0;
  $('progressBar').style.width = `${pct}%`;

  const active = ACTIVE_PHASES.has(state.phase);
  $('start').disabled = active;
  $('stop').disabled = !active;
}

async function refresh() {
  const reply = await chrome.runtime.sendMessage({ type: 'GET_STATE' }).catch(() => null);
  if (!reply) return;
  renderState(reply.state);
  renderToken(reply.token);
}

async function checkBridge() {
  const { bridgeUrl } = await chrome.storage.local.get({ bridgeUrl: SETTING_KEYS.bridgeUrl });
  const reply = await chrome.runtime
    .sendMessage({ type: 'CHECK_BRIDGE', bridgeUrl })
    .catch(() => null);

  if (reply?.online) {
    const free = reply.info?.freeSpace ? ` · ${reply.info.freeSpace} free` : '';
    setBanner($('bridgeStatus'), $('bridgeText'), 'ok', `Local bridge connected${free}`);
  } else {
    setBanner($('bridgeStatus'), $('bridgeText'), 'error',
      'Local bridge offline — start it to receive files');
  }
}

async function restoreSettings() {
  const stored = await chrome.storage.local.get(SETTING_KEYS);
  $('includeFollowing').checked = stored.includeFollowing;
  $('includeSubscribed').checked = stored.includeSubscribed;
  $('includeSelf').checked = stored.includeSelf;
  $('includeAnimations').checked = stored.includeAnimations;
  $('usernames').value = stored.usernames;
  for (const input of document.querySelectorAll('.chip input')) {
    input.checked = stored.formats.includes(input.value);
  }
  return stored;
}

function currentOptions(stored) {
  return {
    includeFollowing: $('includeFollowing').checked,
    includeSubscribed: $('includeSubscribed').checked,
    includeSelf: $('includeSelf').checked,
    includeAnimations: $('includeAnimations').checked,
    formats: selectedFormats(),
    usernames: $('usernames').value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await restoreSettings();

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

  $('preview').addEventListener('click', async () => {
    const list = $('creatorList');
    list.hidden = false;
    list.textContent = 'Loading creator list…';

    const reply = await chrome.runtime
      .sendMessage({ type: 'LIST_CREATORS' })
      .catch(() => null);

    if (!reply?.ok) {
      list.textContent = reply?.error ?? 'Could not load creators.';
      return;
    }

    const rows = [
      ...reply.following.map((u) => ({ ...u, origin: 'following' })),
      ...reply.subscribed.map((u) => ({ ...u, origin: 'subscribed' }))
    ];
    list.innerHTML = '';
    if (rows.length === 0) {
      list.textContent = 'No creators found.';
      return;
    }
    for (const row of rows) {
      const el = document.createElement('div');
      el.className = 'creator-row';
      const name = document.createElement('span');
      name.textContent = `@${row.username}`;
      const origin = document.createElement('span');
      origin.className = 'origin';
      origin.textContent = row.origin;
      el.append(name, origin);
      list.append(el);
    }
  });

  $('start').addEventListener('click', async () => {
    const options = currentOptions(stored);
    if (options.formats.length === 0 && !options.includeAnimations) {
      $('sourceLine').textContent = 'Pick at least one format.';
      return;
    }
    await chrome.storage.local.set({
      includeFollowing: options.includeFollowing,
      includeSubscribed: options.includeSubscribed,
      includeSelf: options.includeSelf,
      includeAnimations: options.includeAnimations,
      formats: options.formats,
      usernames: $('usernames').value
    });
    await chrome.runtime.sendMessage({ type: 'START', options });
    refresh();
  });

  $('stop').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'STOP' });
    refresh();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'STATE') renderState(message.state);
  });

  await Promise.all([refresh(), checkBridge()]);
  setInterval(refresh, 2000);
  setInterval(checkBridge, 10000);
});
