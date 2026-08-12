import { createFileRoute } from "@tanstack/react-router";
import { stopDripRun } from "~/drip-worker";
import { json } from "../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";

export const Route = createFileRoute("/api/drip/stop")({ server: { handlers: { POST: ({ request }) => { if (!getUserFromRequest(request)) return unauthorized(); return json(stopDripRun()); } } } });
