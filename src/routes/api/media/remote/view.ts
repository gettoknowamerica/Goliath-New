import { createFileRoute } from "@tanstack/react-router";
import { mimeOf } from "~/media-files";
import { receiverConfigured, receiverFileStream } from "~/upload-receiver";
import { json } from "../../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";
// GET /api/media/remote/view?filename=<name> — proxy a completed file off the
// owner's F: drive (media receiver) back to the browser for playback. Streams
// bytes through the app so the tunnel URL is NEVER exposed, and forwards the
// browser's Range header so video seeking works. 503 when no receiver is
// configured; 504 when the tunnel is down.
export const Route = createFileRoute("/api/media/remote/view")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        const u = new URL(request.url);
        const raw = u.searchParams.get("filename") || "";
        const base = raw.replace(/^.*[\\/]/, ""); // basename only — no path traversal
        if (!base || base !== raw || base === "." || base === ".." || base.includes("..")) {
          return json({ error: "Invalid filename" }, 400);
        }
        if (!receiverConfigured()) {
          return json({ error: "remote storage not configured" }, 503);
        }
        const range = request.headers.get("range");
        let upstream: Response;
        try {
          upstream = await receiverFileStream(base, range, 20_000);
        } catch {
          return json({ error: "remote storage unreachable (tunnel down?)" }, 504);
        }
        if (!upstream.ok) {
          const status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
          return json({ error: `receiver /file HTTP ${upstream.status}` }, status);
        }
        const headers: Record<string, string> = {
          "Content-Type": mimeOf(base),
          "Cache-Control": "public, max-age=3600",
        };
        const cl = upstream.headers.get("content-length");
        if (cl) headers["Content-Length"] = cl;
        const cr = upstream.headers.get("content-range");
        if (cr) headers["Content-Range"] = cr;
        headers["Accept-Ranges"] = "bytes";
        return new Response(upstream.body, { status: upstream.status, headers });
      },
    },
  },
});
