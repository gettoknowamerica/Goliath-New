# LeadForge / Mission Control — Local Home Deployment Kit

Run the entire LeadForge / Mission Control build on **your own Windows PC** — 24/7,
zero cloud bills, with Ollama as the local AI brain. This kit wires everything so
you can install, start, and update the app yourself.

**What you get when it's running:**

- The full app (dashboard, leads, enrichment, content, call lists, auth) at
  **https://markpires.com/mission-control** — served from YOUR machine through a
  Cloudflare named tunnel (no cloud hosting needed).
- A local AI connection layer: `GET /api/ai/health` shows whether Ollama is
  reachable and which model is loaded. All future local-AI features plug into it.
- The cto.new preview site is NOT needed at home. Your tunnel domain is the
  single public surface.

---

## 1. What you need to install (one time)

| Tool | Why | Where |
|---|---|---|
| **Git** | clone/update the code | https://git-scm.com/download/win |
| **Bun** | runs the app (bundles JS + serves) | `powershell -c "irm bun.sh/install.ps1 | iex"` |
| **Node.js LTS** | Bun's runtime peer for some tooling | https://nodejs.org (LTS, default options) |
| **Ollama** | local AI brain (the model runs on your GPU) | https://ollama.com/download/windows |
| **cloudflared** | exposes your PC as markpires.com/mission-control | https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ |
| **ffmpeg** *(optional)* | video/media processing features | https://www.gyan.dev/ffmpeg/builds/ (add to PATH) |
| **yt-dlp** *(optional)* | YouTube download pipeline | `winget install yt-dlp.yt-dlp` |

Your PC: **Windows 10/11, RTX 3080 (10 GB VRAM)** is plenty for the 8B-class
model this app defaults to.

---

## 2. Install the app (step by step)

```powershell
# 1) Clone the repo (the whole build lives here)
cd C:\
git clone https://github.com/gettoknowamerica/Goliath-New.git
cd Goliath-New

# 2) Install dependencies
bun install

# 3) Create your environment file from the template
Copy-Item .env.example .env
notepad .env          # fill in the values — see "The .env file" below

# 4) Build the app (this bakes /mission-control into the router — REQUIRED)
$env:APP_BASE_PATH = "/mission-control"
bun run build

# 5) Start it (keep this window open the first time)
$env:APP_BASE_PATH = "/mission-control"
bun run serve.ts
```

You should see `team-site serving on http://0.0.0.0:3000 (base path /mission-control)`.
Test locally: open **http://localhost:3000/mission-control/login** — you'll get the
login page. Log in with **mark@markpires.com** and the password you set in `.env`
(`ADMIN_INITIAL_PASSWORD` — the first login forces you to create a final password).

> Changing `APP_BASE_PATH` requires a **rebuild** (step 4) — it's baked into the
> client + server bundles at build time. The `.ps1` scripts below do this for you.

---

## 3. The .env file

Everything is optional unless marked REQUIRED. Copy `.env.example` → `.env` and
edit. Key ones:

```ini
# --- REQUIRED ---
ADMIN_INITIAL_PASSWORD=choose-a-strong-one
SESSION_SECRET=choose-a-long-random-string
LEADFORGE_SITE_URL=https://markpires.com

# --- Routing (already correct for this kit — leave as-is) ---
APP_BASE_PATH=/mission-control

# --- Local AI brain (Ollama on this PC) ---
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b

# --- Optional integrations (leave blank to disable) ---
# RESEND_API_KEY=...          # AI initial email + drip
# FIRECRAWL_API_KEY=...       # page scraping enrichment
# TWILIO_ACCOUNT_SID=...      # phone call lists
```

**Never commit `.env`** — it's git-ignored. Only `.env.example` is in the repo.

---

## 4. Ollama — the local brain

```powershell
# install Ollama, then pull the default model (8B-class — fits the RTX 3080's 10 GB)
ollama pull llama3.1:8b

# verify the app can see it
curl http://localhost:3000/api/ai/health
# → {"ollamaReachable":true,"models":["llama3.1:8b"],"model":"llama3.1:8b",...}
```

**Honest notes on models (do not trust vendor benchmarks as verified):**

- **llama3.1:8b (default)** — runs comfortably on the 10 GB RTX 3080. Fast,
  good enough for drafts/summaries.
