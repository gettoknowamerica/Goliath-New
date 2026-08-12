import { createFileRoute } from "@tanstack/react-router";
import { body, businessTypes, generate, json } from "./-helpers";
import { getUserFromRequest, unauthorized } from "~/auth";

export const Route = createFileRoute("/api/generate")({
  server: { handlers: { POST: async ({ request }) => {
    if (!getUserFromRequest(request)) return unauthorized();
    try {
      const input = await body(request);
      if (typeof input.businessType !== "string" || !businessTypes.some((item) => item.id === input.businessType)) return json({ error: "Unknown or missing businessType" }, 400);
      const raw = input.count === undefined ? 10 : Number(input.count);
      if (!Number.isFinite(raw)) return json({ error: "count must be a number" }, 400);
      const count = Math.max(1, Math.min(25, Math.floor(raw)));
      return json({ leads: generate(input.businessType, count) });
    } catch { return json({ error: "Invalid JSON body" }, 400); }
  } } },
});
