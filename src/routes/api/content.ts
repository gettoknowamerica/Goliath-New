import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { json } from "./-helpers";
import { slugify, type ContentPost } from "~/content";
import { getUserFromRequest, unauthorized } from "~/auth";
// GET /api/content?status=&q=&town=&limit= — lean list (no body_markdown /
// faq_schema_json), newest first, limit 1..200.
// POST /api/content {title, slug?, body_markdown, ...} — create a draft; 409 on
// duplicate slug. slug defaults to slugify(title) when absent.
const LEAN_COLS = "id,title,slug,focus_keyword,meta_title,meta_description,cta_url,source_question,status,town_focus,created_at,updated_at,published_at";
const STATUSES = ["draft", "ready", "published"];

export const Route = createFileRoute("/api/content")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const u = new URL(request.url);
          const status = u.searchParams.get("status");
          const q = (u.searchParams.get("q") || "").trim();
          const town = (u.searchParams.get("town") || "").trim();
          const limit = Math.min(Math.max(Number(u.searchParams.get("limit") || 50) || 50, 1), 200);
          const where: string[] = [];
          const args: unknown[] = [];
          if (status && STATUSES.includes(status)) { where.push("status=?"); args.push(status); }
          if (q) { where.push("(title LIKE ? OR slug LIKE ? OR focus_keyword LIKE ?)"); const like = `%${q}%`; args.push(like, like, like); }
          if (town) { where.push("town_focus=?"); args.push(town); }
          const sql = `SELECT ${LEAN_COLS} FROM content_posts${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT ?`;
          const posts = db.query<any>(sql).all(...args, limit);
          return json({ posts, total: posts.length });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
      POST: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const b = await request.json() as Record<string, unknown>;
          const title = String(b.title ?? "").trim();
          const body_markdown = String(b.body_markdown ?? "").trim();
          if (!title) return json({ error: "title is required" }, 400);
          if (!body_markdown) return json({ error: "body_markdown is required" }, 400);
          const slug = String(b.slug ?? "").trim() || slugify(title);
          const dup = db.query<any>("SELECT id FROM content_posts WHERE slug=?").get(slug);
          if (dup) return json({ error: `slug already exists: ${slug}`, slug }, 409);
          const now = new Date().toISOString();
          const status = STATUSES.includes(String(b.status ?? "")) ? String(b.status) : "draft";
          const r = db.run(`INSERT INTO content_posts
            (title, slug, focus_keyword, meta_title, meta_description, body_markdown, faq_schema_json, cta_url, source_question, status, town_focus, created_at, updated_at, published_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            title, slug,
            b.focus_keyword ? String(b.focus_keyword).trim() : null,
            b.meta_title ? String(b.meta_title).trim() : null,
            b.meta_description ? String(b.meta_description).trim() : null,
            body_markdown,
            b.faq_schema_json ? String(b.faq_schema_json) : null,
            b.cta_url ? String(b.cta_url).trim() : null,
            b.source_question ? String(b.source_question).trim() : null,
            status,
            b.town_focus ? String(b.town_focus).trim() : null,
            now, now,
            status === "published" ? now : null);
          const post = db.query<ContentPost>("SELECT * FROM content_posts WHERE id=?").get(r.lastInsertRowid);
          return json({ post, created: true }, 201);
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
    },
  },
});