- **Meta Muse Glimmer 30B (Q4, ~18 GB)** — the plan calls it the primary local
  model, but **18 GB does NOT fit in 10 GB VRAM**. On this card it would spill to
  system RAM and be very slow. Keep it as an option for a bigger machine, or run
  it CPU-only with patience. Set `OLLAMA_MODEL=muse-glimmer` if you pull it.
- OOM (model won't load / crashes)? Swap to a smaller model: `ollama pull llama3.2:3b`
  then set `OLLAMA_MODEL=llama3.2:3b` in `.env` and restart.

---

## 5. Expose it: Cloudflare named tunnel (one-time)

markpires.com already runs on Cloudflare DNS, so a **named tunnel** gives you a
stable URL (unlike quick tunnels, this one survives restarts).

```powershell
# login + create the tunnel (one time)
cloudflared tunnel login
cloudflared tunnel create leadforge-home

# route your domain — you must do this from a Cloudflare dashboard account that
# owns markpires.com (a certificate/dashboard login may be needed):
cloudflared tunnel route dns leadforge-home mission-control.markpires.com
#   → creates CNAME mission-control → <tunnel-id>.cfargotunnel.com

# run it (the start-local.ps1 script does this automatically in background)
cloudflared tunnel run leadforge-home
```

> If you want the app at **markpires.com/mission-control** (instead of a
> subdomain), add a Cloudflare **Origin Rules** rewrite on the dashboard:
> `Host == markpires.com` and path starts with `/mission-control` → rewrite to
> `mission-control.markpires.com` (keep the path). The subdomain setup alone
> already works for day one.

---

## 6. Auto-start on boot (so it's always on)

Use **Task Scheduler** (no extra software):

1. `Win+R` → `taskschd.msc` → Create Task.
2. General: name `LeadForge`, check *Run whether user is logged on or not*.
3. Triggers: *At startup*.
4. Actions: *Start a program* → Program: `powershell.exe`, Arguments:
   `-ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Goliath-New\start-local.ps1`
5. Settings: check *Run task as soon as possible after a scheduled start*.

`start-local.ps1` starts **both** the app server AND the cloudflared tunnel, and
restarts them if they die.

---

## 7. Update the app

```powershell
cd C:\Goliath-New
git pull
bun install
Copy-Item .env.example .env -Force   # only if you want the new defaults; your .env is kept
bun run build                        # APP_BASE_PATH is read from .env by the script
bun run serve.ts                     # or just run start-local.ps1
```

---

## 8. Verify it's healthy

- `http://localhost:3000/mission-control/login` → login page (local check)
- `https://mission-control.markpires.com/mission-control/login` → same page over the tunnel
- `curl https://mission-control.markpires.com/api/ai/health` → `ollamaReachable:true`
- Log in, land on the dashboard, change your password on first login.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `Port 3000 already in use` | Something else owns 3000. `netstat -ano \| findstr :3000`, kill that PID, restart. |
| Tunnel URL works locally but not publicly | `cloudflared tunnel list` — is it running? Restart via `start-local.ps1`. Check the CNAME exists: `nslookup mission-control.markpires.com`. |
| `/api/ai/health` says `ollamaReachable:false` | Is Ollama running? `ollama list`. Is `OLLAMA_BASE_URL` correct? |
| Login page loads but login fails | You must use the `ADMIN_INITIAL_PASSWORD` from `.env` on FIRST login, then set a final password. |
| Pages 404 / app looks unstyled after pulling | You changed `APP_BASE_PATH` without rebuilding, or the build was skipped. Run `bun run build` with `APP_BASE_PATH=/mission-control`. |
| Ollama model won't load (OOM) | Use a smaller model (`llama3.2:3b`) — see section 4. |
| Everything worked, then stopped after reboot | Task Scheduler task not set (section 6), or it ran as a user who isn't logged in without the right option. |

**Honest expectations:**

- Home PC uptime = app uptime. A power cut takes the app down until the PC boots
  again and the scheduled task fires.
- Ollama inference on a 10 GB card is fine for 8B-class models; don't expect
  frontier-quality output from the local brain — it's the free always-on
  workhorse, not the flagship writer.
- The cto.new preview is not used at home and can be left as-is.
