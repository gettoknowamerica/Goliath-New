# Local Deployment Plan — LeadForge / Mission Control on the owner's home PC

## Architecture

- Windows 10/11 home PC (RTX 3080, 10 GB VRAM) runs:
  - the app (Bun + TanStack Start, port 3000) under base path /mission-control
  - Ollama (localhost:11434) as the local AI brain — 8B-class default model
  - cloudflared named tunnel (leadforge-home) → mission-control.markpires.com
- Cloudflare DNS routes the public hostname through the named tunnel (stable URL).
- Local storage: SQLite (`.data/leads.db`) + uploaded files on the home disk —
  no cloud database, no cloud bills, data stays on the owner's machine.
- cto.new preview remains untouched (it serves the root-mode build as today).

## Cost table (honest)

| Item | Cloud-hosted (today) | Local (this kit) |
|---|---|---|
| App server | platform hosting | $0 (home PC) |
| Database | hosted SQLite/MySQL | $0 (local file) |
| AI brain | API fees | $0 (Ollama, local GPU) |
| Public URL | platform subdomain | $0 (Cloudflare free plan, named tunnel) |
| Electricity | - | a few $/month (PC always on) |
| Uptime SLA | platform-grade | depends on home power/ISP — no SLA |

## Cloud dependence after migration

- DNS + tunnel control plane: Cloudflare (free) — required for the public URL.
- Git/GitHub: only for pulling updates.
- Email (Resend), enrichment (Firecrawl/DDG), Twilio: optional integrations,
  still external by design — the CORE app (dashboard, leads, scoring, call lists,
  auth, content) runs fully local.
- No hosting bill. No database bill. No AI API bill.

## Base-path mode notes

- `APP_BASE_PATH` is baked at BUILD time into client + server bundles
  (TanStack Start v1.158 plugin `router.basepath`). Changing it requires a rebuild.
- Default (`/`) == exactly today's behavior; `/mission-control` == local deployment.
- serve.ts reads the same env at runtime for root→prefix redirects, /api passthrough
  at root, and the auth gate under the prefix. Verified locally:
  /mission-control/login → 200, / → 302 to /mission-control/, /api/ai/health → 200.

## Rollout steps

1. Owner runs install-local.ps1 (or follows README section 2).
2. Owner edits .env (ADMIN_INITIAL_PASSWORD, SESSION_SECRET, LEADFORGE_SITE_URL).
3. Owner creates the named tunnel + DNS route (README section 5) once.
4. Owner schedules start-local.ps1 at boot (README section 6).
5. Verify: login at /mission-control, /api/ai/health shows ollamaReachable:true.
6. Optional: Cloudflare Origin Rule to serve under markpires.com/mission-control.
