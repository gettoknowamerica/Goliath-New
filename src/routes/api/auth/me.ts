import { createFileRoute } from "@tanstack/react-router";
import { getUserFromRequest, unauthorized } from "~/auth";
import { json } from "../-helpers";

// GET /api/auth/me — {email, must_change_password} for the current session, or
// 401. The dashboard header uses it to show "Signed in as …" and to detect an
// expired session (redirect to /login).
export const Route = createFileRoute("/api/auth/me")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = getUserFromRequest(request);
        if (!user) return unauthorized();
        return json({ email: user.email, must_change_password: !!user.must_change_password });
      },
    },
  },
});
