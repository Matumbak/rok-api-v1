import type { NextFunction, Request, Response } from "express";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
  // fail-fast at import time so dev doesn't run with a missing token
  // (in production this would be a hard exit; here we just log loudly)
  console.warn(
    "[auth] ADMIN_TOKEN is not set — admin routes will reject all requests.",
  );
}

/**
 * Admin guard — expects `Authorization: Bearer <token>` matching ADMIN_TOKEN.
 * Public GET routes bypass this; mutating routes (POST/PATCH/DELETE) are
 * mounted behind it.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token || !ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}
