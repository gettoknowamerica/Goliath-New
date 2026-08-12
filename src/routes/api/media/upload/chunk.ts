import { createFileRoute } from "@tanstack/react-router";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db } from "~/db";
import { MEDIA_DIR } from "~/media-files";
import { receiverChunk, ReceiverError } from "~/upload-receiver";
import { json } from "../../-helpers";
// POST /api/media/upload/chunk?uploadId=<id>&index=<n> — send ONE raw chunk.
// The body is the RAW BYTES of the chunk (a single body cannot be both JSON
// metadata and binary data, so uploadId/index travel as query params; the chunk
// bytes are the body). Remote: the app streams the body straight through to the
// receiver's PUT /chunk/<id>/<n> (never buffered by the app) with the token.
// Local fallback: bytes are streamed to .data/media/.chunks/<uploadId>/chunk-<n>.
// Returns {received} = number of distinct chunks staged so far.
const MAX_CHUNK_INDEX = 1_000_000;

function localChunksDir(uploadId: string): string {
  return join(MEDIA_DIR, ".chunks", uploadId);
}

function countLocalChunks(uploadId: string): number {
  const dir = localChunksDir(uploadId);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) if (f.startsWith("chunk-")) n += 1;
  return n;
}

export const Route = createFileRoute("/api/media/upload/chunk")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const u = new URL(request.url);
          const uploadId = u.searchParams.get("uploadId") || "";
          const index = Number(u.searchParams.get("index"));
          if (!uploadId) return json({ error: "uploadId query param is required" }, 400);
          if (!Number.isInteger(index) || index < 0 || index >= MAX_CHUNK_INDEX) {
            return json({ error: `index must be an integer in [0, ${MAX_CHUNK_INDEX})` }, 400);
          }
          const job = db.query<any>("SELECT * FROM upload_jobs WHERE upload_id=?").get(uploadId);
          if (!job) return json({ error: "unknown uploadId — POST /api/media/upload/start first" }, 404);
          if (job.status !== "staging") return json({ error: `job is ${job.status}, not staging` }, 409);

          const contentLength = request.headers.get("content-length");
          let received: number[] = [];

          if (job.target === "remote") {
            // Stream the raw body to the receiver — never buffer more than the chunk.
            const res = await receiverChunk(uploadId, index, request.body, contentLength, 100_000)
              .catch((e: Error) => { throw e; });
            received = res.received;
          } else {
            // Local fallback: stream body to .chunks/<uploadId>/chunk-<index>.
            if (!request.body) return json({ error: "empty body" }, 400);
            const dir = localChunksDir(uploadId);
            mkdirSync(dir, { recursive: true });
            const target = join(dir, `chunk-${index}`);
            const tmp = join(dir, `chunk-${index}.part`);
            try {
              await pipeline(Readable.fromWeb(request.body as never), createWriteStream(tmp));
              rmSync(target, { force: true });
              // rename is atomic-ish: a partial chunk is never visible as chunk-N
              const fs = await import("node:fs");
              fs.renameSync(tmp, target);
            } catch (e) {
              rmSync(tmp, { force: true });
              throw e;
            }
            const n = countLocalChunks(uploadId);
            received = Array.from({ length: n }, (_, i) => i);
          }

          const now = new Date().toISOString();
          db.run("UPDATE upload_jobs SET received_count=?, updated_at=? WHERE upload_id=?", received.length, now, uploadId);
          return json({ ok: true, received: received.length, index });
        } catch (e) {
          // Receiver 4xx = client error (unknown id, bad index) → mirror its status.
          // Anything else (tunnel down, timeout) → 502, client can retry the chunk.
          if (e instanceof ReceiverError) return json({ error: e.message }, e.status);
          return json({ error: e instanceof Error ? e.message : String(e) }, 502);
        }
      },
    },
  },
});
