import { createFileRoute } from "@tanstack/react-router";
import { json } from "./-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";

export const Route = createFileRoute("/api/business")({
  server: { handlers: {
    GET: ({ request }) => { if (!getUserFromRequest(request)) return unauthorized(); return json({ business: null, message: "Business profiles are not persisted in this MVP" }); },
    POST: async ({ request }) => { if (!getUserFromRequest(request)) return unauthorized(); try { return json({ business: await request.json() }, 201); } catch { return json({ error: "Invalid JSON body" }, 400); } },
  } },
});
