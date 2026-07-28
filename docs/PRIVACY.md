# Privacy Policy — Meshy Asset Vault

_Last updated: 19 July 2026_

Meshy Asset Vault is a local tool. It has no backend, no analytics, and no
account system. The developer cannot see anything you do with it.

## What the extension accesses

**Your Meshy session token.** The extension reads the `Authorization` header from
requests the Meshy web app already sends to `api.meshy.ai`. This is how it asks
Meshy to sign download links on your behalf without you pasting credentials.

- Held in the service worker's memory only.
- Never written to disk, never placed in extension storage, never synced.
- Discarded when the browser closes or the extension reloads.
- Sent to exactly one destination: the bridge running on your own machine — and
  only when you have configured a remote storage host that requires it.

**Your settings.** Your Meshy username, bridge URL, chosen formats, and
concurrency values are kept in `chrome.storage.local` on your device.

**Model metadata.** Titles, IDs, licenses, and download URLs for the models you
choose to archive are passed to your local bridge so it can fetch and label them.

## What is transmitted, and where

| Destination | Data | Why |
| --- | --- | --- |
| `api.meshy.ai` | Your existing session token | List your follows; sign download URLs |
| `assets.meshy.ai` | Signed URL requests | Download the model files |
| `localhost` (your bridge) | Model metadata and signed URLs | Fetch files to your storage |

There are no other network destinations. No data is sent to the developer or to
any third party. There is no telemetry, crash reporting, or usage tracking.

## The local control channel

The bridge can hold a queued command (start or stop an archive) that the
extension polls for. This exists so runs can be scheduled or scripted. The
bridge listens on `127.0.0.1` only, so nothing outside your machine can reach
it, and a queued command can only do what you could already do from the popup.
No credentials pass through this channel.

## What is stored on your device

- Downloaded model files, in the storage directory you configure.
- A `records.jsonl` manifest per creator, recording each model's ID, name,
  format, and license.
- Your extension settings.

You can delete any of it at any time by removing the files or uninstalling the
extension. Uninstalling clears all extension storage.

## Permissions and why they exist

| Permission | Purpose |
| --- | --- |
| `webRequest` + `api.meshy.ai` host access | Read the session token from Meshy's own API calls. Requests are observed, never modified or blocked. |
| `www.meshy.ai` host access | Fallback session lookup, and refreshing a tab to obtain a fresh token. |
| `assets.meshy.ai` host access | Fetch the model files. |
| `downloads` | Save models to your Downloads folder in the default destination mode. Only files you asked to archive are downloaded. |
| `localhost` host access | Talk to the bridge you run, if you choose that destination. |
| `storage` | Remember your settings, and which files were already downloaded so re-runs can skip them. |
| `tabs` | Find or open a Meshy tab so the session can refresh. |
| `alarms` | Periodically refresh the session during a long run. |

The extension does not read page content, browsing history, cookies from other
sites, or any site other than Meshy.

## Content licensing

This tool does not grant rights to any model it downloads. Each model's license
is set by its creator and recorded in the manifest. You are responsible for
honouring those licenses and Meshy's Terms of Service.

## Contact

Questions or concerns: open an issue on the project's GitHub repository.
