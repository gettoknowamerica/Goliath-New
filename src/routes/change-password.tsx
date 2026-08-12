import { createFileRoute, useSearch } from "@tanstack/react-router";

// GET /change-password — requires a valid session (serve.ts redirects to /login
// when the signed cookie is missing/expired). Shown automatically after first
// login because the seeded admin has must_change_password=1; also reachable any
// time to rotate the password. POSTs to /api/auth/password.
export const Route = createFileRoute("/change-password")({ component: ChangePasswordPage });

const ERRORS: Record<string, string> = {
  missing: "Please fill in all three fields.",
  current: "Your current password is incorrect.",
  weak: "New password must be at least 8 characters.",
  same: "New password must be different from the current one.",
  server: "Something went wrong. Please try again.",
};

function ChangePasswordPage() {
  const search = useSearch({ strict: false }) as { error?: string };
  const error = search.error ? (ERRORS[search.error] ?? "Something went wrong. Please try again.") : null;

  return (
    <main className="carbon-bg flex min-h-screen items-center justify-center px-5 text-slate-200">
      <div className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-[#0d1119]/90 p-8 shadow-[0_0_60px_rgba(245,158,11,0.08)]">
        <div className="mb-6 flex flex-col items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-b from-amber-300 to-amber-500 text-xl font-black text-amber-950 shadow-[0_0_24px_rgba(245,158,11,0.35)]">L</div>
          <div className="text-center">
            <div className="text-lg font-bold tracking-tight text-white">Set your password</div>
            <div className="text-xs text-slate-400">First sign-in — choose a password you'll keep.</div>
          </div>
        </div>
        {error && (
          <p className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs font-semibold text-rose-300">{error}</p>
        )}
        <form method="post" action="/api/auth/password" className="space-y-4">
          <div>
            <label htmlFor="current" className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-400">Current password</label>
            <input id="current" name="current" type="password" required autoComplete="current-password" autoFocus
              className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-amber-400/50" />
          </div>
          <div>
            <label htmlFor="new" className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-400">New password</label>
            <input id="new" name="new" type="password" required minLength={8} autoComplete="new-password"
              className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-amber-400/50" />
            <p className="mt-1 text-[11px] text-slate-500">At least 8 characters, different from the current password.</p>
          </div>
          <div>
            <label htmlFor="confirm" className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-400">Confirm new password</label>
            <input id="confirm" name="confirm" type="password" required minLength={8} autoComplete="new-password"
              className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-amber-400/50" />
          </div>
          <button type="submit"
            className="w-full rounded-xl bg-gradient-to-b from-amber-300 to-amber-500 px-4 py-3 text-sm font-black text-amber-950 transition hover:from-amber-200 hover:to-amber-400">
            Set password
          </button>
        </form>
        <p className="mt-5 text-center text-[11px] text-slate-500">After this, your session is rotated and you'll land in Mission Control.</p>
      </div>
    </main>
  );
}
