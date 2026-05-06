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

/** Seed-group bucket. Pre-SoC KvKs (kvk1-4) always use "general"
 *  (no seed split — pre-SoC seeds aren't meaningful enough to bother).
 *  SoC scans get partitioned by the source kingdom's seed, computed
 *  from KingdomSeed lookups against the row-level KD column. */
export type SeedBucket =
  | "general"
  | "Imperium"
  | "A"
  | "B"
  | "C"
  | "D";

export const SEED_BUCKETS: SeedBucket[] = [
  "general",
  "Imperium",
  "A",
  "B",
  "C",
  "D",
];

/** Min rows per seed bucket before a SoC scan upload contributes to that
 *  bucket's benchmark. Tiny shares (n=3 from a single AoC seed) would
 *  add too much noise to the bucket's percentiles. */
const MIN_SEED_BUCKET_ROWS = 20;

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
  /** Source kingdom_id from the row's KD column. Used during SoC
   *  ingestion to look up the row's home seed. */
  kd: number | null;
}

/** Compute the per-stat percentile distribution for a set of rows.
 *  Filters active fighters: dkp > 0 OR t5 > 100K. */
function rowsToStats(rows: ScanRow[]): {
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

/** LK / "general" path — single bucket, all rows aggregated together.
 *  Used for kvk1-4 uploads where seed splits aren't meaningful. */
export function processScanForBenchmark(rows: ScanRow[]): {
  stats: KvkBenchmarkStats;
  rowCount: number;
} {
  return rowsToStats(rows);
}

/** SoC path — partition rows by their home-kingdom seed (looked up from
 *  KingdomSeed via the KD column). Returns one aggregate per seed bucket
 *  whose row count meets MIN_SEED_BUCKET_ROWS. Buckets with too few rows
 *  fall through to "general" (still aggregated, won't update seed-
 *  specific benchmarks).
 *
 *  classifierMode controls how seeds are determined for rows where the
 *  KD-based lookup misses (kingdom not in KingdomSeed):
 *    "kingdom_seed" → drop the row (Phase 1 / recent scans)
 *    "auto_classify" → infer seed from row's stat signature (Phase 2,
 *                     used when scan is older than the freshness window) */
export async function processScanForSocBenchmark(
  rows: ScanRow[],
  classifierMode: "kingdom_seed" | "auto_classify" = "kingdom_seed",
): Promise<
  Array<{
    seed: SeedBucket;
    seedSource: "kingdom_seed" | "auto_classify" | "general";
    stats: KvkBenchmarkStats;
    rowCount: number;
  }>
> {
  // Pre-load KingdomSeed map once.
  const seedMap = new Map<number, string>(
    (await prisma.kingdomSeed.findMany({
      select: { kingdomId: true, seed: true },
    })).map((k) => [k.kingdomId, k.seed]),
  );

  const partitions = new Map<SeedBucket, ScanRow[]>();
  for (const seed of SEED_BUCKETS) partitions.set(seed, []);

  // Phase 2 stub — auto-classification engine. Computes a row's seed
  // from its stat signature against established seed benchmarks. Only
  // kicks in when classifierMode === "auto_classify" AND we already
  // have soc seed benchmarks loaded. Falls back to "general" otherwise.
  let classifyFn: ((r: ScanRow) => SeedBucket) | null = null;
  if (classifierMode === "auto_classify") {
    classifyFn = await buildSocSeedClassifier();
  }

  for (const r of rows) {
    let seed: SeedBucket | null = null;
    if (r.kd != null && seedMap.has(r.kd)) {
      const homeSeed = seedMap.get(r.kd)!;
      if ((SEED_BUCKETS as string[]).includes(homeSeed)) {
        seed = homeSeed as SeedBucket;
      }
    }
    if (seed == null && classifyFn != null) {
      seed = classifyFn(r);
    }
    if (seed == null) seed = "general";
    partitions.get(seed)!.push(r);
  }

  const out: Array<{
    seed: SeedBucket;
    seedSource: "kingdom_seed" | "auto_classify" | "general";
    stats: KvkBenchmarkStats;
    rowCount: number;
  }> = [];
  for (const seed of SEED_BUCKETS) {
    const rs = partitions.get(seed)!;
    const { stats, rowCount } = rowsToStats(rs);
    if (rowCount === 0) continue;
    if (seed !== "general" && rowCount < MIN_SEED_BUCKET_ROWS) {
      // Tiny seed bucket — skip. Don't roll into general either to keep
      // the seed signal clean.
      continue;
    }
    out.push({
      seed,
      seedSource:
        seed === "general"
          ? "general"
          : classifierMode === "auto_classify"
            ? "auto_classify"
            : "kingdom_seed",
      stats,
      rowCount,
    });
  }
  return out;
}

/** Build a function that classifies a single ScanRow into the closest
 *  matching seed by L2 distance over log-stats. Returns null if there
 *  aren't enough seed benchmarks established yet to classify reliably
 *  (need at least 3 of 5 SoC seed cells populated). */
async function buildSocSeedClassifier(): Promise<
  ((r: ScanRow) => SeedBucket) | null
> {
  const rows = await prisma.kvkBenchmark.findMany({
    where: { kvkId: "soc", seed: { in: ["Imperium", "A", "B", "C", "D"] } },
  });
  if (rows.length < 3) return null;

  // Build seed-signature vectors — log-scaled p99 of (kp, dkp, t5, deaths)
  const sig = (s: KvkBenchmarkStats) => [
    Math.log10(Math.max(1, s.kp.p99)),
    Math.log10(Math.max(1, s.dkp.p99)),
    Math.log10(Math.max(1, s.t5.p99)),
    Math.log10(Math.max(1, s.deaths.p99)),
  ];
  const seedSigs: { seed: SeedBucket; sig: number[] }[] = rows.map((r) => ({
    seed: r.seed as SeedBucket,
    sig: sig(r.stats as unknown as KvkBenchmarkStats),
  }));

  return (r: ScanRow) => {
    const rowSig = [
      Math.log10(Math.max(1, r.kp ?? 0)),
      Math.log10(Math.max(1, r.dkp ?? 0)),
      Math.log10(Math.max(1, r.t5 ?? 0)),
      Math.log10(Math.max(1, r.deaths ?? 0)),
    ];
    let best: SeedBucket = "general";
    let bestDist = Infinity;
    for (const { seed, sig: s } of seedSigs) {
      let d = 0;
      for (let i = 0; i < 4; i++) d += (rowSig[i] - s[i]) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = seed;
      }
    }
    return best;
  };
}

