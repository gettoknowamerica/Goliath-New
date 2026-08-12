import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { json } from "../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";
// PATCH /api/prompts/$id {status} — move a prompt through the team workflow.
const PROMPT_STATUSES = ["new", "accepted", "in_progress", "done", "declined"];
export const Route = createFileRoute("/api/prompts/$id")({
  server: {
    handlers: {
      PATCH: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const segs = new URL(request.url).pathname.split("/").filter(Boolean);
          const id = Number(segs[segs.length - 1]);
          if (!Number.isFinite(id)) return json({ error: "Invalid prompt id" }, 400);
          const b = await request.json() as { status?: unknown };
          const status = String(b.status ?? "").trim();
          if (!PROMPT_STATUSES.includes(status)) return json({ error: `status must be one of: ${PROMPT_STATUSES.join(", ")}` }, 400);
          const r = db.run("UPDATE prompt_requests SET status=?, updated_at=? WHERE id=?", status, new Date().toISOString(), id);
          if (r.changes === 0) return json({ error: "Prompt not found" }, 404);
          return json({ prompt: db.query<any>("SELECT * FROM prompt_requests WHERE id=?").get(id) });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
    },
  },
});
