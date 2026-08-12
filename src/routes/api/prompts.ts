import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { json } from "./-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";
// GET /api/prompts?aspect=&status=&limit= — prompt inbox, newest first.
// POST /api/prompts {aspect, prompt} — owner prompt-window submission -> 'new'.
const PROMPT_ASPECTS = ["scorsese", "shakespeare", "jessica", "notes", "general"];
const PROMPT_STATUSES = ["new", "accepted", "in_progress", "done", "declined"];
export const Route = createFileRoute("/api/prompts")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const u = new URL(request.url);
          const aspect = u.searchParams.get("aspect");
          const status = u.searchParams.get("status");
          const limit = Math.min(Math.max(Number(u.searchParams.get("limit") || 100) || 100, 1), 500);
          const where: string[] = [];
          const args: unknown[] = [];
          if (aspect) { where.push("aspect=?"); args.push(aspect); }
          if (status) { where.push("status=?"); args.push(status); }
          const sql = `SELECT * FROM prompt_requests${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
          const rows = db.query<any>(sql).all(...args, limit);
          return json({ prompts: rows, total: rows.length });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
      POST: async ({ request }) => {
        if (!getUserFromRequest(request)) return unauthorized();
        try {
          const b = await request.json() as { aspect?: unknown; prompt?: unknown };
          const aspect = String(b.aspect ?? "").trim();
          const prompt = String(b.prompt ?? "").trim();
          if (!PROMPT_ASPECTS.includes(aspect)) return json({ error: `aspect must be one of: ${PROMPT_ASPECTS.join(", ")}` }, 400);
          if (!prompt) return json({ error: "prompt is required" }, 400);
          const now = new Date().toISOString();
          const r = db.run("INSERT INTO prompt_requests (aspect, prompt, status, created_at, updated_at) VALUES (?,?,?,?,?)", aspect, prompt, "new", now, now);
          return json({ prompt: db.query<any>("SELECT * FROM prompt_requests WHERE id=?").get(r.lastInsertRowid), created: true });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
      },
    },
  },
});
