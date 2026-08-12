import { createFileRoute } from "@tanstack/react-router";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "~/db";
import { MEDIA_DIR } from "~/media-files";
import { json } from "../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";
// DELETE /api/media/$id — remove a media item; also unlinks the local file when
// it was an upload (safe: only files under .data/media, never the DB row's source).
export const Route = createFileRoute("/api/media/$id")({
  server: {
    handlers: {
      DELETE: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const segs = new URL(request.url).pathname.split("/").filter(Boolean);
          const id = Number(segs[segs.length - 1]);
          if (!Number.isFinite(id)) return json({ error: "Invalid media id" }, 400);
          const item = db.query<any>("SELECT * FROM media_items WHERE id=?").get(id);
          if (!item) return json({ error: "Media item not found" }, 404);
          db.run("DELETE FROM media_items WHERE id=?", id);
          if (item.source === "upload" && item.filename) {
            const safe = item.filename.replace(/^.*[\\/]/, "");
            const full = join(MEDIA_DIR, safe);
            if (safe && full.startsWith(MEDIA_DIR) && existsSync(full)) {
              try { unlinkSync(full); } catch { /* file already gone — row is what matters */ }
            }
          }
          return json({ ok: true, deleted: id });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
    },
  },
});
