import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

// App base path, read from APP_BASE_PATH AT BUILD TIME and baked into the
// TanStack Router on BOTH the client and the SSR server. TanStack Start's
// client bootstrap overrides the router's basepath with the plugin value
// (v1.158), so the basepath must be baked at build time — runtime injection
// alone is not enough.
//   "/" (default)                 — everything at the root (cto.new preview).
//   "/mission-control"            — the whole app under /mission-control/*
//                                   (local home deployment behind
//                                   https://markpires.com/mission-control).
// serve.ts reads the SAME env var at runtime for the root redirect / API
// passthrough / auth-gate behavior. Rebuild after changing APP_BASE_PATH.
function normalizeBasePath(raw: string | undefined): string {
  const trimmed = (raw || "/").trim();
  if (!trimmed || trimmed === "/") return "/";
  return "/" + trimmed.replace(/^\/+|\/+$/g, "");
}

export default defineConfig({
  server: {
    port: 3000,
    host: true,
    // The site is reverse-proxied behind <label>.<PUBLIC_SITE_DOMAIN>; the proxy
    // masks the Host to localhost:3000, but accept any host so a dev server never
    // rejects a proxied request with "Blocked request".
    allowedHosts: true,
    // The dev server is reachable through the TLS proxy, so the HMR websocket
    // must dial back on 443, not the dev port. If the socket can't connect,
    // pages still serve — hot reload degrades, never breaks.
    hmr: { clientPort: 443 },
    // The dev server can serve source files; never let it serve local secrets,
    // and never let it serve anything outside the site dir. Gotchas this list
    // encodes: a custom `deny` REPLACES Vite's defaults (so .git must be
    // restated), patterns containing "/" match the ABSOLUTE path (so dir
    // patterns need a leading **/), and `allow` left to its default widens to
    // the nearest workspace root — a stray .git or workspaces package.json in
    // /home/team/shared would expose the whole shared dir.
    fs: {
      strict: true,
      allow: [import.meta.dirname],
      deny: [".env", ".env.*", "*.{crt,pem,key}", "**/.run/**", "**/.git/**"],
    },
  },
  plugins: [
    tailwindcss(),
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tanstackStart({
      router: { basepath: normalizeBasePath(process.env.APP_BASE_PATH) },
    }),
    viteReact(),
  ],
});