/** Sample-weighted average of percentiles across uploads. Each scan's
 *  percentile is weighted by its rowCount; bigger scans pull more.
 *
 *  PRIOR_WEIGHT = 0 — when ANY upload exists for a kvkId, the benchmark
 *  is purely data-driven. The hardcoded KVK_PRIORS in lib/scoring.ts
 *  are kept ONLY as a code-level fallback for kvkIds that have zero
 *  uploads (rebuildBenchmark drops the row → loadBenchmarkLookup serves
 *  the prior). This keeps the system from degenerating before scans are
 *  uploaded for a phase but ensures hardcoded "guesses" don't pollute
 *  benchmarks once real data arrives.
 *
 *  Trade-off: a single small noisy scan (n=200) becomes 100% of that
 *  kvkId's benchmark. The user can mitigate by uploading multiple scans
 *  per kvkId — the rowCount-weighted blend smooths noise. */
const PRIOR_WEIGHT = 0;

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

/** Rebuild the canonical KvkBenchmark for one (kvkId, seed) cell by
 *  blending every BenchmarkUpload tagged with that pair, with the
 *  hardcoded prior. Idempotent — safe to re-run on every upload or as
 *  part of a cron.
 *
 *  When seed != "general" but the cell has zero uploads, the row is
 *  dropped so lookup falls back to general (or to KVK_PRIORS if even
 *  general is empty). */
