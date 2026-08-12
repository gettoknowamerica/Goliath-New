import { createFileRoute } from "@tanstack/react-router";
import { comfyConfigured, comfyView } from "~/comfy";
import { mimeOf } from "~/media-files";
import { getUserFromRequest, unauthorized } from "~/auth";
// GET /api/media/comfy/view?filename=&subfolder=&type=output — proxy ComfyUI /view
// through the app (stream bytes with the right Content-Type so the browser can
// play/display renders without CORS issues). Never exposes the tunnel URL.
export const Route = createFileRoute("/api/media/comfy/view")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        const u = new URL(request.url);
        const filename = u.searchParams.get("filename") || "";
        const subfolder = u.searchParams.get("subfolder") || "";
        const type = u.searchParams.get("type") || "output";
        if (!filename || filename.includes("..") || /[\\/]/.test(filename)) {
          return new Response("Invalid filename", { status: 400 });
        }
        if (!comfyConfigured()) {
          return new Response("ComfyUI not configured", { status: 503 });
        }
        const res = await comfyView({ filename, subfolder, type }, 45_000);
        if (!res.ok) {
          const status = res.status && res.status >= 400 && res.status < 600 ? res.status : 502;
          return new Response(res.error || "ComfyUI view failed", { status });
        }
        return new Response(new Uint8Array(res.bytes), {
          headers: {
            "Content-Type": res.contentType || mimeOf(filename),
            "Content-Length": String(res.bytes.length),
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
