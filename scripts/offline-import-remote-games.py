#!/usr/bin/env python3
"""Import complete game folders for supported external iframe launchers.

This runs in GitHub Actions so binary game assets can be downloaded and committed
without routing them through the text-only GitHub connector.
"""
from __future__ import annotations

import concurrent.futures
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path.cwd()
BRANCH = os.environ.get("GITHUB_REF_NAME", "html-error-audit-fixes-2026-11-10")
TOKEN = os.environ.get("GITHUB_TOKEN", "")
SKIP = {"20 Minutes Till Dawn", "Do-Not-Take-This-Cat-Home"}
MAX_GAMES = int(os.environ.get("OFFLINE_IMPORT_MAX_GAMES", "75"))
MAX_GAME_BYTES = int(os.environ.get("OFFLINE_IMPORT_MAX_GAME_BYTES", str(150 * 1024 * 1024)))
MAX_TOTAL_BYTES = int(os.environ.get("OFFLINE_IMPORT_MAX_TOTAL_BYTES", str(700 * 1024 * 1024)))
MAX_FILE_BYTES = 95 * 1024 * 1024
USER_AGENT = "hummingbird-9-offline-game-import/1.0"

def request_bytes(url: str, accept: str = "*/*") -> bytes:
    headers = {"User-Agent": USER_AGENT, "Accept": accept}
    if TOKEN and url.startswith("https://api.github.com/"):
        headers["Authorization"] = "Bearer " + TOKEN
        headers["X-GitHub-Api-Version"] = "2022-11-28"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=90) as response:
        return response.read()

def api_json(url: str):
    return json.loads(request_bytes(url, "application/vnd.github+json"))

def raw_url(repo: str, branch: str, path: str) -> str:
    encoded = "/".join(urllib.parse.quote(part, safe="") for part in path.split("/"))
    return "https://raw.githubusercontent.com/" + repo + "/" + urllib.parse.quote(branch, safe="") + "/" + encoded

def run_git(*args: str, check: bool = True):
    return subprocess.run(["git", *args], cwd=ROOT, check=check, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)

def find_iframe_src(text: str):
    return re.findall(r"<iframe\b[^>]*?\bsrc\s*=\s*(['\"])(.*?)\1",
                      text, flags=re.I | re.S)

def parse_supported_url(url: str):
    parsed = urllib.parse.urlparse(html.unescape(url))
    if parsed.scheme not in ("http", "https") or parsed.hostname != "freeonlinewebtools.github.io":
        return None
    parts = [urllib.parse.unquote(x) for x in parsed.path.split("/") if x]
    if len(parts) < 2 or not parts[0].endswith(".github.io"):
        return None
    repo = "freeonlinewebtools/" + parts[0]
    source_path = "/".join(parts[1:]).strip("/")
    if source_path.endswith(".html"):
        source_path = source_path.rsplit("/", 1)[0] if "/" in source_path else ""
    if not source_path:
        return None
    return repo, source_path

