import { NextResponse } from "next/server";
import { withCors } from "./cors";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!ADMIN_TOKEN && typeof process !== "undefined") {
  // surface this loudly during boot — don't crash, but warn
  console.warn(
    "[auth] ADMIN_TOKEN is not set — admin routes will reject all requests.",
  );
}

/**
 * Returns null when authorised; otherwise a 401 NextResponse the caller
 * should return immediately.
 *
 * Usage:
 *   const denied = requireAdmin(request);
 *   if (denied) return denied;
 */
export function requireAdmin(request: Request): NextResponse | null {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token || !ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return withCors(
      request,
      NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    );
  }
  return null;
}
