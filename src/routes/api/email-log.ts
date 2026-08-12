import { createFileRoute } from "@tanstack/react-router";
import { db } from "~/db";
import { json } from "./-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";
export const Route = createFileRoute("/api/email-log")({ server: { handlers: { GET: ({ request }) => { if (!getUserFromRequest(request)) return unauthorized(); const limit=Math.min(200,Math.max(1,Number(new URL(request.url).searchParams.get("limit")||50))); return json({ logs: db.query<any>("SELECT * FROM send_log ORDER BY id DESC LIMIT ?").all(limit) }); } } } });
