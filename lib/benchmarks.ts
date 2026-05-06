/**
 * KvK benchmark ingestion + lookup.
 *
 * Workflow:
 *   1. Admin uploads xlsx + kvkId via /api/benchmarks/upload
 *   2. processScanForBenchmark() parses rows, filters active fighters,
 *      computes per-stat percentiles for THAT scan
 *   3. The aggregate (per-scan percentiles, no raw rows) is saved as a
 *      BenchmarkUpload record
 *   4. rebuildBenchmark(kvkId) re-derives the canonical KvkBenchmark
 *      for that kvkId by sample-weighted blending across all uploads
 *      for the same kvkId
 *   5. computeScore reads via loadBenchmarkLookup() — falls back to
 *      KVK_PRIORS for kvkIds with no upload yet
 *
 * Per user direction: NO row storage. Only per-scan aggregate percentiles
 * + rowCount get persisted, which is enough to rebuild the merged
 * benchmark without retaining individual governor data.
 */

import { prisma } from "@/lib/db";
import {
  KVK_IDS,
  KVK_PRIORS,
  type BenchmarkLookup,
  type KvkBenchmarkStats,
  type KvkId,
  type PercentileAnchors,
} from "@/lib/scoring";

const STAT_KEYS = [
  "power",
  "kp",
  "t5",
  "deaths",
  "acclaim",
  "dkp",
] as const;
type StatKey = (typeof STAT_KEYS)[number];

/** Linear-interpolation percentile. Same impl as in calibration.ts; kept
 *  local to avoid cross-module coupling. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

/** A parsed scan row in the shape we need for benchmark computation.
 *  Mirrors what parseDkpXlsx returns (numeric columns we care about).
 *  Unknown / missing values are null. */
export interface ScanRow {
  power: number | null; // current power
  startPower: number | null; // optional, ignored unless power missing
  t4: number | null; // T4 kills DURING this KvK
  t5: number | null; // T5 kills DURING this KvK
  deaths: number | null; // deaths DURING this KvK
  kp: number | null; // KP gained DURING this KvK (T4 + T5)
  acclaim: number | null; // valor (acclaim) earned DURING this KvK
  dkp: number | null; // DKP composite DURING this KvK
}

/** Compute the per-stat percentile distribution for an uploaded scan.
 *  Filters active fighters: dkp > 0 OR t5 > 100K. Returns the aggregate
 *  ready to persist as BenchmarkUpload.stats.
 *
 *  rowCount in the result is the count of ACTIVE fighters (after filter),
 *  not raw row count. That's what the weighted-blend math needs. */
export function processScanForBenchmark(rows: ScanRow[]): {
  stats: KvkBenchmarkStats;
  rowCount: number;
} {
  const active = rows.filter((r) => {
    const dkp = r.dkp ?? 0;
    const t5 = r.t5 ?? 0;
    return dkp > 0 || t5 > 100_000;
  });

  const buckets: Record<StatKey, number[]> = {
    power: [],
    kp: [],
    t5: [],
    deaths: [],
    acclaim: [],
    dkp: [],
  };

  for (const r of active) {
    if (r.power != null && r.power > 0) buckets.power.push(r.power);
    else if (r.startPower != null && r.startPower > 0)
      buckets.power.push(r.startPower);
    if (r.kp != null && r.kp > 0) buckets.kp.push(r.kp);
    if (r.t5 != null && r.t5 > 0) buckets.t5.push(r.t5);
    if (r.deaths != null && r.deaths > 0) buckets.deaths.push(r.deaths);
    if (r.acclaim != null && r.acclaim > 0) buckets.acclaim.push(r.acclaim);
    if (r.dkp != null && r.dkp > 0) buckets.dkp.push(r.dkp);
  }

  const stats = {} as KvkBenchmarkStats;
  for (const k of STAT_KEYS) {
    const vals = buckets[k];
    vals.sort((a, b) => a - b);
    if (vals.length === 0) {
      // No data for this stat — fall back to a tiny placeholder; shouldn't
      // dominate after blending with priors. Caller can choose to drop
      // this scan if pathological.
      stats[k] = { p50: 0, p80: 0, p95: 0, p99: 0 };
    } else {
      stats[k] = {
        p50: Math.round(percentile(vals, 0.5)),
        p80: Math.round(percentile(vals, 0.8)),
        p95: Math.round(percentile(vals, 0.95)),
        p99: Math.round(percentile(vals, 0.99)),
      };
    }
  }

  return { stats, rowCount: active.length };
}

