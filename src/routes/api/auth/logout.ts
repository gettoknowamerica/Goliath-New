import { createFileRoute } from "@tanstack/react-router";
import { isSecureRequest, clearSessionCookieHeader, redirectResponse } from "~/auth";

// POST /api/auth/logout — destroys the session cookie and redirects to /login.
// Works as a plain HTML form post or fetch (SameSite=Lax means a cross-site
// forged POST carries no cookie, so this is a safe no-op for outsiders).
export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secure = isSecureRequest(request);
        return redirectResponse("/login", [clearSessionCookieHeader(secure)]);
      },
    },
  },
});
