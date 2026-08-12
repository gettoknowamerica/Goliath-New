import { createFileRoute } from "@tanstack/react-router";
import { stopEnrichRun } from "~/enrich-worker";
import { json } from "../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";

export const Route = createFileRoute("/api/enrich/stop")({ server: { handlers: { POST: ({ request }) => { if (!getUserFromRequest(request)) return unauthorized(); return json(stopEnrichRun()); } } } });
