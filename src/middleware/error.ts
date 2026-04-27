import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "validation_failed",
      issues: err.issues,
    });
  }

  if (err instanceof Error) {
    console.error("[error]", err);
    return res.status(500).json({ error: err.message });
  }

  return res.status(500).json({ error: "internal_error" });
}
