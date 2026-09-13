// Which paths answer from the internet (planning/007-private-deployment).
//
// The CRM is a local-only app. It is deployed at all for one reason: Grok Bot
// runs in Discord's cloud and cannot reach localhost, so its MCP endpoint has
// to be somewhere public. Client SOW pages come along because clients have to
// open and sign them.
//
// Everything else — including /login — returns 404 in production, so the
// deployment has no authentication surface to attack at all.
//
// Default deny: a route added later is private until someone allowlists it here
// on purpose.

/** Exact paths that answer publicly. */
const ALLOWED_EXACT = new Set(["/api/mcp", "/favicon.ico", "/robots.txt"]);

/** The agent's own endpoints, each gated by CRM_AGENT_TOKEN. */
const ALLOWED_AGENT_PREFIX = "/api/agent/";

/**
 * Prefixes that answer publicly.
 *
 * `/_next/` is compiled client JS and CSS. Allowing it leaks nothing: those
 * bundles are built from a public repository, and no CRM row is ever baked into
 * one. Server-rendered data is fetched at the page's own path (`/accounts?_rsc=…`)
 * and is blocked with the page.
 */
const ALLOWED_PREFIXES = ["/_next/", "/p/", ALLOWED_AGENT_PREFIX];

export function isPubliclyAllowed(pathname: string) {
  if (ALLOWED_EXACT.has(pathname)) {
    return true;
  }

  // `/p` alone is not a proposal; `/proposals` must not match the `/p/` prefix,
  // which is why these are compared with the trailing slash included.
  return ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Locked in production unless explicitly opened.
 *
 * Keyed off NODE_ENV rather than Vercel's own flag so that a deployment
 * anywhere else is locked too, instead of failing open because one vendor's
 * environment variable happened to be missing. `npm run dev` is development, so
 * local work needs no configuration at all.
 */
export function isLockedDown(env: NodeJS.ProcessEnv = process.env) {
  if (env.CRM_PUBLIC_SURFACE === "all") {
    return false;
  }

  return env.NODE_ENV === "production";
}
