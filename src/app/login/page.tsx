import { login, redirectIfAuthenticated } from "@/app/login/actions";
import { safeNextPath } from "@/lib/public-surface";

type LoginPageProps = {
  searchParams: Promise<{ error?: string; next?: string }>;
};

const errorMessages: Record<string, string> = {
  invalid: "Invalid username or password.",
  config: "Server is missing DATABASE_URL.",
  throttled: "Too many sign-in attempts. Try again in 15 minutes.",
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  await redirectIfAuthenticated();

  const params = await searchParams;
  const next = safeNextPath(params.next);
  const errorText = params.error ? errorMessages[params.error] ?? "Unable to sign in." : null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-10">
      <div className="rounded-xl border border-slate-200/95 bg-white p-8 shadow-sm">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Toprock CRM
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-900">Sign in</h1>
        <p className="mt-2 text-sm text-slate-600">Use your team username and password to access the Toprock CRM workspace.</p>

        {errorText ? (
          <p className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{errorText}</p>
        ) : null}

        <form action={login} className="mt-6 space-y-4">
          {next ? <input type="hidden" name="next" value={next} /> : null}
          <label className="flex flex-col gap-1 text-sm text-slate-700">
            <span>Username</span>
            <input
              name="username"
              required
              autoComplete="username"
              className="rounded-md border border-slate-300 px-3 py-2 text-slate-900 outline-none transition focus:border-slate-500"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm text-slate-700">
            <span>Password</span>
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="rounded-md border border-slate-300 px-3 py-2 text-slate-900 outline-none transition focus:border-slate-500"
            />
          </label>

          <button
            type="submit"
            className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
