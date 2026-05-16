import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  resolveOrigin,
  ALLOWED_HEADERS,
  ALLOWED_METHODS,
} from "@/lib/cors";

/**
 * CORS for /api/*:
 *   - preflight (OPTIONS) → respond 204 with allow headers
 *   - everything else → forward + decorate response with allow headers
 *
 * NOTE: Next.js requires this file to live at the project root as
 * `middleware.ts` (or `src/middleware.ts`) AND export a function named
 * `middleware`. Previously this file was named `proxy.ts` with an
 * export named `proxy`, which Next.js silently ignored — so no
 * preflight handler ran in production, and every cross-origin admin
 * mutation (PATCH/POST/DELETE/PUT) failed at the browser preflight
 * step. The handlers' `withCors()` decorations only set headers on
 * actual responses; they can't satisfy the preflight that the browser
 * sends before the actual request.
 */
export function middleware(request: NextRequest) {
  const origin = resolveOrigin(request);

  // preflight
  if (request.method === "OPTIONS") {
    const res = new NextResponse(null, { status: 204 });
    if (origin) {
      res.headers.set("Access-Control-Allow-Origin", origin);
      res.headers.set("Access-Control-Allow-Credentials", "true");
    }
    res.headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
    res.headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    res.headers.set("Access-Control-Max-Age", "600");
    res.headers.set("Vary", "Origin");
    return res;
  }

  const res = NextResponse.next();
  if (origin) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Access-Control-Allow-Credentials", "true");
    res.headers.set("Vary", "Origin");
  }
  return res;
}

export const config = {
  matcher: ["/api/:path*"],
};
