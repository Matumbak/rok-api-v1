import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { withCors } from "@/lib/cors";
import { deleteBlobs, listMigrationBlobs } from "@/lib/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CLEANUP_TOKEN = process.env.CLEANUP_TOKEN ?? process.env.ADMIN_TOKEN;
const ORPHAN_GRACE_HOURS = 24;

/**
 * Two-pass blob cleanup.
 *
 *  1. Reviewed apps past `blobCleanupAt` — delete their attached blobs
 *     and clear the screenshots array. The application row itself stays
 *     so the parsed numeric data (which is what we actually want long-term)
 *     remains queryable.
 *
 *  2. Orphans — blobs under `migration/` older than 24h that aren't
 *     referenced by any application's screenshots[].url. Catches abandoned
 *     uploads from users who started filling the form and bailed.
 *
 * Auth: Bearer token. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`
 * automatically when configured via vercel.json — we accept either ADMIN_TOKEN
 * or a dedicated CLEANUP_TOKEN.
 */
export async function POST(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token || !CLEANUP_TOKEN || token !== CLEANUP_TOKEN) {
    return withCors(
      request,
      NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    );
  }

  const summary = {
    expiredApps: 0,
    expiredBlobs: 0,
    orphanBlobs: 0,
    errors: [] as string[],
  };

  try {
    // Pass 1 — expired reviewed apps.
    const expired = await prisma.migrationApplication.findMany({
      where: {
        blobCleanupAt: { lte: new Date() },
        screenshots: { not: Prisma.JsonNull },
      },
      select: { id: true, screenshots: true },
    });

    for (const app of expired) {
      const urls = Array.isArray(app.screenshots)
        ? (app.screenshots as Array<{ url?: string }>)
            .map((s) => s?.url)
            .filter((u): u is string => typeof u === "string")
        : [];
      if (urls.length === 0) continue;
      try {
        await deleteBlobs(urls);
        await prisma.migrationApplication.update({
          where: { id: app.id },
          data: { screenshots: [] as unknown as Prisma.InputJsonValue },
        });
        summary.expiredApps += 1;
        summary.expiredBlobs += urls.length;
      } catch (err) {
        summary.errors.push(
          `app=${app.id}: ${(err as Error).message ?? "unknown"}`,
        );
      }
    }

    // Pass 2 — orphan blobs.
    const referenced = new Set<string>();
    const all = await prisma.migrationApplication.findMany({
      select: { screenshots: true },
    });
    for (const app of all) {
      if (Array.isArray(app.screenshots)) {
        for (const s of app.screenshots as Array<{ url?: string }>) {
          if (s?.url) referenced.add(s.url);
        }
      }
    }

    const cutoff = Date.now() - ORPHAN_GRACE_HOURS * 60 * 60 * 1000;
    let cursor: string | undefined;
    const orphans: string[] = [];
    do {
      const page = await listMigrationBlobs(cursor);
      for (const blob of page.blobs) {
        const uploadedAt = new Date(blob.uploadedAt).getTime();
        if (uploadedAt > cutoff) continue;
        if (referenced.has(blob.url)) continue;
        orphans.push(blob.url);
      }
      cursor = page.cursor;
    } while (cursor);

    if (orphans.length > 0) {
      // Delete in chunks of 100 — Vercel Blob's del() accepts arrays but
      // we keep it modest to avoid serializing too much in a single call.
      for (let i = 0; i < orphans.length; i += 100) {
        const chunk = orphans.slice(i, i + 100);
        try {
          await deleteBlobs(chunk);
          summary.orphanBlobs += chunk.length;
        } catch (err) {
          summary.errors.push(
            `orphan-chunk=${i}: ${(err as Error).message ?? "unknown"}`,
          );
        }
      }
    }

    return withCors(request, NextResponse.json(summary));
  } catch (err) {
    return withCors(
      request,
      NextResponse.json(
        { error: (err as Error).message ?? "internal_error", summary },
        { status: 500 },
      ),
    );
  }
}

/** GET helper — Vercel Cron uses GET by default. */
export async function GET(request: Request) {
  return POST(request);
}
