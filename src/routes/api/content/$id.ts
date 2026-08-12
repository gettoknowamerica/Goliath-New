import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { json } from "../-helpers";
import { writeExportFile, type ContentPost } from "~/content";
import { getUserFromRequest, unauthorized } from "~/auth";
// GET /api/content/:id — full post (includes body_markdown + faq_schema_json).
// PATCH /api/content/:id — update status and/or body_markdown. status is
// forward-only draft→ready→published (a downgrade returns 400); body_markdown
// may be replaced while status stays put. published_at is set on FIRST publish
// only (ever-published marker, never cleared, never overwritten by a
// body_markdown edit). Publishing writes the HTML export file (best-effort;
// failure reported but not fatal).
// DELETE /api/content/:id — remove the post.
const STATUS_RANK: Record<string, number> = { draft: 0, ready: 1, published: 2 };
const STATUSES = Object.keys(STATUS_RANK);

function postId(request: Request): number {
  const segs = new URL(request.url).pathname.split("/").filter(Boolean);
  const id = Number(segs[segs.length - 1]);
  return Number.isFinite(id) && id > 0 ? id : NaN;
}

export const Route = createFileRoute("/api/content/$id")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const id = postId(request);
          if (!Number.isFinite(id)) return json({ error: "Invalid post id" }, 400);
          const post = db.query<ContentPost>("SELECT * FROM content_posts WHERE id=?").get(id);
          if (!post) return json({ error: "Post not found" }, 404);
          return json({ post });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
      PATCH: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const id = postId(request);
          if (!Number.isFinite(id)) return json({ error: "Invalid post id" }, 400);
          const b = await request.json() as { status?: unknown; body_markdown?: unknown };
          const post = db.query<ContentPost>("SELECT * FROM content_posts WHERE id=?").get(id);
          if (!post) return json({ error: "Post not found" }, 404);
          const updates: string[] = [];
          const args: unknown[] = [];
          let newStatus = post.status;
          if (b.status !== undefined) {
            const status = String(b.status ?? "").trim();
            if (!STATUSES.includes(status)) return json({ error: `status must be one of: ${STATUSES.join(", ")}` }, 400);
            if (STATUS_RANK[status] < STATUS_RANK[post.status]) return json({ error: `status cannot move backward from ${post.status} to ${status}` }, 400);
            newStatus = status;
            updates.push("status=?");
            args.push(status);
          }
          if (b.body_markdown !== undefined) {
            const body_markdown = String(b.body_markdown);
            if (!body_markdown.trim()) return json({ error: "body_markdown cannot be empty" }, 400);
            updates.push("body_markdown=?");
            args.push(body_markdown);
          }
          if (!updates.length) return json({ error: "nothing to update (send status and/or body_markdown)" }, 400);
          const now = new Date().toISOString();
          const isPublish = newStatus === "published" && post.status !== "published";
          const publishedAt = isPublish ? now : post.published_at; // first publish only
          updates.push("updated_at=?", "published_at=?");
          args.push(now, publishedAt, id);
          db.run(`UPDATE content_posts SET ${updates.join(", ")} WHERE id=?`, ...args);
          const updated = db.query<ContentPost>("SELECT * FROM content_posts WHERE id=?").get(id);
          let exportResult: { ok: boolean; path: string; error?: string } | null = null;
          if (isPublish && updated) exportResult = writeExportFile(updated);
          return json({ post: updated, publishedAtSet: isPublish, export: exportResult });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
      DELETE: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const id = postId(request);
          if (!Number.isFinite(id)) return json({ error: "Invalid post id" }, 400);
          const post = db.query<any>("SELECT id FROM content_posts WHERE id=?").get(id);
          if (!post) return json({ error: "Post not found" }, 404);
          db.run("DELETE FROM content_posts WHERE id=?", id);
          return json({ ok: true, deleted: true, id });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
    },
  },
});
