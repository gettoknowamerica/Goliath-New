import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { json } from "../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";

// GET /api/leads/emails?verified=0|1|all&limit=&offset= — list imported leads that
// have an email, with verification state, source URL, name, town, score (score desc).
export const Route = createFileRoute("/api/leads/emails")({ server: { handlers: { GET: ({ request }) => {
  if (!getUserFromRequest(request)) return unauthorized();
  try {
    const u = new URL(request.url);
    const verified = u.searchParams.get("verified") ?? "all";
    const limit = Math.min(500, Math.max(1, Number(u.searchParams.get("limit")) || 50));
    const offset = Math.max(0, Number(u.searchParams.get("offset")) || 0);
    const where = ["email IS NOT NULL AND email != ''"];
    const args: unknown[] = [];
    if (verified === "1" || verified === "0") { where.push("email_verified = ?"); args.push(Number(verified)); }
    const whereSql = where.join(" AND ");
    const total = Number(db.query<any>(`SELECT COUNT(*) n FROM imported_leads WHERE ${whereSql}`).get(...args)?.n || 0);
    const leads = db.query<any>(`SELECT id, contact_name, email, email_verified, email_source_url, town, score FROM imported_leads WHERE ${whereSql} ORDER BY score DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset)
      .map((l: any) => ({ id: l.id, name: l.contact_name, email: l.email, email_verified: l.email_verified, email_source_url: l.email_source_url, town: l.town, score: l.score }));
    return json({ leads, total, limit, offset });
  } catch (e) { return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400); }
} } } });
