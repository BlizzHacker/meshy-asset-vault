# Chrome Web Store listing

Copy for the developer dashboard, plus the answers required by the privacy tab.

---

## Name

Meshy Asset Vault

## Short description (132 char max)

Bulk-archive your Meshy 3D models — whole libraries, creators you follow, and rigged animations — to storage you control.

## Category

Developer Tools

## Detailed description

Meshy's web UI downloads one model at a time, through a save dialog, in one
format. If your library runs to hundreds or thousands of models, that isn't a
workflow.

Meshy Asset Vault turns archiving into a single action. Pick your sources, pick
your formats, and walk away.

WHAT IT DOES

• Archives every published model for a creator, not just the first page
• Archives everyone you follow or subscribe to in one run
• Pulls rigged animation clips — each action and its armature as separate GLB files
• Exports GLB, FBX and OBJ in any combination
• Resumes cleanly: re-running skips files already downloaded and verified
• Records each model's license alongside the file, so attribution is easy to honour

HOW IT WORKS

The extension uses the Meshy session you are already signed into. There are no
API keys to create and nothing to copy out of DevTools. It asks Meshy to sign a
download link for each model, then hands those links to a small bridge server you
run on your own machine, which fetches the files to a folder you choose.

Because the bridge runs locally, your models never pass through anyone else's
server. There is no cloud component, no account, and no telemetry.

SETUP

The bridge is a short Node.js script included in the open-source repository.
Install it with `npm install`, start it with `npm start`, and load the extension.
Full instructions are in the README.

IMPORTANT

This tool does not grant you rights to any model. Every model on Meshy carries a
license set by its creator; the extension records that license next to each file
so you can check it. Respect creators' rights and Meshy's Terms of Service, and
use it only with accounts you legitimately have access to.

Open source (MIT): https://github.com/BlizzHacker/meshy-asset-vault
Not affiliated with, endorsed by, or sponsored by Meshy.

---

## Privacy practices tab

**Single purpose**

Archive a user's own accessible Meshy 3D models, and those of creators they
follow, to local storage they control.

**Permission justifications**

| Permission | Justification |
| --- | --- |
| `webRequest` | Reads the Authorization header from requests the Meshy web app already sends to its own API, so the user does not have to extract a session token manually. Requests are observed only — never modified, redirected, or blocked. |
| `downloads` | Saves the selected 3D model files to the user's Downloads folder. This is the default destination and requires no additional software. Only URLs the user explicitly chose to archive are downloaded. |
| `storage` | Persists user preferences (chosen formats, sources, destination) and a record of which files were already downloaded, so repeat runs skip them. |
| `tabs` | Locates an open meshy.ai tab, or opens one, so the web app can refresh its own session during a long run. |
| `alarms` | Schedules periodic session refresh so multi-hour archives do not stall. |
| Host: `*.meshy.ai` | Required to list the user's models and follows, and to download model files. |
| Host: `localhost` | Sends download links to the bridge server the user runs on their own machine. |

**Remote code:** No. All logic ships in the package; nothing is fetched or eval'd
at runtime.

**Data usage disclosures**

- Personally identifiable information: **not collected**
- Authentication information: **not collected** — the session token is read from
  the user's own browser, kept in service-worker memory, and never transmitted to
  the developer or any third party
- Location, health, financial, personal communications, web history, user
  activity: **not collected**
- Website content: **not collected** — the extension reads no page content
- Data is not sold, not transferred to third parties, and not used for anything
  beyond the single purpose above

Privacy policy URL:
https://github.com/BlizzHacker/meshy-asset-vault/blob/main/docs/PRIVACY.md

---

## Assets checklist

- [x] Icon 128×128 — `extension/icons/icon128.png`
- [x] Small promo tile 440×280 — `docs/promo-440x280.png`
- [ ] Screenshots 1280×800 or 640×400 (at least one, up to five)
- [ ] Marquee promo tile 1400×560 (optional)

## Review notes

Reviewers need a signed-in Meshy account to exercise the download path. No other
software is required — the default destination is the browser's own download
manager. Suggested note for the "testing instructions" field:

> Requires a signed-in meshy.ai account (free). Sign in at meshy.ai, open the
> extension, enter any public creator handle under "Additional usernames" (for
> example: PICKTURA), and click "Start archive". Files download to
> Downloads/MeshyAssetVault/<creator>/glb/.
>
> The optional "Local bridge" destination is for users archiving to an external
> drive or NAS; it is a Node.js server from the open-source repository and is not
> needed to review the extension. Source:
> https://github.com/BlizzHacker/meshy-asset-vault
