import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { classifyPath, LOGIN_PATH, surfaceMode } from "@/lib/public-surface";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session-token";

// Next.js 16 renamed `middleware.ts` to `proxy.ts` and it now defaults to the
// Node.js runtime. See node_modules/next/dist/docs/01-app/03-api-reference/
// 03-file-conventions/proxy.md before changing anything here.
//
// This is the whole public-surface gate (planning/009-web-ui-behind-login).
// Pages and actions still call requireUser() themselves; this is the second,
// structural layer that holds even if a future page forgets its own check.

export async function proxy(request: NextRequest) {
  const mode = surfaceMode();

  if (mode === "open") {
    return NextResponse.next();
  }

  const surface = classifyPath(request.nextUrl.pathname);

  if (mode === "locked") {
    // Plan 007 behavior: a bodiless 404 is indistinguishable from a route that
    // was never built, where a 403 would confirm something is being withheld.
    if (surface !== "public") {
      return withHeaders(new NextResponse(null, { status: 404 }), surface);
    }

    return withHeaders(NextResponse.next(), surface);
  }

  if (surface === "private") {
    const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);

    if (!session) {
      return withHeaders(unauthenticated(request), surface);
    }
  }

  return withHeaders(NextResponse.next(), surface);
}

function unauthenticated(request: NextRequest) {
  // Server actions POST to the page path; there is nothing sensible to redirect
  // a form submission to, so refuse it outright.
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new NextResponse(null, { status: 401 });
  }

  const target = new URL(LOGIN_PATH, request.url);
  const next = new URL(request.url);
  next.searchParams.delete("_rsc");

  if (next.pathname !== "/" || next.search) {
    target.searchParams.set("next", `${next.pathname}${next.search}`);
  }

  return NextResponse.redirect(target);
}

function withHeaders(response: NextResponse, surface: ReturnType<typeof classifyPath>) {
  response.headers.set("X-Robots-Tag", "noindex, nofollow");

  if (surface !== "public") {
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("Referrer-Policy", "same-origin");
  }

  return response;
}

export const config = {
  // Runs on everything. classifyPath decides, not the matcher, so there is one
  // place to read and one place to change.
  matcher: "/:path*",
};
