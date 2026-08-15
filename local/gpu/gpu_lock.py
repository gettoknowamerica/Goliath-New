"""Single-GPU semaphore.

Ollama and ComfyUI both want the whole 10 GB card. Without this, a Flux render
and a resident 7B model fight, everything thrashes, and it looks like the build
is broken when it is only oversubscribed.

Usage:
    from gpu_lock import GpuLock
    with GpuLock(holder="comfy:flux", mode="exclusive"):
        run_render()

Exclusive leases unload Ollama models first. Shared leases queue behind an
exclusive one. Stale leases (dead PID or past TTL) are reclaimed automatically.
"""

import json
import os
import time

LOCK = os.environ.get("GPU_LOCK_FILE", r"F:\GoliathOmni\runtime\gpu.lock")
DEFAULT_TTL = 3600


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    except Exception:
        return True
    return True


def _read():
    try:
        with open(LOCK, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write(rec):
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    tmp = LOCK + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rec, f)
    os.replace(tmp, LOCK)


def _clear():
    try:
        os.remove(LOCK)
    except FileNotFoundError:
        pass


def current():
    rec = _read()
    if not rec:
        return None
    if time.time() > rec.get("expires", 0):
        _clear()
        return None
    if not _pid_alive(rec.get("pid", -1)):
        _clear()
        return None
    return rec


class GpuLock:
    def __init__(self, holder: str, mode: str = "shared", ttl: int = DEFAULT_TTL,
                 wait: int = 1800):
        self.holder = holder
        self.mode = mode
        self.ttl = ttl
        self.wait = wait
        self.acquired = False

    def __enter__(self):
        deadline = time.time() + self.wait
        while time.time() < deadline:
            held = current()
            if held is None or (held["mode"] == "shared" and self.mode == "shared"):
                if self.mode == "exclusive":
                    self._free_ollama()
                _write({
                    "holder": self.holder,
                    "mode": self.mode,
                    "pid": os.getpid(),
                    "since": time.time(),
                    "expires": time.time() + self.ttl,
                })
                self.acquired = True
                return self
            time.sleep(2)
        raise TimeoutError(f"GPU lock held by {current()} — {self.holder} gave up")

    def __exit__(self, *exc):
        if self.acquired:
            rec = _read()
            if rec and rec.get("pid") == os.getpid():
                _clear()
        return False

    @staticmethod
    def _free_ollama():
        try:
            import sys
            sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "llm"))
            import router
            router.unload_all()
            time.sleep(3)
        except Exception as e:
            print(f"[gpu] could not unload ollama: {e}")


if __name__ == "__main__":
    print(json.dumps(current() or {"state": "free"}, indent=2, default=str))
