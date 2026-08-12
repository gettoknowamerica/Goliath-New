import { createFileRoute } from "@tanstack/react-router";
import { businessTypes, json } from "./-helpers";

export const Route = createFileRoute("/api/business-types")({
  server: { handlers: { GET: () => json({ businessTypes }) } },
});
