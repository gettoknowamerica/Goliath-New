import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

/**
 * App base path (runtime-prefixed deployment).
 *
 * - Server side: read from APP_BASE_PATH (set in .env / start script). Default
 *   "/" keeps the published cto.new preview exactly as today.
 * - Client side: the production server (serve.ts) injects `window.__LF_BASE_PATH__`
 *   into the SSR HTML so the hydrated router knows the same prefix.
 * - When APP_BASE_PATH=/mission-control (local home deployment) the whole app
 *   surface lives under https://markpires.com/mission-control/*.
 */
export function getBasePath(): string {
  if (typeof window !== "undefined") {
    const injected = (window as unknown as { __LF_BASE_PATH__?: string })
      .__LF_BASE_PATH__;
    if (typeof injected === "string" && injected) return normalizeBasePath(injected);
    return "/";
  }
  return normalizeBasePath(process.env.APP_BASE_PATH || "/");
}

function normalizeBasePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "/") return "/";
  return "/" + trimmed.replace(/^\/+|\/+$/g, "");
}

export function getRouter() {
  return createRouter({
    routeTree,
    basepath: getBasePath(),
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultNotFoundComponent: () => <p>Not found</p>,
  });
}
