import { createFileRoute } from "@tanstack/react-router";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db } from "~/db";
import { MEDIA_DIR } from "~/media-files";
import { receiverAbort } from "~/upload-receiver";
import { json } from "../../-helpers";
// POST /api/media/upload/abort {uploadId} — cancel an in-flight upload and drop
// its staging area (receiver staging on the remote, .data/media/.chunks locally).
// The receiver call is best-effort; the job is marked 'aborted' either way.
export const Route = createFileRoute("/api/media/upload/abort")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json().catch(() => null) as Record<string, unknown> | null;
          const uploadId = String(body?.uploadId || "").trim();
          if (!uploadId) return json({ error: "uploadId is required" }, 400);
          const job = db.query<any>("SELECT * FROM upload_jobs WHERE upload_id=?").get(uploadId);
          if (!job) return json({ error: "unknown uploadId" }, 404);
          if (job.status !== "staging" && job.status !== "failed") {
            return json({ error: `job is ${job.status} — nothing to abort` }, 409);
          }
          if (job.target === "remote") {
            await receiverAbort(uploadId);
          } else {
            const dir = join(MEDIA_DIR, ".chunks", uploadId);
            if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
          }
          const now = new Date().toISOString();
          db.run("UPDATE upload_jobs SET status='aborted', updated_at=? WHERE upload_id=?", now, uploadId);
          return json({ ok: true, aborted: uploadId });
        } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 400); }
      },
    },
  },
});
