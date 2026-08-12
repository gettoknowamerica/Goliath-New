import { createFileRoute } from "@tanstack/react-router";
import { randomUUID } from "node:crypto";
import { db } from "~/db";
import { kindOf } from "~/media-files";
import { MAX_CHUNKED_UPLOAD_BYTES, RECEIVER_CHUNK_SIZE, receiverHealth, receiverStart } from "~/upload-receiver";
import { json } from "../../-helpers";
// POST /api/media/upload/start {filename, size, aspect} — begin a CHUNKED upload.
// The chunked path is for raw 4K video / big assets (up to 50 GB): the browser
// splits the file into 8 MB chunks and POSTs each to /api/media/upload/chunk.
// The app probes the media receiver on the owner's GPU box once (5 s timeout):
// reachable => target 'remote' (chunks are forwarded to the F: drive); otherwise
// target 'local' (chunks are staged on this app's disk and assembled at complete).
// Returns {uploadId, target, chunk_size} so the client knows where to send chunks.
export const Route = createFileRoute("/api/media/upload/start")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json().catch(() => null) as Record<string, unknown> | null;
          const filename = String(body?.filename || "").trim();
          const size = Number(body?.size);
          const aspect = String(body?.aspect || "general").trim() || "general";
          if (!filename || !Number.isFinite(size) || size <= 0) {
            return json({ error: "filename and positive size are required" }, 400);
          }
          if (size > MAX_CHUNKED_UPLOAD_BYTES) {
            return json({ error: `File too large (max ${Math.round(MAX_CHUNKED_UPLOAD_BYTES / 1024 ** 3)} GB)` }, 413);
          }
          const kind = kindOf(filename);
          if (!kind) return json({ error: `File type not allowed: '${filename}'` }, 415);

          // Probe the receiver once (5 s) to decide remote vs local fallback.
          const health = await receiverHealth(5_000);
          let target = health.ok ? "remote" : "local";

          const uploadId = randomUUID();
          const totalChunks = Math.max(1, Math.ceil(size / RECEIVER_CHUNK_SIZE));
          const now = new Date().toISOString();
          if (target === "remote") {
            // Create the receiver's staging record BEFORE inserting the job row, so
            // chunk PUTs never hit "unknown upload_id". If the receiver refuses,
            // fall back to local rather than failing the upload.
            try {
              await receiverStart({ upload_id: uploadId, filename, size, total_chunks: totalChunks }, 15_000);
            } catch (e) {
              target = "local";
              console.error("[upload/start] receiver /start failed, falling back to local:", e instanceof Error ? e.message : e);
            }
          }
          db.run(
            "INSERT INTO upload_jobs (upload_id, filename, size, total_chunks, received_count, status, target, aspect, created_at, updated_at) VALUES (?,?,?,?,0,'staging',?,?,?,?)",
            uploadId, filename, size, totalChunks, target, aspect, now, now,
          );
          return json({
            uploadId,
            target,
            chunk_size: RECEIVER_CHUNK_SIZE,
            total_chunks: totalChunks,
            kind,
          }, 200);
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
    },
  },
});
