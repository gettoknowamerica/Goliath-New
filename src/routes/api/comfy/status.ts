import { createFileRoute } from "@tanstack/react-router";
import { comfyConfigured, comfyHealth, comfyQueue } from "~/comfy";
import { json } from "../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";

export const Route = createFileRoute("/api/comfy/status")({
  server: {
    handlers: {
      GET: async ({ request }) => { if (!getUserFromRequest(request)) return unauthorized();
        if (!comfyConfigured()) {
          return json({ configured: false, health: null, queue: null, note: "COMFYUI_BASE_URL not set" });
        }
        const [health, queue] = await Promise.all([
          comfyHealth(),
          comfyQueue().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })),
        ]);
        return json({ configured: true, health, queue });
      },
    },
  },
});
