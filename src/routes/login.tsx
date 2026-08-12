import { createFileRoute, useSearch } from "@tanstack/react-router";

// GET /login — clean email+password form. POSTs to /api/auth/login (plain HTML
// form, no JS needed). Errors come back as ?error=… after a 303 redirect.
export const Route = createFileRoute("/login")({ component: LoginPage });

const ERRORS: Record<string, string> = {
  missing: "Please enter both your email and password.",
  invalid: "Incorrect email or password.",
  server: "Something went wrong. Please try again.",
};

function LoginPage() {
  const search = useSearch({ strict: false }) as { error?: string };
  const error = search.error ? (ERRORS[search.error] ?? "Something went wrong. Please try again.") : null;

  return (
    <main className="carbon-bg flex min-h-screen items-center justify-center px-5 text-slate-200">
      <div className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-[#0d1119]/90 p-8 shadow-[0_0_60px_rgba(245,158,11,0.08)]">
        <div className="mb-6 flex flex-col items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-b from-amber-300 to-amber-500 text-xl font-black text-amber-950 shadow-[0_0_24px_rgba(245,158,11,0.35)]">L</div>
          <div className="text-center">
            <div className="text-lg font-bold tracking-tight text-white">LeadForge</div>
            <div className="text-[10px] font-black uppercase tracking-widest text-amber-300">Mission Control</div>
          </div>
        </div>
        {error && (
          <p className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs font-semibold text-rose-300">{error}</p>
        )}
        <form method="post" action="/api/auth/login" className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-400">Email</label>
            <input id="email" name="email" type="email" required autoComplete="username" autoFocus
              className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-amber-400/50" />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-400">Password</label>
            <input id="password" name="password" type="password" required autoComplete="current-password"
              className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2.5 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-amber-400/50" />
          </div>
          <button type="submit"
            className="w-full rounded-xl bg-gradient-to-b from-amber-300 to-amber-500 px-4 py-3 text-sm font-black text-amber-950 transition hover:from-amber-200 hover:to-amber-400">
            Sign in
          </button>
        </form>
        <p className="mt-5 text-center text-[11px] leading-4 text-slate-500">Private access to Mark's LeadForge Mission Control.<br />Only the owner's account can sign in.</p>
      </div>
    </main>
  );
}
