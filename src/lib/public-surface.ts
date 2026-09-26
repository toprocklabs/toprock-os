// Which paths answer from the internet, and on what terms
// (planning/009-web-ui-behind-login, superseding the lockdown in 007).
//
// Three tiers:
//   public  — the agent API and client SOW pages, each with its own gate
//             (bearer token / proposal PIN). Served to anyone.
//   login   — the sign-in form. Served to anyone, rate-limited in the action.
//   private — everything else, including any route added later. Needs a valid
//             session cookie, checked in the proxy before the route runs.
//
// Default deny: a new route is private until someone adds it here on purpose.

export type Surface = "public" | "login" | "private";

/**
 * How the proxy treats private paths.
 *
 *   open   — local development: the proxy stays out of the way and each page's
 *            own requireUser() redirects to /login.
 *   gated  — production with CRM_WEB_UI=on: private paths need a session.
 *   locked — production otherwise: private paths and /login 404 (plan 007).
 */
export type SurfaceMode = "open" | "gated" | "locked";

/** Exact paths that answer publicly. */
const PUBLIC_EXACT = new Set(["/api/mcp", "/favicon.ico", "/robots.txt"]);

/**
 * Prefixes that answer publicly.
 *
 * `/_next/` is compiled client JS and CSS. Allowing it leaks nothing: those
 * bundles are built from a public repository, and no CRM row is ever baked into
 * one. Server-rendered data is fetched at the page's own path (`/accounts?_rsc=…`)
 * and is gated with the page.
 */
const PUBLIC_PREFIXES = ["/_next/", "/p/", "/api/agent/"];

export const LOGIN_PATH = "/login";

export function classifyPath(pathname: string): Surface {
  if (pathname === LOGIN_PATH) {
    return "login";
  }

  if (PUBLIC_EXACT.has(pathname)) {
    return "public";
  }

  // `/p` alone is not a proposal; `/proposals` must not match the `/p/` prefix,
  // which is why these are compared with the trailing slash included.
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ? "public" : "private";
}

/**
 * Locked in production unless the web UI is explicitly turned on.
 *
 * Keyed off NODE_ENV rather than Vercel's own flag so that a deployment
 * anywhere else is locked too, instead of failing open because one vendor's
 * environment variable happened to be missing. Only the exact value `on` opens
 * the gate, and even then only to signed-in users.
 */
export function surfaceMode(env: NodeJS.ProcessEnv = process.env): SurfaceMode {
  if (env.NODE_ENV !== "production") {
    return "open";
  }

  return env.CRM_WEB_UI === "on" ? "gated" : "locked";
}

/**
 * The post-login destination, if it is a same-origin path.
 *
 * Anything that could leave the site — `//evil.com`, `/\evil.com`, a scheme,
 * control characters — falls back to null so the caller uses `/`.
 */
export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) {
    return null;
  }

  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return null;
  }

  if (/[\u0000-\u001f\u007f\\]/.test(raw)) {
    return null;
  }

  if (raw === LOGIN_PATH || raw.startsWith(`${LOGIN_PATH}?`)) {
    return null;
  }

  return raw;
}
