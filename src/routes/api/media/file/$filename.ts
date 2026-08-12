import { createFileRoute } from "@tanstack/react-router";
import { join } from "node:path";
import { MEDIA_DIR, mimeOf } from "~/media-files";
import { json } from "../../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";
// GET /api/media/file/:filename — serve an uploaded file from .data/media/ with a
// correct Content-Type. Path-traversal-safe: basename only, must resolve inside MEDIA_DIR.
export const Route = createFileRoute("/api/media/file/$filename")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const segs = new URL(request.url).pathname.split("/").filter(Boolean);
          const raw = decodeURIComponent(segs[segs.length - 1] || "");
          const base = raw.replace(/^.*[\\/]/, ""); // strip slashes/backslashes
          if (!base || base !== raw || base === "." || base === ".." || base.includes("..")) {
            return json({ error: "Invalid filename" }, 400);
          }
          const full = join(MEDIA_DIR, base);
          if (!full.startsWith(MEDIA_DIR)) return json({ error: "Invalid filename" }, 400);
          const file = Bun.file(full);
          if (!(await file.exists())) return json({ error: "File not found" }, 404);
          return new Response(file, {
            headers: { "Content-Type": mimeOf(base), "Cache-Control": "public, max-age=3600" },
          });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
    },
  },
});
