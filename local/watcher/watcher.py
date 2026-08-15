"""Media inbox watcher.

Watches the ComfyUI input inbox on F:, waits for a multi-GB upload to finish
landing (size stable across three polls), then hands the file to the pipeline.

There is no repo to clone for this — it is watchdog plus a stability check.
    F:\\GoliathOmni\\venv\\Scripts\\pip install watchdog

Run:
    F:\\GoliathOmni\\venv\\Scripts\\python.exe watcher.py

Also exposes GET /health and POST /kick on 8788 so n8n and Mission Control can
see queue depth and re-trigger a file by hand.
"""

import json
import os
import queue
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "llm"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "gpu"))

from watchdog.events import FileSystemEventHandler  # noqa: E402
from watchdog.observers import Observer  # noqa: E402

import pipeline  # noqa: E402

INBOX = Path(os.environ.get("MEDIA_INBOX", r"F:\Mark Pires\ComfyUI\input\Inbox"))
STATE = Path(os.environ.get("MEDIA_WORK", r"F:\GoliathOmni\media\work")) / "state"
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".m4v", ".avi", ".mts", ".mxf"}
WATCH_PORT = 8788

WORK = queue.Queue()
SEEN = set()
STATUS = {"queued": 0, "active": None, "done": [], "failed": []}


def stable(path: Path, checks: int = 3, gap: float = 5.0) -> bool:
    """A 4K upload arrives in 8 MB chunks; do not touch it until it stops growing."""
    last = -1
    for _ in range(checks):
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            return False
        if size == last and size > 0:
            return True
        last = size
        time.sleep(gap)
    return path.stat().st_size == last


def enqueue(path: Path):
    if path.suffix.lower() not in VIDEO_EXT:
        return
    key = str(path).lower()
    if key in SEEN:
        return
    marker = STATE / (path.stem + ".done")
    if marker.exists():
        return
    SEEN.add(key)
    WORK.put(path)
    STATUS["queued"] = WORK.qsize()
    print(f"[watch] queued {path.name}")


class Handler(FileSystemEventHandler):
    def on_created(self, event):
        if not event.is_directory:
            enqueue(Path(event.src_path))

    def on_moved(self, event):
        if not event.is_directory:
            enqueue(Path(event.dest_path))


def worker():
    while True:
        path = WORK.get()
        STATUS["queued"] = WORK.qsize()
        STATUS["active"] = path.name
        try:
            if not stable(path):
                print(f"[watch] {path.name} never stabilised — requeued")
                SEEN.discard(str(path).lower())
                WORK.put(path)
                continue
            print(f"[watch] processing {path.name}")
            result = pipeline.run(path)
            STATE.mkdir(parents=True, exist_ok=True)
            (STATE / (path.stem + ".done")).write_text(
                json.dumps(result, indent=2, default=str), encoding="utf-8")
            STATUS["done"].append(path.name)
        except Exception as e:
            print(f"[watch] FAILED {path.name}: {e}")
            STATUS["failed"].append({"file": path.name, "error": str(e)})
        finally:
            STATUS["active"] = None
            WORK.task_done()


class Api(BaseHTTPRequestHandler):
    def _send(self, obj, code=200):
        body = json.dumps(obj, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send({"ok": True, "inbox": str(INBOX), **STATUS})
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        if self.path.startswith("/kick"):
            n = 0
            for f in INBOX.glob("*"):
                if f.is_file():
                    enqueue(f)
                    n += 1
            self._send({"ok": True, "scanned": n, "queued": WORK.qsize()})
        else:
            self._send({"error": "not found"}, 404)

    def log_message(self, *a):
        pass


def main():
    INBOX.mkdir(parents=True, exist_ok=True)
    STATE.mkdir(parents=True, exist_ok=True)
    print(f"[watch] inbox = {INBOX}")

    for f in INBOX.glob("*"):
        if f.is_file():
            enqueue(f)

    threading.Thread(target=worker, daemon=True).start()

    obs = Observer()
    obs.schedule(Handler(), str(INBOX), recursive=False)
    obs.start()

    srv = HTTPServer(("0.0.0.0", WATCH_PORT), Api)
    print(f"[watch] api on 0.0.0.0:{WATCH_PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        obs.stop()
        obs.join()


if __name__ == "__main__":
    main()