export async function rebuildBenchmark(
  kvkId: KvkId,
  seed: SeedBucket = "general",
): Promise<void> {
  // Special-case soc:general — it represents the tier-blind average
  // active SoC fighter across all seeds. Aggregate ALL soc uploads,
  // not just the (rare) seed=general ones, so the main tier-blind
  // score has a meaningful population baseline. For per-seed cells
  // (soc:Imperium / A / B / C / D) we keep the strict filter.
  const uploads =
    kvkId === "soc" && seed === "general"
      ? await prisma.benchmarkUpload.findMany({
          where: { kvkId },
          select: { stats: true, rowCount: true },
        })
      : await prisma.benchmarkUpload.findMany({
          where: { kvkId, seed },
          select: { stats: true, rowCount: true },
        });

  if (uploads.length === 0) {
    await prisma.kvkBenchmark.deleteMany({ where: { kvkId, seed } });
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
      .filter((u) => u.anchors.p99 > 0);
    // No non-zero upload data for this stat → fall back to hardcoded
    // prior. NOTE on acclaim: a previous version persisted {0,0,0,0}
    // here on the assumption that "all uploads zero = mechanic didn't
    // exist in this KvK". That's wrong: RoK kingdoms run on staggered
    // timelines (a new kingdom is born almost daily), so any given
    // kvkId number includes scans from kingdoms that ran that KvK in
    // very different calendar eras. A "kvk1" scan from a newly-born
    // kingdom today has acclaim; a "kvk15" scan from an early-2020
    // kingdom may not. Persisting 0 would erase the prior that lets
    // recent-era applicants get a sensible valor expectation.
    blended[k] =
      uploadAnchors.length === 0 ? prior[k] : blend(prior[k], uploadAnchors);
  }

  for (const u of uploads) totalSamples += u.rowCount;

  await prisma.kvkBenchmark.upsert({
    where: { kvkId_seed: { kvkId, seed } },
    create: {
      kvkId,
      seed,
      stats: blended as unknown as object,
      sampleCount: totalSamples,
    },
    update: {
      stats: blended as unknown as object,
      sampleCount: totalSamples,
    },
  });
}

/** Rebuild every kvkId × seed cell. Used by the daily cron. */
export async function rebuildAllBenchmarks(): Promise<void> {
  for (const k of KVK_IDS) {
    if (k === "soc") {
      // SoC has 6 cells: general (legacy / fallback) + 5 seeds.
      for (const seed of SEED_BUCKETS) {
        await rebuildBenchmark(k, seed);
      }
    } else {
      // LK KvKs (kvk1-4) only have the general bucket.
      await rebuildBenchmark(k, "general");
    }
  }
}

/** Load all KvkBenchmark rows and return a lookup function suitable to
 *  pass to computeScore(). The lookup is seed-aware:
 *
 *    For LK KvKs (kvk1-4) the seed param is ignored — always returns
 *    the general benchmark (or KVK_PRIORS fallback).
 *
 *    For "soc" the lookup checks `(soc, <seed>)` first, then falls back
 *    to `(soc, general)` if that seed isn't established yet, then to
 *    KVK_PRIORS.soc. This way an applicant detected as B-seed gets
 *    B-seed scoring when available, and graceful fallback otherwise.
 *
 *  Caller pattern: load once per request / batch, reuse across many
 *  computeScore() calls. */
export async function loadBenchmarkLookup(): Promise<BenchmarkLookup> {
  const rows = await prisma.kvkBenchmark.findMany();
  const map = new Map<string, KvkBenchmarkStats>();
  for (const r of rows) {
    map.set(`${r.kvkId}|${r.seed}`, r.stats as unknown as KvkBenchmarkStats);
  }
  return (kvkId: KvkId, seed?: string) => {
    if (kvkId === "soc" && seed && seed !== "general") {
      const seedHit = map.get(`soc|${seed}`);
      if (seedHit) return seedHit;
    }
    return map.get(`${kvkId}|general`) ?? KVK_PRIORS[kvkId];
  };
}
