#!/usr/bin/env python3
"""Build Chrome Web Store screenshots from the extension's real markup.

Loads the actual popup.html / options.html and popup.css, strips the script
tags (which need chrome.* APIs), injects representative state, and frames each
view on a 1280x800 canvas. What you see is the shipping UI, not a mockup.
"""
import re
from pathlib import Path

EXT = Path(r"C:\MoveWeight\meshy-asset-vault\extension")
OUT = Path(__file__).resolve().parent

CSS = (EXT / "popup.css").read_text(encoding="utf-8")


def body_of(html: str) -> str:
    body = re.search(r"<body[^>]*>(.*)</body>", html, re.S).group(1)
    return re.sub(r"<script.*?</script>", "", body, flags=re.S)


def inline_styles(html: str) -> str:
    """Pull any <style> block out of an options-style page head."""
    blocks = re.findall(r"<style>(.*?)</style>", html, re.S)
    return "\n".join(blocks)


popup_body = body_of((EXT / "popup.html").read_text(encoding="utf-8"))
options_html = (EXT / "options.html").read_text(encoding="utf-8")
options_body = body_of(options_html)
options_extra_css = inline_styles(options_html)

# Representative live state — these are the real figures from an actual run.
popup_body = popup_body.replace(
    '<span id="bridgeText">Checking local bridge…</span>',
    '<span id="bridgeText">Bridge connected · 3.9T free</span>'
).replace('id="bridgeStatus" class="banner banner--pending"',
          'id="bridgeStatus" class="banner banner--ok"')
popup_body = popup_body.replace(
    '<span id="tokenText">Waiting for Meshy session…</span>',
    '<span id="tokenText">Meshy session captured (11m left)</span>'
).replace('id="tokenStatus" class="banner banner--pending"',
          'id="tokenStatus" class="banner banner--ok"')
popup_body = popup_body.replace('<span id="phase" class="phase">idle</span>',
                                '<span id="phase" class="phase">resolving downloads</span>')
popup_body = popup_body.replace('<p id="sourceLine" class="source-line">No run in progress</p>',
                                '<p id="sourceLine" class="source-line">@-X-ScornGames — creator 1/3 · 1317 models</p>')
popup_body = popup_body.replace('<div id="progressBar" class="progress-bar"></div>',
                                '<div id="progressBar" class="progress-bar" style="width:82%"></div>')
for el_id, value in (("statModels", "1,317"), ("statResolved", "1,081"),
                     ("statClips", "84"), ("statFailed", "1")):
    popup_body = re.sub(rf'(id="{el_id}" class="stat-value">)0(<)', rf'\g<1>{value}\2', popup_body)
popup_body = popup_body.replace('<input type="text" id="usernames" placeholder="PICKTURA, someoneelse" />',
                                '<input type="text" id="usernames" value="PICKTURA" />')
popup_body = popup_body.replace('<button id="stop" class="button button--danger" disabled>',
                                '<button id="stop" class="button button--danger">')
popup_body = popup_body.replace('<button id="start" class="button button--primary">',
                                '<button id="start" class="button button--primary" disabled>')
# Show FBX selected alongside GLB so the format row reads clearly.
popup_body = popup_body.replace('<label class="chip"><input type="checkbox" value="fbx" /><span>FBX</span></label>',
                                '<label class="chip"><input type="checkbox" value="fbx" checked /><span>FBX</span></label>')

options_body = options_body.replace('<input type="text" id="downloadFolder" placeholder="MeshyAssetVault" />',
                                    '<input type="text" id="downloadFolder" value="MeshyAssetVault" />')
options_body = options_body.replace('<input type="radio" name="destination" id="destBrowser" value="browser" />',
                                    '<input type="radio" name="destination" id="destBrowser" value="browser" checked />')
options_body = options_body.replace('<div class="sub" id="bridgeOptions">', '<div class="sub" id="bridgeOptions" hidden>')
options_body = options_body.replace('<input type="number" id="resolveConcurrency" min="1" max="16" />',
                                    '<input type="number" id="resolveConcurrency" min="1" max="16" value="6" />')
options_body = options_body.replace('<input type="number" id="bridgeWorkers" min="1" max="16" />',
                                    '<input type="number" id="bridgeWorkers" min="1" max="16" value="4" />')

FRAME = """<!DOCTYPE html><html><head><meta charset="utf-8"><style>
{css}
{extra}
html,body{{width:1280px;height:800px;margin:0;padding:0;overflow:hidden;
  background:radial-gradient(1200px 600px at 50% -10%, #1b2233 0%, #0b0d12 60%);}}
.stage{{width:1280px;height:800px;display:flex;align-items:center;
  justify-content:center;gap:56px;padding:0 64px;box-sizing:border-box;}}
.copy{{max-width:430px;}}
.copy h2{{font:650 34px/1.2 system-ui,'Segoe UI',sans-serif;color:#e8ecf4;
  letter-spacing:-0.02em;margin-bottom:14px;}}
.copy h2 em{{color:#c5f955;font-style:normal;}}
.copy p{{font:400 16px/1.6 system-ui,'Segoe UI',sans-serif;color:#8a94a8;margin-bottom:10px;}}
.copy ul{{margin:18px 0 0 0;padding:0;list-style:none;}}
.copy li{{font:400 15px/1.5 system-ui,'Segoe UI',sans-serif;color:#c8cfdc;
  margin-bottom:9px;padding-left:24px;position:relative;}}
.copy li:before{{content:'';position:absolute;left:0;top:7px;width:8px;height:8px;
  border-radius:2px;background:linear-gradient(135deg,#c5f955,#7dd3fc);}}
.device{{border-radius:14px;overflow:hidden;flex:none;
  box-shadow:0 30px 70px rgba(0,0,0,.6),0 0 0 1px #262d3d;
  /* zoom (unlike transform) shrinks the laid-out box too, so the whole
     panel fits the 800px canvas instead of being clipped */
  zoom:{zoom};}}
.device>body,.panelwrap{{margin:0;}}
.panelwrap{{width:{w}px;background:#0b0d12;padding:14px;box-sizing:border-box;}}
</style></head><body><div class="stage">
<div class="copy">{copy}</div>
<div class="device"><div class="panelwrap">{content}</div></div>
</div></body></html>"""

POPUP_COPY = """
<h2>Archive your Meshy library <em>in one click</em></h2>
<p>Whole catalogues, the creators you follow, and rigged animation clips —
without clicking through a save dialog for every model.</p>
<ul>
  <li>Every published model, not just the first page</li>
  <li>Rigged animations saved as separate GLB clips</li>
  <li>GLB, FBX and OBJ in any combination</li>
  <li>Resumes where it left off</li>
</ul>"""

OPTIONS_COPY = """
<h2>Saves where <em>you</em> want it</h2>
<p>Downloads straight to your browser's own folder — no server, no setup,
works on any Chrome device.</p>
<ul>
  <li>Zero-setup browser downloads by default</li>
  <li>Optional local bridge for drives and NAS shares</li>
  <li>Files land under creator and format</li>
  <li>Nothing leaves your machine</li>
</ul>"""

(OUT / "shot-popup.html").write_text(
    FRAME.format(css=CSS, extra="", w=400, zoom="0.78", copy=POPUP_COPY, content=popup_body), encoding="utf-8")
(OUT / "shot-options.html").write_text(
    FRAME.format(css=CSS, extra=options_extra_css, w=560, zoom="0.72", copy=OPTIONS_COPY, content=options_body),
    encoding="utf-8")
print("wrote shot-popup.html and shot-options.html")
