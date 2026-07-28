# Meshy Asset Vault

Bulk-archive your [Meshy](https://www.meshy.ai) 3D models — and the creators you
follow — to storage you actually control.

Meshy's web UI downloads one model at a time, through a save dialog, in one
format. If you have thousands of models, that isn't a workflow. Asset Vault turns
it into a single button: pick your sources, pick your formats, walk away.

```
Extension (your browser session)          Bridge (your machine)
  ├── enumerate published models  ──────►
  ├── sign time-limited URLs      ──────►   fetch bytes ──► your storage
  └── collect animation clips     ──────►   verify + manifest
```

## Features

- **Whole-library archiving** — every published model for any creator, not just
  the first page.
- **Follows and subscriptions** — archive everyone you follow in one run.
- **Rigged animations** — pulls each animation clip and its armature as separate
  GLB files, not just the static mesh.
- **GLB / FBX / OBJ** — request any combination.
- **Hands-off authentication** — reads the session your browser already has. No
  API keys, no DevTools, no copying tokens.
- **Resumable** — re-running skips anything already on disk and verified.
- **Local only** — files go straight from Meshy's CDN to your disk. There is no
  server component and no telemetry.

## Requirements

- Chrome, Brave, Edge, or another Chromium browser (v116+)
- [Node.js](https://nodejs.org) 18 or newer
- A Meshy account you are signed into

## Install

### 1. Start the bridge

```bash
cd bridge
npm install
cp .env.example .env      # then edit STORAGE_DIR to taste
npm start
```

Leave it running. It listens on `http://localhost:19950` and only accepts
connections from your own machine.

### 2. Load the extension

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select the `extension/` folder

### 3. Configure

Open the extension's **Settings** (gear icon) and enter your Meshy username —
that's how it looks up who you follow. Everything else has working defaults.

## Usage

1. Sign in at [meshy.ai](https://www.meshy.ai) and leave a tab open.
2. Click the Asset Vault icon.
3. Choose sources (follows, subscriptions, your own models, or specific
   usernames) and formats.
4. **Start archive**.

Files land under your storage directory, organised per creator:

```
vault/
└── PICKTURA/
    ├── glb/         019f6396-…__The_Arcane_Cart_Merchant.glb
    ├── fbx/
    ├── animated/    019f670f-…__Hooded_Goblin_Outlaw__Walking.glb
    └── _manifest/   records.jsonl
```

## Scripted and scheduled runs

The bridge accepts a queued command, which the extension picks up within about
30 seconds. Useful for cron jobs or kicking off an archive without opening the
popup:

```bash
curl -X POST http://localhost:19950/api/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"start","options":{
        "includeFollowing":true,
        "includeSubscribed":true,
        "includeAnimations":true,
        "formats":["glb"]}}'
```

`{"action":"stop"}` halts a run the same way. The bridge binds to `127.0.0.1`
only, and a queued command can do nothing you could not do from the popup.

## How authentication works

Meshy's web app signs its API calls with a short-lived token that it rotates
roughly every 15 minutes. The extension observes the `Authorization` header on
requests the app is *already* making and keeps the newest one in memory.

That token is used for exactly two things: listing your follows, and asking Meshy
to sign a download URL. It is never written to disk, never synced, and never sent
anywhere except your own local bridge. Signed URLs stay valid for about a day
after they're minted, so a token expiring mid-run is harmless — the run pauses,
picks up the next token, and continues.

## Licensing and fair use

**This tool does not grant you rights to anything.** Every model on Meshy carries
a license set by its creator. Asset Vault records that license alongside every
file it writes, in `_manifest/records.jsonl` — check it before you use, remix, or
redistribute anything, and credit creators when their license asks you to.

Please also be considerate with concurrency settings. The defaults are
deliberately modest because every request is load on someone else's
infrastructure. Use this on accounts you have legitimate access to, and follow
[Meshy's Terms of Service](https://www.meshy.ai/terms).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Local bridge offline" | Start it: `cd bridge && npm start` |
| "No Meshy session yet" | Open meshy.ai in a tab and make sure you're signed in |
| Run pauses on "waiting for session" | Normal — a token rotated; it resumes on its own |
| FBX/OBJ crawl compared to GLB | Expected. Meshy converts those on demand, server-side |
| A few models are skipped | Not every model publishes every format; check the manifest |

## Development

```
extension/
├── manifest.json
├── background.js      orchestration, run state
├── lib/api.js         Meshy endpoints
├── lib/token.js       session capture
├── content.js         localStorage fallback
├── popup.*            main UI
└── options.*          settings
bridge/
└── server.js          download queue, validation, manifests
```

Load unpacked and hit reload on `chrome://extensions` after edits. The service
worker's console (**Inspect views → service worker**) is where run logs appear.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with, endorsed by, or sponsored by Meshy.
