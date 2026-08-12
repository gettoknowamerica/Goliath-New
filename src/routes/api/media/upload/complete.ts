import { createFileRoute } from "@tanstack/react-router";
import { createReadStream, createWriteStream, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { finished } from "node:stream/promises";
import { db } from "~/db";
import { MEDIA_DIR, kindOf, safeFilename } from "~/media-files";
import { ReceiverError, receiverComplete } from "~/upload-receiver";
import { json } from "../../-helpers";
// POST /api/media/upload/complete {uploadId} — assemble all staged chunks into
// the final file. Remote: asks the receiver to concatenate chunks on the F: drive
// and verify the size, then records a media_items row (source='remote'). Local:
// concatenates .data/media/.chunks/<uploadId>/chunk-* in order into MEDIA_DIR,
// verifies the size, records media_items (source='upload'), and cleans up staging.
// Chunk count is discovered from what is actually staged (clients may use smaller
// chunks than the advertised 8 MB); the DECLARED SIZE is the source of truth.
export const Route = createFileRoute("/api/media/upload/complete")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json().catch(() => null) as Record<string, unknown> | null;
          const uploadId = String(body?.uploadId || "").trim();
          if (!uploadId) return json({ error: "uploadId is required" }, 400);
          const job = db.query<any>("SELECT * FROM upload_jobs WHERE upload_id=?").get(uploadId);
          if (!job) return json({ error: "unknown uploadId" }, 404);
          if (job.status !== "staging") return json({ error: `job is ${job.status}, not staging` }, 409);

          const now = new Date().toISOString();
          let item: Record<string, unknown>;

          if (job.target === "remote") {
            const res = await receiverComplete(uploadId, 110_000).catch((e: Error) => {
              if (e instanceof ReceiverError) throw e;
              throw new Error(`receiver unreachable: ${e.message}`);
            });
            if (!res.ok) {
              db.run("UPDATE upload_jobs SET status='failed', updated_at=? WHERE upload_id=?", now, uploadId);
              return json({ error: res.error || "receiver /complete failed" }, 502);
            }
            const filename = String(res.filename || job.filename);
            const kind = kindOf(filename) || "video";
            const meta = JSON.stringify({ size: res.size, remote_filename: filename, original_name: job.filename });
            const r = db.run(
              "INSERT INTO media_items (aspect, source, kind, title, filename, thumb, meta, created_at) VALUES (?,?,?,?,?,?,?,?)",
              job.aspect, "remote", kind, job.filename, filename, null, meta, now,
            );
            item = db.query<any>("SELECT * FROM media_items WHERE id=?").get(r.lastInsertRowid);
            item = { ...item, meta: JSON.parse(item.meta) };
            // Keep the last received_count from the chunk uploads (don't clobber
            // with total_chunks — clients may have used smaller chunks).
            db.run("UPDATE upload_jobs SET status='complete', media_item_id=?, updated_at=? WHERE upload_id=?",
              item.id, now, uploadId);
          } else {
            // Local: discover staged chunks, require 0..max contiguous, assemble.
            const dir = join(MEDIA_DIR, ".chunks", uploadId);
            if (!existsSync(dir)) return json({ error: "no chunks staged for this upload" }, 409);
            const indices = readdirSync(dir)
              .filter((f) => f.startsWith("chunk-"))
              .map((f) => Number(f.slice("chunk-".length)))
              .filter((n) => Number.isInteger(n) && n >= 0)
              .sort((a, b) => a - b);
            if (indices.length === 0) return json({ error: "no chunks staged for this upload" }, 409);
            for (let i = 0; i < indices.length; i++) {
              if (indices[i] !== i) return json({ error: `missing chunk ${i}` }, 409);
            }
            const filename = safeFilename(job.filename);
            const full = join(MEDIA_DIR, filename);
            const out = createWriteStream(full);
            try {
              for (const i of indices) {
                await pipeline(createReadStream(join(dir, `chunk-${i}`)), out, { end: false });
              }
              out.end();
              await finished(out);
            } catch (e) {
              try { out.destroy(); } catch { /* noop */ }
              rmSync(full, { force: true });
              db.run("UPDATE upload_jobs SET status='failed', updated_at=? WHERE upload_id=?", now, uploadId);
              throw e;
            }
            const actual = statSync(full).size;
            if (actual !== job.size) {
              rmSync(full, { force: true });
              db.run("UPDATE upload_jobs SET status='failed', updated_at=? WHERE upload_id=?", now, uploadId);
              return json({ error: `size mismatch: declared ${job.size}, assembled ${actual}` }, 500);
            }
            const kind = kindOf(filename) || "video";
            const meta = JSON.stringify({ size: actual, original_name: job.filename });
            const r = db.run(
              "INSERT INTO media_items (aspect, source, kind, title, filename, thumb, meta, created_at) VALUES (?,?,?,?,?,?,?,?)",
              job.aspect, "upload", kind, job.filename, filename, null, meta, now,
            );
            item = db.query<any>("SELECT * FROM media_items WHERE id=?").get(r.lastInsertRowid);
            item = { ...item, meta: JSON.parse(item.meta) };
            rmSync(dir, { recursive: true, force: true });
            db.run("UPDATE upload_jobs SET status='complete', media_item_id=?, received_count=?, updated_at=? WHERE upload_id=?",
              item.id, indices.length, now, uploadId);
          }

          return json({ ok: true, uploadId, item });
        } catch (e) {
          if (e instanceof ReceiverError) return json({ error: e.message }, e.status);
          return json({ error: e instanceof Error ? e.message : String(e) }, 502);
        }
      },
    },
  },
});
