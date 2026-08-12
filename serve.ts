// Production server for the built site. The TanStack Start build emits a portable
// fetch handler (dist/server/server.js) plus static client assets (dist/client);
// this wraps them in a Bun server on port 3000 — static files first, SSR for the
// rest. Run `bun run build` before starting. Restart it with `bun run publish`.
//
// Starting a new instance supersedes the old one: it frees the port no matter
// which user owns the current server (provisioning starts it as `engine`; a team
// member's `bun run publish` runs as their own user), so publish never collides
// with an already-running server. Every sandbox user has passwordless sudo, so
// the takeover works across user boundaries.
//
// APP_BASE_PATH (runtime env, default "/"):
//   "/" (default)            — everything serves at the root exactly as before
//                              (this is what the cto.new preview keeps running).
//   "/mission-control"       — the whole app surface lives under that prefix
//                              (the local home deployment behind
//                              https://markpires.com/mission-control). Root "/"
//                              redirects into the prefix; root-level /api/*,
//                              /assets/* and static files keep working so
//                              webhooks, emails and SEO export pages stay put.
//   The TanStack router is built with the same basepath (see src/router.tsx);
//   its own basepath rewrite strips the prefix for route matching and adds it
//   to client-side links. We also inject window.__LF_BASE_PATH__ into SSR HTML
//   so the hydrated client router knows the prefix.
import handler from "./dist/server/server.js";
import { getUserFromRequest } from "./src/auth.ts";
// Page routes that require a valid session (signed httpOnly cookie). Anything
// not listed stays public — notably /login, /change-password's form endpoint is
// API-level, /exports/* (SEO content pages, served as static files below), and
// the public API surface (/api/auth/*, /api/unsubscribe, /api/webhooks/*,
// /api/content/$id/export). Add future protected pages to this list.
const PROTECTED_PAGES = new Set(["/", "/change-password"]);
// Pinned, NOT read from the environment. The published preview URL
// (<label>.<PUBLIC_SITE_DOMAIN>) is reverse-proxied to 0.0.0.0:3000 inside the
// sandbox, so the default site MUST bind there. Bun auto-loads .env files, so
// honouring process.env.PORT/HOST would let a stray env var or a .env in the site
// dir silently move the site off :3000 (or onto loopback) and break the public URL.
const PORT = 3000;
const HOST = "0.0.0.0";
const CLIENT_DIR = `${import.meta.dir}/dist/client`;

// --- Base path resolution ----------------------------------------------------
const RAW_BASE = (process.env.APP_BASE_PATH || "/").trim();
const BASE =
  !RAW_BASE || RAW_BASE === "/"
    ? ""
    : "/" + RAW_BASE.replace(/^\/+|\/+$/g, "");
const handlerFetch = handler as { fetch: (r: Request) => Response | Promise<Response> };

function isUnderBase(pathname: string): boolean {
  return BASE !== "" && (pathname === BASE || pathname.startsWith(BASE + "/"));
}

function stripBase(pathname: string): string {
  return isUnderBase(pathname) ? pathname.slice(BASE.length) || "/" : pathname;
}

/** Serve the app for a request. In basepath mode we inject __LF_BASE_PATH__ into
 *  SSR HTML so the client router hydrates with the same prefix. */
async function appFetch(req: Request, injectBase: boolean): Promise<Response> {
  const res = await handlerFetch.fetch(req);
  if (!injectBase || BASE === "") return res;
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return res;
  const html = await res.text();
  const script = `<script>window.__LF_BASE_PATH__=${JSON.stringify(BASE)}</script>`;
  const out = html.includes("<head>")
    ? html.replace("<head>", `<head>${script}`)
    : script + html;
  return new Response(out, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

async function serveStaticOrHandler(pathname: string, req: Request): Promise<Response> {
  if (pathname !== "/") {
    // Directory index: /epk-hero/ → serve /epk-hero/index.html if present.
    if (pathname.endsWith("/")) {
      const index = Bun.file(CLIENT_DIR + pathname + "index.html");
      if (await index.exists()) return new Response(index);
    }
    const file = Bun.file(CLIENT_DIR + pathname);
    if (await file.exists()) return new Response(file);
  }
  return appFetch(req, false);
}

// Free PORT regardless of which user owns the current listener. lsof runs under
// sudo so it can see (and the kill can signal) a process owned by another user;
// the loop waits for the socket to actually release before we bind.
const freePort =
  `for _ in $(seq 1 25); do ` +
  `pids=$(lsof -t -iTCP:${String(PORT)} -sTCP:LISTEN 2>/dev/null || true); ` +
  `if [ -z "$pids" ]; then exit 0; fi; ` +
  `kill $pids 2>/dev/null || true; sleep 0.2; ` +
  `done`;
// Take over the port, re-freeing and retrying if another publish grabbed it in the
// gap between freeing and binding (last publish wins). Bun.serve throws EADDRINUSE
// synchronously, so without this a raced publish would die while the shell already
// reported success.
for (let attempt = 1; ; attempt++) {
  await Bun.$`sudo sh -c ${freePort}`.quiet().nothrow();
  try {
    Bun.serve({
      port: PORT,
      hostname: HOST,
      async fetch(req) {
        const { pathname } = new URL(req.url);

        // Root mode (APP_BASE_PATH unset or "/") — exactly today's behavior.
        if (BASE === "") {
          if (PROTECTED_PAGES.has(pathname) && !getUserFromRequest(req)) {
            return new Response(null, {
              status: 302,
              headers: { Location: "/login" },
            });
          }
          return serveStaticOrHandler(pathname, req);
        }

        // Basepath mode (/mission-control):
        // 1. Domain root → redirect into the prefixed app.
        if (pathname === "/") {
          return new Response(null, {
            status: 302,
            headers: { Location: BASE + "/" },
          });
        }
        // 2. Root-level API/webhooks keep working at the root (Resend webhooks,
        //    unsubscribe links in emails, content export links, auth endpoints).
        if (pathname.startsWith("/api/")) {
          return appFetch(req, false);
        }
        // 3. Root-level static assets the SSR HTML references (/assets/*,
        //    /exports/*, /downloads/*, favicon …).
        if (pathname.endsWith("/")) {
          const index = Bun.file(CLIENT_DIR + pathname + "index.html");
          if (await index.exists()) return new Response(index);
        }
        const staticFile = Bun.file(CLIENT_DIR + pathname);
        if (pathname !== "/" && (await staticFile.exists())) {
          return new Response(staticFile);
        }
        // 4. App page requested outside the prefix (e.g. the client's
        //    window.location.replace("/login")) → redirect into the prefixed app.
        if (!isUnderBase(pathname)) {
          return new Response(null, {
            status: 302,
            headers: { Location: BASE + pathname },
          });
        }
        // 5. Under the prefix: auth gate, then static, then the app handler
        //    (original URL is passed through — the router's basepath rewrite
        //    strips the prefix for route matching).
        const inner = stripBase(pathname);
        if (PROTECTED_PAGES.has(inner) && !getUserFromRequest(req)) {
          return new Response(null, {
            status: 302,
            headers: { Location: BASE + "/login" },
          });
        }
        const innerFile = Bun.file(CLIENT_DIR + inner);
        if (inner !== "/" && (await innerFile.exists())) {
          return new Response(innerFile);
        }
        return appFetch(req, true);
      },
    });
    break;
  } catch (err) {
    if (attempt >= 10) throw err;
    await Bun.sleep(200);
  }
}
console.log(
  `team-site serving on http://${HOST}:${String(PORT)}` +
    (BASE ? ` (base path ${BASE})` : " (base path /)"),
);
