import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { json } from "../../-helpers";
import { exportPostHtml, type ContentPost } from "~/content";
// GET /api/content/:id/export — always-fresh standalone HTML for a post
// (no rebuild needed). Download attachment named YYYY-MM-DD-slug.html.
export const Route = createFileRoute("/api/content/$id/export")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const segs = new URL(request.url).pathname.split("/").filter(Boolean);
          const id = Number(segs[segs.length - 2]);
          if (!Number.isFinite(id) || id <= 0) return json({ error: "Invalid post id" }, 400);
          const post = db.query<ContentPost>("SELECT * FROM content_posts WHERE id=?").get(id);
          if (!post) return json({ error: "Post not found" }, 404);
          const html = exportPostHtml(post);
          const date = String(post.published_at || post.created_at || "").slice(0, 10);
          const filename = `${date}-${post.slug}.html`;
          return new Response(html, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Disposition": `attachment; filename="${filename}"`,
            },
          });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
    },
  },
});
