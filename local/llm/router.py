"""Goliath LLM router — the single point every agent calls.

One function in, right local model out. This is also the surgical point where
third-party LLM calls were removed: change this file and every executive
(Goliath, Scout, Jessica, Shakespeare, Einstein, Columbo) moves at once.

VRAM discipline for a 10 GB card:
  - only ONE model is resident at a time
  - long-form (gpt-oss:20b, 13 GB) spills to system RAM, so it is restricted to
    the overnight window and always takes the GPU lock in SHARED mode
  - any caller can force unload with keep_alive=0 before a ComfyUI render
"""

import json
import os
import time
import urllib.request
from datetime import datetime

from gpu_lock import GpuLock  # noqa: E402  (sibling module, added to path by caller)

OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")

TASKS = {
    # task              model env var        max VRAM tier
    "route":            ("MODEL_FAST",      "fast"),
    "classify":         ("MODEL_FAST",      "fast"),
    "tag":              ("MODEL_FAST",      "fast"),
    "chat":             ("MODEL_FAST",      "fast"),
    "clip_select":      ("MODEL_FAST",      "fast"),
    "title":            ("MODEL_FAST",      "fast"),
    "chapters":         ("MODEL_FAST",      "fast"),
    "score_lead":       ("MODEL_REASON",    "fast"),
    "vision":           ("MODEL_VISION",    "fast"),
    "embed":            ("MODEL_EMBED",     "tiny"),
    "blog":             ("MODEL_LONGFORM",  "batch"),
    "longform":         ("MODEL_LONGFORM",  "batch"),
}

DEFAULTS = {
    "MODEL_FAST": "qwen2.5:7b",
    "MODEL_ALT": "llama3.1:8b",
    "MODEL_VISION": "gemma3:4b",
    "MODEL_LONGFORM": "gpt-oss:20b",
    "MODEL_EMBED": "nomic-embed-text",
    "MODEL_REASON": "deepseek-r1:8b",
}


def _model_for(task: str):
    env_key, tier = TASKS.get(task, ("MODEL_FAST", "fast"))
    return os.environ.get(env_key, DEFAULTS[env_key]), tier


def _in_batch_window() -> bool:
    start = int(os.environ.get("LONGFORM_WINDOW_START", 23))
    end = int(os.environ.get("LONGFORM_WINDOW_END", 7))
    h = datetime.now().hour
    return h >= start or h < end if start > end else start <= h < end


def _post(path: str, payload: dict, timeout: int = 1800) -> dict:
    req = urllib.request.Request(
        OLLAMA + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def unload_all():
    """Free VRAM before a ComfyUI render. Call this from the render wrapper."""
    for key in ("MODEL_FAST", "MODEL_ALT", "MODEL_VISION", "MODEL_LONGFORM",
                "MODEL_REASON"):
        model = os.environ.get(key, DEFAULTS[key])
        try:
            _post("/api/generate", {"model": model, "keep_alive": 0}, timeout=30)
        except Exception:
            pass


def ask(task: str, prompt: str, system: str = "", images=None,
        json_mode: bool = False, force_batch: bool = False) -> str:
    """Primary entry point. `task` picks the model; callers never name models."""
    model, tier = _model_for(task)

    if tier == "batch" and not _in_batch_window() and not force_batch:
        # Long-form asked for during the day: degrade honestly rather than
        # locking the box up for twenty minutes.
        model = os.environ.get("MODEL_ALT", DEFAULTS["MODEL_ALT"])

    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "keep_alive": "5m" if tier == "fast" else 0,
    }
    if system:
        payload["system"] = system
    if images:
        payload["images"] = images
    if json_mode:
        payload["format"] = "json"

    with GpuLock(holder=f"llm:{task}", mode="shared"):
        started = time.time()
        out = _post("/api/generate", payload)

    print(f"[llm] task={task} model={model} {time.time() - started:.1f}s")
    return out.get("response", "")


def embed(text: str):
    model = os.environ.get("MODEL_EMBED", DEFAULTS["MODEL_EMBED"])
    out = _post("/api/embeddings", {"model": model, "prompt": text}, timeout=120)
    return out.get("embedding", [])


def health() -> dict:
    try:
        with urllib.request.urlopen(OLLAMA + "/api/tags", timeout=5) as r:
            tags = json.loads(r.read().decode("utf-8"))
        installed = sorted(m["name"] for m in tags.get("models", []))
        wanted = {k: os.environ.get(k, v) for k, v in DEFAULTS.items()}
        missing = [m for m in wanted.values() if m not in installed]
        return {"ok": True, "installed": installed, "missing": missing}
    except Exception as e:
        return {"ok": False, "error": str(e)}


if __name__ == "__main__":
    print(json.dumps(health(), indent=2))
