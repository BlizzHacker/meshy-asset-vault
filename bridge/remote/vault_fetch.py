#!/usr/bin/env python3
"""
Meshy Asset Vault — remote fetch worker.

Runs on the machine that owns the storage (NAS, server, homelab box). Reads the
newline-delimited records the bridge ships over SSH and downloads each signed URL
directly, so the bytes never round-trip through the browser machine.

The URLs are pre-signed and time-limited; no credentials are needed or used here.

Usage:
    vault_fetch.py <vault_root> [author] [--workers N]

Layout produced:
    <vault_root>/<author>/{glb,fbx,obj,animated}/<taskId>__<name>.<ext>
    <vault_root>/<author>/_manifest/{records.jsonl,downloaded.csv,fetch.log}
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

GLTF_MAGIC = b"glTF"
ZIP_MAGIC = b"PK\x03\x04"
USER_AGENT = "MeshyAssetVault/2.0 (remote fetch worker)"
MIN_BYTES = 256


def unwrap_zip(path: Path, want_ext: str) -> bool:
    """Meshy serves some models (notably stylized ones) as a ZIP containing the
    mesh rather than the bare file. Replace the archive with the model inside.
    Returns True if the file now holds the expected format."""
    import zipfile

    try:
        with zipfile.ZipFile(path) as archive:
            members = [
                m for m in archive.namelist()
                if m.lower().endswith(f".{want_ext}") and not m.endswith("/")
            ]
            if not members:
                return False
            # If several, take the largest — that is the mesh, not a LOD stub.
            member = max(members, key=lambda m: archive.getinfo(m).file_size)
            data = archive.read(member)
    except (zipfile.BadZipFile, OSError):
        return False

    if want_ext == "glb" and not data.startswith(GLTF_MAGIC):
        return False
    path.write_bytes(data)
    return True

lock = threading.Lock()
counts = {"downloaded": 0, "skipped": 0, "failed": 0, "bytes": 0}


def safe(value: str, limit: int = 80) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._ -]", "", str(value or "")).strip().replace(" ", "_")
    # Blank source names leave separator runs behind (e.g. "__Walking"); collapse
    # them so filenames stay readable when a creator leaves models untitled.
    cleaned = re.sub(r"_{2,}", "_", cleaned).strip("_-.")
    return cleaned[:limit] or "untitled"


def intact(path: Path, ext: str) -> bool:
    try:
        if path.stat().st_size < MIN_BYTES:
            return False
        if ext != "glb":
            return True
        with path.open("rb") as fh:
            return fh.read(4) == GLTF_MAGIC
    except OSError:
        return False


def destination(root: Path, record: dict) -> Path:
    author = safe(record.get("author") or "unknown", 48)
    ext = "glb" if record.get("kind") == "animated" else (record.get("format") or "glb")
    bucket = "animated" if record.get("kind") == "animated" else ext
    name = f"{record['id']}__{safe(record.get('name'))}.{ext}"
    return root / author / bucket / name


def fetch(record: dict, root: Path) -> str:
    target = destination(root, record)
    ext = target.suffix.lstrip(".")
    target.parent.mkdir(parents=True, exist_ok=True)

    if intact(target, ext):
        with lock:
            counts["skipped"] += 1
        return "skipped"

    partial = target.with_suffix(target.suffix + ".part")
    for attempt in range(4):
        try:
            request = urllib.request.Request(record["url"], headers={"User-Agent": USER_AGENT})
            size = 0
            with urllib.request.urlopen(request, timeout=300) as response, partial.open("wb") as out:
                while chunk := response.read(1 << 16):
                    out.write(chunk)
                    size += len(chunk)

            if not intact(partial, ext):
                # A ZIP-wrapped model is still a good asset; unwrap before failing.
                with partial.open("rb") as fh:
                    zipped = fh.read(4) == ZIP_MAGIC
                if not (zipped and unwrap_zip(partial, ext) and intact(partial, ext)):
                    partial.replace(target.with_suffix(target.suffix + ".bad"))
                    raise ValueError("failed validation")
                size = partial.stat().st_size

            partial.replace(target)
            with lock:
                counts["downloaded"] += 1
                counts["bytes"] += size
                manifest = root / safe(record.get("author") or "unknown", 48) / "_manifest"
                manifest.mkdir(parents=True, exist_ok=True)
                with (manifest / "downloaded.csv").open("a", encoding="utf-8") as log:
                    log.write(
                        f'{record["id"]},{target.name},{ext},{record.get("kind","model")},'
                        f'{record.get("license","unknown")},{record.get("author","")},{size}\n'
                    )
            return "downloaded"

        except Exception:
            partial.unlink(missing_ok=True)
            if attempt == 3:
                with lock:
                    counts["failed"] += 1
                return "failed"
            time.sleep(1.5 * (attempt + 1))
    return "failed"


def load_records(root: Path, author: str | None) -> list[dict]:
    manifests = (
        [root / author / "_manifest" / "records.jsonl"]
        if author
        else sorted(root.glob("*/_manifest/records.jsonl"))
    )

    seen: set[tuple] = set()
    records: list[dict] = []
    for manifest in manifests:
        if not manifest.exists():
            continue
        for line in manifest.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not record.get("id") or not record.get("url"):
                continue
            key = (record["id"], record.get("format"), record.get("kind"), record.get("name"))
            if key in seen:
                continue
            seen.add(key)
            records.append(record)
    return records


def main() -> int:
    parser = argparse.ArgumentParser(description="Download Meshy Asset Vault records.")
    parser.add_argument("root", help="vault root directory")
    parser.add_argument("author", nargs="?", default=None, help="limit to one creator")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    root = Path(args.root)
    root.mkdir(parents=True, exist_ok=True)

    records = load_records(root, args.author)
    print(f"records={len(records)} workers={args.workers} root={root}", flush=True)
    if not records:
        return 0

    started = time.time()
    done = 0

    def job(record: dict) -> None:
        nonlocal done
        fetch(record, root)
        with lock:
            done += 1
            if done % 50 == 0:
                rate = done / max(time.time() - started, 1e-6)
                print(
                    f"  {done}/{len(records)} ok={counts['downloaded']} "
                    f"skip={counts['skipped']} fail={counts['failed']} "
                    f"{counts['bytes'] / 1e9:.2f}GB {rate:.1f}/s",
                    flush=True,
                )

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        list(pool.map(job, records))

    print(
        f"DONE ok={counts['downloaded']} skipped={counts['skipped']} "
        f"failed={counts['failed']} total={counts['bytes'] / 1e9:.2f}GB",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
