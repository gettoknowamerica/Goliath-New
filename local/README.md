# Goliath Omni — Local Runtime

Everything in this folder runs on the Windows GPU box. No paid LLM, no third-party
cloud AI. The only external paid services that remain are **Twilio** (voice/SMS)
and **Resend** (email).

## Hardware reality (10 GB VRAM)

| Role | Model | Approx VRAM | Notes |
|---|---|---|---|
| Resident agent brain | `qwen2.5:7b` | ~5.5 GB | Routing, scoring, tagging, chat |
| Alternate workhorse | `llama3.1:8b` | ~6 GB | Better instruction following |
| Vision | `gemma3:4b` | ~3.5 GB | Thumbnails, frame picks |
| Long-form blogs | `gpt-oss:20b` | spills to RAM | **Overnight batch only** |
| Embeddings | `nomic-embed-text` | ~0.5 GB | Lead dedupe, story bank |
| Reasoning trace | `deepseek-r1:8b` | ~6 GB | Lead scoring "why" |

`gpt-oss:20b` is 13 GB and will NOT fit in 10 GB of VRAM. Ollama spills it to
system RAM and it runs at roughly 2–5 tok/sec. That is fine for 3 AM batch blog
writing and unusable for anything interactive. The router enforces this.

## GPU contention — read this before debugging "slowness"

ComfyUI (Flux / LTX Video) wants the whole card. If Ollama holds a model
resident, ComfyUI OOMs or crawls, and vice versa. `gpu/gpu_lock.py` is a single
file-based semaphore both sides must take. Render jobs take an EXCLUSIVE lease
and the router unloads Ollama models first (`keep_alive: 0`).

## Paths (verified 2026-08-15)

- ComfyUI lives at `F:\Mark Pires\ComfyUI` — **not** `F:\GoliathOmni\ComfyUI`.
- Media inbox is therefore `F:\Mark Pires\ComfyUI\input\Inbox`.
- Ollama models move to `F:\GoliathOmni\ollama-models` (see `scripts/move-ollama-to-F.ps1`).
- Video masters and renders stay on the 8 TB F: drive. Nothing writes to C:.

## Start order

```
F:\GoliathOmni\local\scripts\start-goliath.bat
```

Brings up, in order: Ollama health check → media receiver (8787) → media watcher
→ app on port 3000 → two cloudflared quick tunnels. Prints both tunnel URLs at
the end. Mission Control is then at http://localhost:3000/mission-control/

## Pipeline

```
Upload → receiver → F:\...\input\Inbox
  → watcher (stable-size detect)
  → whisperX + pyannote  (diarized, word-level transcript)
  → silero-vad           (dead-air map)
  → demucs               (strip wind/street noise from doorknock audio)
  → qwen2.5:7b           (pick clips, write titles/tags/chapters)
  → gpt-oss:20b          (long-form blog, overnight)
  → ffmpeg + sam2        (episode + 9:16 shorts with subject tracking)
  → MySQL (system of record) → public_html/blogs/ PHP renders
```

## Hard rules encoded in code, not policy

- `email/jessica_gate.php` refuses any send without an owner-approved body hash
  in MySQL. There is no env flag and no override parameter.
- Every enrichment value carries a source URL or it is discarded.
- DNC list is re-checked per send, not just at import.
