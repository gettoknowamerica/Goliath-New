import { createFileRoute } from "@tanstack/react-router";
import { db, seedDatabase, type Lead } from "~/db";
import { json } from "./-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";

export const Route = createFileRoute("/api/leads")({
  server: { handlers: { GET: ({ request }) => { if (!getUserFromRequest(request)) return unauthorized(); seedDatabase(); return json({ leads: db.query<Lead>("SELECT * FROM leads ORDER BY datetime(created_at) DESC, id DESC LIMIT 50").all() }); } } },
});
