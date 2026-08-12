import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { json } from "../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";
// PUT /api/notes/$id {content} — update a note's content.
// DELETE /api/notes/$id — remove a note.
export const Route = createFileRoute("/api/notes/$id")({
  server: {
    handlers: {
      PUT: async ({ request }) => {
        try {
          const segs = new URL(request.url).pathname.split("/").filter(Boolean);
          const id = Number(segs[segs.length - 1]);
          if (!Number.isFinite(id)) return json({ error: "Invalid note id" }, 400);
          const b = await request.json() as { content?: unknown };
          const content = String(b.content ?? "").trim();
          if (!content) return json({ error: "content is required" }, 400);
          const r = db.run("UPDATE daily_notes SET content=?, updated_at=? WHERE id=?", content, new Date().toISOString(), id);
          if (r.changes === 0) return json({ error: "Note not found" }, 404);
          return json({ note: db.query<any>("SELECT * FROM daily_notes WHERE id=?").get(id) });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
      DELETE: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const segs = new URL(request.url).pathname.split("/").filter(Boolean);
          const id = Number(segs[segs.length - 1]);
          if (!Number.isFinite(id)) return json({ error: "Invalid note id" }, 400);
          const r = db.run("DELETE FROM daily_notes WHERE id=?", id);
          if (r.changes === 0) return json({ error: "Note not found" }, 404);
          return json({ ok: true, deleted: id });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
    },
  },
});
