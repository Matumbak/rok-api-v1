import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withCors } from "@/lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUBLIC: returns the full override map keyed by locale → dotted-key →
 * value. The landing's I18nProvider fetches this once on mount and
 * merges it on top of the static translations.ts dictionary, so anything
 * overridden by an admin wins over the shipped default.
 *
 * Empty payload (no overrides yet) returns `{ overrides: {} }` — the
 * landing handles it as "use defaults for everything".
 */
export async function GET(request: Request) {
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
