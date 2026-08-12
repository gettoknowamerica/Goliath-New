import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { json } from "./-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";
// GET /api/notes?date=YYYY-MM-DD | ?limit=N (newest first) — daily notes list.
// POST /api/notes {note_date?, content} — upsert by note_date (defaults to today).
export const Route = createFileRoute("/api/notes")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const u = new URL(request.url);
          const date = u.searchParams.get("date");
          if (date) {
            const note = db.query<any>("SELECT * FROM daily_notes WHERE note_date=? ORDER BY id DESC LIMIT 1").get(date);
            return json({ notes: note ? [note] : [], total: note ? 1 : 0 });
          }
          const limit = Math.min(Math.max(Number(u.searchParams.get("limit") || 10) || 10, 1), 100);
          const notes = db.query<any>("SELECT * FROM daily_notes ORDER BY note_date DESC, id DESC LIMIT ?").all(limit);
          return json({ notes, total: notes.length });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
      POST: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const b = await request.json() as { note_date?: unknown; content?: unknown };
          const content = String(b.content ?? "").trim();
          if (!content) return json({ error: "content is required" }, 400);
          const noteDate = typeof b.note_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.note_date)
            ? b.note_date : new Date().toISOString().slice(0, 10);
          const now = new Date().toISOString();
          const existing = db.query<any>("SELECT id FROM daily_notes WHERE note_date=?").get(noteDate);
          if (existing) {
            db.run("UPDATE daily_notes SET content=?, updated_at=? WHERE id=?", content, now, existing.id);
            return json({ note: db.query<any>("SELECT * FROM daily_notes WHERE id=?").get(existing.id), created: false, updated: true });
          }
          const r = db.run("INSERT INTO daily_notes (note_date, content, created_at, updated_at) VALUES (?,?,?,?)", noteDate, content, now, now);
          return json({ note: db.query<any>("SELECT * FROM daily_notes WHERE id=?").get(r.lastInsertRowid), created: true, updated: false });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
    },
  },
});
