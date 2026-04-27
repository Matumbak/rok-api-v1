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
 */
export function proxy(request: NextRequest) {
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
