import { createFileRoute } from "@tanstack/react-router";
import { join } from "node:path";
import { db } from "~/db";
import { MEDIA_DIR, MAX_UPLOAD_BYTES, kindOf, mimeOf, safeFilename } from "~/media-files";
import { json } from "../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";
// POST /api/media/upload — multipart form: field 'file' (+ 'aspect', optional 'title').
// Saves under .data/media/ with a safe unique filename, infers kind from extension,
// enforces a 200 MB cap and an extension allowlist (no executables/scripts).
export const Route = createFileRoute("/api/media/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const declared = Number(request.headers.get("content-length") || 0);
          if (declared > MAX_UPLOAD_BYTES) return json({ error: `File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB)` }, 413);
          const form = await request.formData();
          const raw = form.get("file");
          if (!raw || typeof raw !== "object" || !("name" in raw) || !("size" in raw)) {
            return json({ error: "multipart 'file' field is required" }, 400);
          }
          const file = raw as unknown as File;
          if (file.size === 0) return json({ error: "File is empty" }, 400);
          if (file.size > MAX_UPLOAD_BYTES) return json({ error: `File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB)` }, 413);
          const aspect = String(form.get("aspect") || "general").trim() || "general";
          const kind = kindOf(file.name);
          if (!kind) return json({ error: `File type not allowed: '${file.name}'` }, 415);
          const filename = safeFilename(file.name);
          const full = join(MEDIA_DIR, filename);
          await Bun.write(full, file);
          const title = String(form.get("title") || "").trim() || file.name;
          const meta = JSON.stringify({ original_name: file.name, size: file.size, mime: mimeOf(filename) });
          const now = new Date().toISOString();
          const r = db.run("INSERT INTO media_items (aspect, source, kind, title, filename, thumb, meta, created_at) VALUES (?,?,?,?,?,?,?,?)",
            aspect, "upload", kind, title, filename, null, meta, now);
          const row = db.query<any>("SELECT * FROM media_items WHERE id=?").get(r.lastInsertRowid);
          return json({ item: { ...row, meta: JSON.parse(row.meta) }, created: true });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
    },
  },
});
