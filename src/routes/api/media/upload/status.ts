import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { json } from "../../-helpers";
// GET /api/media/upload/status?uploadId=<id>  — one job with progress.
// GET /api/media/upload/status?all=1           — every job, newest first.
// Progress = received_count / total_chunks, capped at 100 (clients may send
// smaller chunks than the advertised 8 MB, so received_count can exceed
// total_chunks mid-flight — the DECLARED SIZE is what complete() verifies).
const cap = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
export const Route = createFileRoute("/api/media/upload/status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const u = new URL(request.url);
          const uploadId = u.searchParams.get("uploadId");
          const all = u.searchParams.get("all") === "1" || u.searchParams.get("all") === "true";
          if (uploadId) {
            const job = db.query<any>("SELECT * FROM upload_jobs WHERE upload_id=?").get(uploadId);
            if (!job) return json({ error: "unknown uploadId" }, 404);
            return json({ job: { ...job, progress: cap((job.received_count / job.total_chunks) * 100) } });
          }
          const rows = db.query<any>("SELECT * FROM upload_jobs ORDER BY id DESC LIMIT 100").all()
            .map((j) => ({ ...j, progress: cap((j.received_count / j.total_chunks) * 100) }));
          return json({ jobs: rows, total: rows.length });
        } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 400); }
      },
    },
  },
});