/** Sample-weighted average of percentiles across multiple uploads. Each
 *  scan's percentile is weighted by its rowCount; bigger scans pull more.
 *  Includes the hardcoded prior with weight = PRIOR_WEIGHT (acts as a
 *  Bayesian shrinkage that fades as real samples accumulate). */
const PRIOR_WEIGHT = 50;

function blend(
  prior: PercentileAnchors,
  uploads: { weight: number; anchors: PercentileAnchors }[],
): PercentileAnchors {
  let totalWeight = PRIOR_WEIGHT;
  let p50 = PRIOR_WEIGHT * prior.p50;
  let p80 = PRIOR_WEIGHT * prior.p80;
  let p95 = PRIOR_WEIGHT * prior.p95;
  let p99 = PRIOR_WEIGHT * prior.p99;
  for (const u of uploads) {
    totalWeight += u.weight;
    p50 += u.weight * u.anchors.p50;
    p80 += u.weight * u.anchors.p80;
    p95 += u.weight * u.anchors.p95;
    p99 += u.weight * u.anchors.p99;
  }
  return {
    p50: Math.round(p50 / totalWeight),
    p80: Math.round(p80 / totalWeight),
    p95: Math.round(p95 / totalWeight),
    p99: Math.round(p99 / totalWeight),
  };
}

/** Rebuild the canonical KvkBenchmark for one kvkId by blending every
 *  BenchmarkUpload for that kvkId with the hardcoded prior. Idempotent —
 *  safe to re-run on every upload or as part of a cron. */
export async function rebuildBenchmark(kvkId: KvkId): Promise<void> {
  const uploads = await prisma.benchmarkUpload.findMany({
    where: { kvkId },
    select: { stats: true, rowCount: true },
  });

  if (uploads.length === 0) {
    // No real data — drop the cached benchmark so lookup falls back to
    // KVK_PRIORS. deleteMany is non-throwing.
    await prisma.kvkBenchmark.deleteMany({ where: { kvkId } });
    return;
  }

  const prior = KVK_PRIORS[kvkId];
  const blended = {} as KvkBenchmarkStats;
  let totalSamples = 0;

  for (const k of STAT_KEYS) {
    const uploadAnchors = uploads
      .map((u) => {
        const s = u.stats as unknown as KvkBenchmarkStats;
        return { weight: u.rowCount, anchors: s[k] };
      })
      // Drop pathological zeros so they don't poison the blend.
      .filter((u) => u.anchors.p99 > 0);
    blended[k] = blend(prior[k], uploadAnchors);
  }

  for (const u of uploads) totalSamples += u.rowCount;

  await prisma.kvkBenchmark.upsert({
    where: { kvkId },
    create: {
      kvkId,
      stats: blended as unknown as object,
      sampleCount: totalSamples,
    },
    update: {
      stats: blended as unknown as object,
      sampleCount: totalSamples,
    },
  });
}

/** Rebuild every kvkId. Used by the daily cron. */
export async function rebuildAllBenchmarks(): Promise<void> {
  for (const k of KVK_IDS) {
    await rebuildBenchmark(k);
  }
}

/** Load all KvkBenchmark rows and return a lookup function suitable to
 *  pass to computeScore(). For kvkIds with no benchmark row (no scans
 *  uploaded yet) returns the hardcoded prior. Caller pattern: load once
 *  per request / batch, reuse across many computeScore() calls. */
export async function loadBenchmarkLookup(): Promise<BenchmarkLookup> {
  const rows = await prisma.kvkBenchmark.findMany();
  const map = new Map<string, KvkBenchmarkStats>();
  for (const r of rows) {
    map.set(r.kvkId, r.stats as unknown as KvkBenchmarkStats);
  }
  return (kvkId: KvkId) => map.get(kvkId) ?? KVK_PRIORS[kvkId];
}
