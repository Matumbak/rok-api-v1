import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { withCors } from "@/lib/cors";
import {
  computeScore,
  type ScoringProfile,
  type SpendingTier,
} from "@/lib/scoring";
import {
  loadBenchmarkLookup,
  rebuildAllBenchmarks,
} from "@/lib/benchmarks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Vercel Cron auto-sends `Authorization: Bearer ${CRON_SECRET}` when
// CRON_SECRET is configured in the project's env vars. Falls back to
// ADMIN_TOKEN for manual debug invocation (same pattern as cleanup).
const CRON_TOKEN = process.env.CRON_SECRET ?? process.env.ADMIN_TOKEN;

/**
 * Daily recompute pass. Runs after a quiet hour to:
 *   1. Refresh all 24 cohort calibrations from approved applications
 *      (incremental — each PATCH-to-approved already triggers its own
 *      cohort, but this guards against missed events / out-of-band edits).
 *   2. Re-score EVERY application with the freshly-blended anchors. Without
 *      this, an applicant scored last week against stale anchors would
 *      keep their old score until something else triggered a recompute.
 *
 * Auth: Bearer token (matches the cleanup route pattern). Vercel Cron
 * sends Authorization automatically when configured via vercel.json.
 *
 * Idempotent — re-running produces the same result.
 */
export async function POST(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token || !CRON_TOKEN || token !== CRON_TOKEN) {
    return withCors(
      request,
      NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    );
  }

  const t0 = Date.now();
  // Phase 1: rebuild all KvK benchmarks from BenchmarkUpload records
  // (sample-weighted blend of uploads + hardcoded priors).
  await rebuildAllBenchmarks();
  // Phase 2: re-score all rows with the fresh benchmarks. Loaded once,
  // reused for every row — no per-row DB round trips.
  const lookup = await loadBenchmarkLookup();
  const apps = await prisma.migrationApplication.findMany({
    select: {
      id: true,
      accountBornAt: true,
      vipLevel: true,
      powerN: true,
      killPointsN: true,
      t1KillsN: true,
      t2KillsN: true,
      t3KillsN: true,
      t4KillsN: true,
      t5KillsN: true,
      deathsN: true,
      maxValorPointsN: true,
      prevKvkT4KillsN: true,
      prevKvkT5KillsN: true,
      prevKvkDeathsN: true,
      prevKvkRank: true,
      prevKvkScanActiveCount: true,
      detectedSeed: true,
      spendingTier: true,
      scoringProfile: true,
      overallScore: true,
    },
  });

  let updated = 0;
  let unchanged = 0;
  for (const app of apps) {
    const result = computeScore(
      {
        accountBornAt: app.accountBornAt,
        vipLevel: app.vipLevel,
        powerN: app.powerN,
        killPointsN: app.killPointsN,
        t1KillsN: app.t1KillsN,
        t2KillsN: app.t2KillsN,
        t3KillsN: app.t3KillsN,
        t4KillsN: app.t4KillsN,
        t5KillsN: app.t5KillsN,
        deathsN: app.deathsN,
        maxValorPointsN: app.maxValorPointsN,
        prevKvkT4KillsN: app.prevKvkT4KillsN,
        prevKvkT5KillsN: app.prevKvkT5KillsN,
        prevKvkDeathsN: app.prevKvkDeathsN,
        prevKvkRank: app.prevKvkRank ?? null,
        prevKvkScanActiveCount: app.prevKvkScanActiveCount ?? null,
        detectedSeed: app.detectedSeed ?? null,
        spendingTier: app.spendingTier as SpendingTier | null,
        scoringProfile: app.scoringProfile as ScoringProfile | null,
      },
      lookup,
    );
    if (
      app.overallScore != null &&
      Math.abs(app.overallScore - result.score) < 0.05
    ) {
      unchanged++;
      continue;
    }
    await prisma.migrationApplication.update({
      where: { id: app.id },
      data: {
        overallScore: result.score,
        tags: result.tags as unknown as Prisma.InputJsonValue,
      },
    });
    updated++;
  }

  const benchmarks = await prisma.kvkBenchmark.findMany({
    select: { kvkId: true, sampleCount: true },
  });
  return withCors(
    request,
    NextResponse.json({
      ok: true,
      ms: Date.now() - t0,
      benchmarks,
      apps: { total: apps.length, updated, unchanged },
    }),
  );
}

// Allow GET for manual debug invocation (same auth).
export async function GET(request: Request) {
  return POST(request);
}
