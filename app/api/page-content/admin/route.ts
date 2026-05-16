import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { withCors } from "@/lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin GET — returns the same `{ overrides: { locale: { key: value } } }`
 * shape as the public endpoint. Admin doesn't need the static defaults
 * over the wire; those live in rok-admin's catalogue and are rendered
 * alongside the override fields for orientation.
 */
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const rows = await prisma.pageContent.findMany({
      orderBy: [{ locale: "asc" }, { key: "asc" }],
    });
    const overrides: Record<string, Record<string, string>> = {};
    for (const r of rows) {
      if (!overrides[r.locale]) overrides[r.locale] = {};
      overrides[r.locale][r.key] = r.value;
    }
    return withCors(request, NextResponse.json({ overrides }));
  } catch (err) {
    return withCors(
      request,
      NextResponse.json({ error: (err as Error).message }, { status: 500 }),
    );
  }
}

const upsertSchema = z.object({
  locale: z.string().min(2).max(8),
  key: z
    .string()
    .min(1)
    .max(200)
    // Dotted i18n keys are lowercase ASCII identifiers separated by dots.
    .regex(/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)*$/, {
      message: "key must be a dotted identifier (e.g. hero.title)",
    }),
  /// Empty value = revert to default (delete the override row).
  value: z.string().max(4000),
});

/**
 * Admin PUT — upsert one override at a time. Sending an empty `value`
 * deletes the row, which makes the landing fall back to the static
 * default in translations.ts. Use this instead of a separate DELETE
 * so the editor can "save / revert" with one verb.
 */
export async function PUT(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    const { locale, key, value } = upsertSchema.parse(body);

    if (value.trim().length === 0) {
      // Revert — drop the override so the static default takes over.
      await prisma.pageContent
        .delete({ where: { locale_key: { locale, key } } })
        .catch(() => null);
      return withCors(request, NextResponse.json({ ok: true, reverted: true }));
    }

    const row = await prisma.pageContent.upsert({
      where: { locale_key: { locale, key } },
      update: { value },
      create: { locale, key, value },
    });
    return withCors(request, NextResponse.json(row));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return withCors(
        request,
        NextResponse.json(
          { error: "validation_failed", issues: err.issues },
          { status: 400 },
        ),
      );
    }
    return withCors(
      request,
      NextResponse.json({ error: (err as Error).message }, { status: 500 }),
    );
  }
}
