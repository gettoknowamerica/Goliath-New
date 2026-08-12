import { createFileRoute } from "@tanstack/react-router";
import { dripStatus } from "~/drip-worker";
import { json } from "../-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";

export const Route = createFileRoute("/api/drip/status")({ server: { handlers: { GET: ({ request }) => { if (!getUserFromRequest(request)) return unauthorized(); return json(dripStatus()); } } } });