def sanitize_imported_files(target: Path, source_url: str):
    index = target / "index.html"
    if not index.exists():
        return
    text = index.read_text(encoding="utf-8", errors="replace")
    # Local replacement for the YouTube Playables host SDK: games retain local
    # save/audio/pause behavior, while ad and hosting callbacks become no-ops.
    if "youtube-playables" in text or "ytgame." in text:
        text = re.sub(
            r"<script\b[^>]*src=['\"][^'\"]*youtube-playables[^'\"]*['\"][^>]*>\s*</script>",
            '<script src="ytgame-offline.js"></script>', text, flags=re.I)
        shim = r'''(function () {
  "use strict";
  const noop = function () {};
  const callbacks = { audio: [], pause: [], resume: [] };
  const key = "hummingbird-offline-save";
  window.ytgame = {
    game: {
      firstFrameReady: noop, gameReady: noop,
      loadData: function () { return Promise.resolve(localStorage.getItem(key)); },
      saveData: function (value) { localStorage.setItem(key, value); return Promise.resolve(); }
    },
    system: {
      isAudioEnabled: function () { return true; },
      getLanguage: function () { return Promise.resolve(navigator.language || "en"); },
      onAudioEnabledChange: function (fn) { if (typeof fn === "function") callbacks.audio.push(fn); },
      onPause: function (fn) { if (typeof fn === "function") callbacks.pause.push(fn); },
      onResume: function (fn) { if (typeof fn === "function") callbacks.resume.push(fn); }
    },
    engagement: { sendScore: noop },
    health: { logError: noop, logWarning: noop },
    ads: { AdResult: { UNKNOWN: 0, SHOWED: 1, REJECTED: 3 }, requestAd: function () { return Promise.resolve(3); } }
  };
})();'''
        (target / "ytgame-offline.js").write_text(shim + "\n", encoding="utf-8")
        if "ytgame-offline.js" not in text:
            text = text.replace("</head>", '  <script src="ytgame-offline.js"></script>\n</head>')
    # Remove the two known non-game network SDK loaders from Famobi wrapper code.
    gi = target / "game-interface.js"
    if gi.exists():
        body = gi.read_text(encoding="utf-8", errors="replace")
        body = body.replace(
            'this.parent.helpers.loadFiles("//cdn.jsdelivr.net/npm/sweetalert2@11").then((function(){}))',
            "Promise.resolve()")
        body = body.replace(
            '"//download.gameanalytics.com/js/GameAnalytics-4.4.5.min.js"',
            '""')
        gi.write_text(body, encoding="utf-8")
    # Record provenance in a harmless HTML comment.
    if "offline-import-source:" not in text:
        text = text.replace("<html", "<!-- offline-import-source: " + source_url + " -->\n<html", 1)
    index.write_text(text, encoding="utf-8")

def runtime_external_refs(folder: Path):
    found = []
    attr_re = re.compile(r"\b(?:src|href|poster|action)\s*=\s*(['\"])(https?:)?//([^'\"]+)\1", re.I)
    css_re = re.compile(r"url\(\s*(['\"]?)(https?:)?//([^)'\"]+)\1\s*\)", re.I)
    for p in folder.rglob("*"):
        if not p.is_file() or p.suffix.lower() not in {".html", ".htm", ".js", ".mjs", ".css", ".json"}:
            continue
        try:
            data = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for m in attr_re.finditer(data):
            found.append({"file": str(p.relative_to(folder)), "url": (m.group(2) or "https:") + "//" + m.group(3)})
        for m in css_re.finditer(data):
            found.append({"file": str(p.relative_to(folder)), "url": (m.group(2) or "https:") + "//" + m.group(3)})
        # Runtime URL literals in JS are important; filter common documentation/credit links.
        if p.suffix.lower() in {".js", ".mjs"}:
            for m in re.finditer(r"(['\"])(https?:)?//([^'\"\s<>]+)\1", data):
                url = (m.group(2) or "https:") + "//" + m.group(3)
                if any(x in url.lower() for x in ("w3.org", "mozilla.org", "github.com", "opensource.org")):
                    continue
                found.append({"file": str(p.relative_to(folder)), "url": url})
    unique = {}
    for item in found:
        unique[(item["file"], item["url"])] = item
    return list(unique.values())[:100]

