import { NextResponse } from "next/server";

const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** True when no whitelist is configured — useful in local dev. */
const allowAll = allowedOrigins.length === 0;

export function resolveOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  if (allowAll) return origin;
  return allowedOrigins.includes(origin) ? origin : null;
}

/**
 * Decorate a NextResponse with CORS headers based on the request's Origin.
 * Intended for use inside route handlers (the middleware already handles
 * preflight + adds default headers; this is a final-mile sanity belt).
 */
export function withCors(request: Request, res: NextResponse): NextResponse {
  const origin = resolveOrigin(request);
  if (origin) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Vary", "Origin");
    res.headers.set("Access-Control-Allow-Credentials", "true");
  }
  return res;
}

export const ALLOWED_HEADERS = "Authorization, Content-Type";
// PUT was added for the page-content upsert endpoint. Keep this list in
// sync with whatever verbs any admin route actually exports — anything
// not listed here gets rejected at preflight.
export const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
