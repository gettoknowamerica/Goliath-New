import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { parseMeta } from "~/media-files";
import { json } from "./-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";
// GET /api/media?aspect=&source=&limit= — media library, newest first.
export const Route = createFileRoute("/api/media")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const u = new URL(request.url);
          const aspect = u.searchParams.get("aspect");
          const source = u.searchParams.get("source");
          const limit = Math.min(Math.max(Number(u.searchParams.get("limit") || 100) || 100, 1), 500);
          const where: string[] = [];
          const args: unknown[] = [];
          if (aspect) { where.push("aspect=?"); args.push(aspect); }
          if (source) { where.push("source=?"); args.push(source); }
          const sql = `SELECT * FROM media_items${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
          const rows = db.query<any>(sql).all(...args, limit).map((m) => ({ ...m, meta: parseMeta(m.meta) }));
          return json({ items: rows, total: rows.length });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
    },
  },
});
