import { createFileRoute } from "@tanstack/react-router";
import { enrichStatus } from "~/enrich-worker";
import { json } from "../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";

export const Route = createFileRoute("/api/enrich/status")({ server: { handlers: { GET: ({ request }) => { if (!getUserFromRequest(request)) return unauthorized(); return json(enrichStatus()); } } } });