def main():
    # Only root-level game launchers are candidates; never touch backups or nested demos.
    candidates = []
    for index in sorted(ROOT.glob("*/index.html")):
        game = index.parent.name
        if game in SKIP:
            continue
        try:
            markup = index.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for _, src in find_iframe_src(markup):
            parsed = parse_supported_url(src)
            if parsed:
                repo, source_path = parsed
                candidates.append((game, repo, source_path, src))
                break

    print("Supported external iframe launchers found:", len(candidates))
    groups = {}
    for item in candidates:
        groups.setdefault(item[1], []).append(item)

    reports = []
    imported = 0
    total_downloaded = 0
    stop = False
    for repo, games in sorted(groups.items()):
        try:
            repo_meta = api_json("https://api.github.com/repos/" + repo)
            branch = repo_meta.get("default_branch") or "main"
            tree = api_json("https://api.github.com/repos/" + repo + "/git/trees/" +
                            urllib.parse.quote(branch, safe="") + "?recursive=1")
            if tree.get("truncated"):
                raise RuntimeError("source tree is truncated")
            blobs = [entry for entry in tree.get("tree", []) if entry.get("type") == "blob"]
        except Exception as exc:
            for game, _, source_path, src in games:
                reports.append({"game": game, "status": "source-repo-unavailable",
                                "repo": repo, "source_path": source_path, "error": str(exc)})
            continue

        path_lookup = {entry["path"].casefold(): entry["path"] for entry in blobs}
        for game, _, requested_path, src in games:
            if imported >= MAX_GAMES or total_downloaded >= MAX_TOTAL_BYTES:
                stop = True
                break
            source_path = requested_path
            # Resolve the source folder case-insensitively.
            exact_index = path_lookup.get((source_path.rstrip("/") + "/index.html").casefold())
            if not exact_index:
                # Some source URLs contain an extra directory component or point at index.html.
                alternatives = [p for p in path_lookup if p.endswith("/" + source_path.casefold().strip("/") + "/index.html")]
                if len(alternatives) == 1:
                    exact_index = path_lookup[alternatives[0]]
                    source_path = exact_index.rsplit("/", 1)[0]
            if not exact_index:
                reports.append({"game": game, "status": "source-folder-not-found",
                                "repo": repo, "source_path": requested_path, "source_url": src})
                continue
            source_path = exact_index.rsplit("/", 1)[0]
            prefix = source_path + "/"
            files = [e for e in blobs if e["path"].startswith(prefix)]
            total_size = sum(int(e.get("size", 0)) for e in files)
            if not files or total_size > MAX_GAME_BYTES or any(int(e.get("size", 0)) > MAX_FILE_BYTES for e in files):
                reports.append({"game": game, "status": "source-too-large-or-empty",
                                "repo": repo, "source_path": source_path,
                                "file_count": len(files), "bytes": total_size})
                continue

            target = ROOT / game
            try:
                # Expand this game folder from the blob-filtered sparse checkout.
                run_git("sparse-checkout", "add", "--no-cone", "/" + game + "/**", check=False)
            except Exception:
                pass

            def download_one(entry):
                rel = entry["path"][len(prefix):]
                if not rel or rel.startswith("../") or "/.git/" in rel or rel.startswith(".git/"):
                    return None
                dest = target / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                url = raw_url(repo, branch, entry["path"])
                data = request_bytes(url)
                if len(data) != int(entry.get("size", len(data))):
                    raise RuntimeError("size mismatch for " + entry["path"])
                dest.write_bytes(data)
                return (rel, len(data))

            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                    downloaded = list(pool.map(download_one, files))
                downloaded = [x for x in downloaded if x]
                sanitize_imported_files(target, src)
                remaining = runtime_external_refs(target)
                reports.append({"game": game, "status": "imported",
                                "repo": repo, "branch": branch, "source_path": source_path,
                                "source_url": src, "files": len(downloaded),
                                "bytes": sum(x[1] for x in downloaded),
                                "remaining_external_references": remaining})
                imported += 1
                total_downloaded += sum(x[1] for x in downloaded)
                print("Imported", game, "from", repo + "/" + source_path,
                      "files=", len(downloaded), "bytes=", sum(x[1] for x in downloaded),
                      "external_refs=", len(remaining))
            except Exception as exc:
                reports.append({"game": game, "status": "download-failed",
                                "repo": repo, "source_path": source_path, "error": str(exc)})
        if stop:
            break

    report = {
        "branch": BRANCH,
        "supported_host": "freeonlinewebtools.github.io",
        "found": len(candidates),
        "imported": imported,
        "downloaded_bytes": total_downloaded,
        "limits": {"max_games": MAX_GAMES, "max_game_bytes": MAX_GAME_BYTES,
                   "max_total_bytes": MAX_TOTAL_BYTES},
        "results": reports
    }
    (ROOT / "offline-import-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    changed = run_git("status", "--porcelain").stdout.strip()
    if changed:
        run_git("add", "-A")
        run_git("config", "user.name", "github-actions[bot]")
        run_git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
        run_git("commit", "-m", "Import local builds for externally embedded games")
        run_git("push", "origin", "HEAD:" + BRANCH)
        print("Committed imported local game builds and offline-import-report.json")
    else:
        print("No import changes to commit.")

if __name__ == "__main__":
    main()
