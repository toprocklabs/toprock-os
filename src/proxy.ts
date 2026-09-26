import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isLandingPath, isLockedDown, isPubliclyAllowed, LANDING_HTML } from "@/lib/public-surface";

// Next.js 16 renamed `middleware.ts` to `proxy.ts` and it now defaults to the
// Node.js runtime. See node_modules/next/dist/docs/01-app/03-api-reference/
// 03-file-conventions/proxy.md before changing anything here.
//
// This is the whole public-surface wall (planning/007-private-deployment): in
// production every request that is not on the allowlist gets a bodiless 404,
// which is indistinguishable from a route that was never built. A 403 would
// confirm something is there and being withheld.

export function proxy(request: NextRequest) {
  if (isLockedDown()) {
    const { pathname } = request.nextUrl;

    // Answered here so the dashboard at `/` never runs; see isLandingPath.
    if (isLandingPath(pathname)) {
      return new NextResponse(request.method === "HEAD" ? null : LANDING_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (!isPubliclyAllowed(pathname)) {
      return new NextResponse(null, { status: 404 });
    }
  }

  return NextResponse.next();
}

export const config = {
  // Runs on everything. The allowlist decides, not the matcher, so there is one
  // place to read and one place to change.
  matcher: "/:path*",
};
