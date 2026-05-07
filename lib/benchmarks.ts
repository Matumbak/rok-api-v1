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
/** v2 bucket vocabulary. Replaces the v1 seed-only split (Imperium /
 *  A / B / C / D / general) with a 2-D partition: home-kingdom seed
 *  × within-kingdom KP rank. Imperium stays as a single bucket — the
 *  whole roster of a top-24 kingdom already counts as elite, so an
 *  internal high/mid/low split adds noise without meaning.
 *
 *  Tier suffix is assigned per row at ingest time:
 *    high → top 10% by KP within the row's home kingdom
 *    mid  → next 20% (10–30%)
 *    low  → bottom 70% (30–100%)
 *
 *  `general` stays alongside as a tier- and seed-blind aggregate
 *  used by the main (un-tiered) score and as a fallback when an
 *  applicant's specific bucket has too little data.
 *
 *  v1 buckets ("Imperium", "A"/"B"/"C"/"D", "general") still exist
 *  in the BenchmarkUpload table from past uploads — those rows carry
 *  `seedSource = "kingdom_seed"` or "auto_classify" and are skipped
 *  during v2 rebuilds (they don't have raw rows attached, so they
 *  can't be re-bucketed). They're left in place for audit. */
export type SeedBucket =
  | "general"
  | "imperium"
  | "a-high" | "a-mid" | "a-low"
  | "b-high" | "b-mid" | "b-low"
  | "c-high" | "c-mid" | "c-low"
  | "d-high" | "d-mid" | "d-low";

export const SEED_BUCKETS: SeedBucket[] = [
  "general",
  "imperium",
  "a-high", "a-mid", "a-low",
  "b-high", "b-mid", "b-low",
  "c-high", "c-mid", "c-low",
  "d-high", "d-mid", "d-low",
];

/** Cutoffs for the within-kingdom KP rank → tier mapping.
 *  Top fraction → high; next fraction → mid; rest → low.
 *  E.g. on a 300-row top-300 export: 30/60/210 split.
 *
 *  Tweaking these later is cheap because raw rows are persisted to
 *  BenchmarkUploadRow — `rebuildBenchmark` re-derives the (seed,tier)
 *  splits from rows on every run, so changing these constants and
 *  re-running the rebuild gives a new partition without re-uploading. */
const TIER_CUTOFFS = {
  high: 0.10,         // top 10% by KP
  midUpper: 0.30,     // next 20% (10–30%)
  // remaining 30–100% is "low"
} as const;

/** Two cohorts of v1 seed values still found in legacy uploads. Kept
 *  here so we can recognise + skip them when rebuilding. */
const LEGACY_V1_BUCKETS = new Set([
  "Imperium",
  "A",
  "B",
  "C",
  "D",
]);

type Seed = "Imperium" | "A" | "B" | "C" | "D";
type Tier = "high" | "mid" | "low";

/** Compose a v2 bucket key from a seed + tier. Imperium folds into a
 *  single bucket regardless of tier. */
function bucketFor(seed: Seed, tier: Tier): SeedBucket {
  if (seed === "Imperium") return "imperium";
  return `${seed.toLowerCase()}-${tier}` as SeedBucket;
}

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
  /** Optional — when present, the row's governorId. Persisted alongside
   *  numeric stats so future re-bucketings have audit / traceability. */
  governorId?: string | null;
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

/** SoC path (v2) — partition rows by (home-kingdom seed × within-
 *  kingdom KP rank). Returns one aggregate per (seed × tier) bucket
 *  plus a `general` aggregate that includes every active row.
 *
 *  Steps per scan:
 *    1. Group rows by `homeKingdomId` (resolved via KingdomSeed lookup
 *       for the seed; rows whose KD doesn't resolve fall into general
 *       only).
 *    2. For each kingdom group, sort by KP descending. Top 10% goes to
 *       {seed}-high, next 20% to {seed}-mid, bottom 70% to {seed}-low.
 *       Imperium kingdoms collapse to a single "imperium" bucket.
 *    3. Aggregate per bucket via rowsToStats.
 *
 *  Buckets with rowCount < MIN_SEED_BUCKET_ROWS are dropped (too noisy
 *  to publish). The general bucket has no min threshold — it's the
 *  fallback we always want populated.
 *
 *  classifierMode controls how seeds are determined for rows whose KD
 *  doesn't appear in KingdomSeed (e.g. very old scans, KDs that
 *  hadn't shipped at scrape time):
 *    "kingdom_seed"  → drop those rows (recent scans)
 *    "auto_classify" → infer seed from stat signature against
 *                      established benchmarks (best-effort backfill) */
export async function processScanForSocBenchmark(
  rows: ScanRow[],
  classifierMode: "kingdom_seed" | "auto_classify" = "kingdom_seed",
): Promise<
  Array<{
    seed: SeedBucket;
    seedSource: "kingdom_seed_tier" | "auto_classify" | "general";
    stats: KvkBenchmarkStats;
    rowCount: number;
    /** Rows that landed in this bucket. Caller persists them to
     *  BenchmarkUploadRow so future re-bucketings (e.g. tweaked
     *  cutoffs) don't require a re-upload. */
    rows: ScanRow[];
  }>
> {
  // Pre-load KingdomSeed map once.
  const seedMap = new Map<number, Seed>(
    (await prisma.kingdomSeed.findMany({
      select: { kingdomId: true, seed: true },
    }))
      .filter((k) =>
        ["Imperium", "A", "B", "C", "D"].includes(k.seed),
      )
      .map((k) => [k.kingdomId, k.seed as Seed]),
  );

  // Auto-classify fallback for rows without a KingdomSeed entry. The
  // classifier returns one of A/B/C/D/Imperium (legacy seed values),
  // which we then feed into the same tier-ranking pipeline.
  let classifyFn: ((r: ScanRow) => Seed) | null = null;
  if (classifierMode === "auto_classify") {
    classifyFn = await buildSocSeedClassifier();
  }

  /** Resolve a row's home seed. Returns null when neither path works
   *  — those rows still go into the `general` aggregate but get no
   *  (seed × tier) bucket. */
  const resolveSeed = (r: ScanRow): Seed | null => {
    if (r.kd != null && seedMap.has(r.kd)) return seedMap.get(r.kd)!;
    if (classifyFn) return classifyFn(r);
    return null;
  };

  // Group active rows by (homeKingdomId, seed). For seed-only fallback
  // (kingdom not in KingdomSeed but classifier returned a seed) we use
  // the kd value as the kingdom key to keep tier ranking honest. If kd
  // is also missing, we have to skip tiering — treat all such rows as a
  // single "unknown" group ranked together. That group still gets a
  // tier assignment, just an imprecise one.
  type KingdomGroup = {
    seed: Seed;
    rows: ScanRow[];
  };
  const groups = new Map<string, KingdomGroup>();
  for (const r of rows) {
    const seed = resolveSeed(r);
    if (seed == null) continue;
    const key = `${seed}:${r.kd ?? "unknown"}`;
    let g = groups.get(key);
    if (!g) {
      g = { seed, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(r);
  }

  // Bucket rows into the v2 vocabulary by ranking each kingdom's roster
  // by KP. Imperium is the exception — every row from an imperium
  // kingdom drops directly into "imperium" with no tier split.
  const partitions = new Map<SeedBucket, ScanRow[]>();
  for (const b of SEED_BUCKETS) partitions.set(b, []);

  for (const { seed, rows: groupRows } of groups.values()) {
    if (seed === "Imperium") {
      partitions.get("imperium")!.push(...groupRows);
      continue;
    }
    // Sort descending by KP — null KP rows sink to the bottom (low).
    const sorted = [...groupRows].sort((a, b) => {
      const ak = a.kp ?? 0;
      const bk = b.kp ?? 0;
      return bk - ak;
    });
    const n = sorted.length;
    const highEnd = Math.max(1, Math.round(n * TIER_CUTOFFS.high));
    const midEnd = Math.max(
      highEnd + 1,
      Math.round(n * TIER_CUTOFFS.midUpper),
    );
    for (let i = 0; i < n; i++) {
      const tier: Tier = i < highEnd ? "high" : i < midEnd ? "mid" : "low";
      partitions.get(bucketFor(seed, tier))!.push(sorted[i]);
    }
  }

  // The `general` aggregate sees every active row regardless of seed —
  // used as the tier-blind backstop. Note: `rowsToStats` already filters
  // to active fighters (dkp > 0 OR t5 > 100k); we pass the raw row set
  // and let it do that work.
  partitions.get("general")!.push(...rows);

  const out: Array<{
    seed: SeedBucket;
    seedSource: "kingdom_seed_tier" | "auto_classify" | "general";
    stats: KvkBenchmarkStats;
    rowCount: number;
    rows: ScanRow[];
  }> = [];

  for (const bucket of SEED_BUCKETS) {
    const rs = partitions.get(bucket)!;
    const { stats, rowCount } = rowsToStats(rs);
    if (rowCount === 0) continue;
    if (bucket !== "general" && rowCount < MIN_SEED_BUCKET_ROWS) {
      // Bucket too thin — skip publishing. Rows still live in
      // BenchmarkUploadRow so a future rebuild with merged uploads can
      // pick them up.
      continue;
    }
    out.push({
      seed: bucket,
      seedSource:
        bucket === "general"
          ? "general"
          : classifierMode === "auto_classify"
            ? "auto_classify"
            : "kingdom_seed_tier",
      stats,
      rowCount,
      rows: rs,
    });
  }
  return out;
}

/** Build a function that classifies a single ScanRow into the closest
 *  matching seed by L2 distance over log-stats. Returns null if there
 *  aren't enough seed benchmarks established yet to classify reliably.
 *
 *  Reads seed signatures from EITHER the v1 single-seed cells
 *  (Imperium/A/B/C/D — legacy) OR the v2 high-tier cells (imperium/
 *  a-high/b-high/c-high/d-high — current). Whichever has data first
 *  wins. The high-tier cells are a sensible signature anchor because
 *  they capture the most-distinctive end of each seed's distribution. */
async function buildSocSeedClassifier(): Promise<
  ((r: ScanRow) => Seed) | null
> {
  // Try v2 high-tier cells first.
  const v2Rows = await prisma.kvkBenchmark.findMany({
    where: {
      kvkId: "soc",
      seed: { in: ["imperium", "a-high", "b-high", "c-high", "d-high"] },
    },
  });
  // Fall back to v1 cells if v2 rebuild hasn't run yet.
  const v1Rows =
    v2Rows.length >= 3
      ? []
      : await prisma.kvkBenchmark.findMany({
          where: {
            kvkId: "soc",
            seed: { in: Array.from(LEGACY_V1_BUCKETS) },
          },
        });

  const source = v2Rows.length >= 3 ? v2Rows : v1Rows;
  if (source.length < 3) return null;

  // Build seed-signature vectors — log-scaled p99 of (kp, dkp, t5,
  // deaths). Seed key normalised to v1 vocab for downstream use.
  const sig = (s: KvkBenchmarkStats) => [
    Math.log10(Math.max(1, s.kp.p99)),
    Math.log10(Math.max(1, s.dkp.p99)),
    Math.log10(Math.max(1, s.t5.p99)),
    Math.log10(Math.max(1, s.deaths.p99)),
  ];
  const v2ToV1: Record<string, Seed> = {
    imperium: "Imperium",
    "a-high": "A",
    "b-high": "B",
    "c-high": "C",
    "d-high": "D",
  };
  const seedSigs: { seed: Seed; sig: number[] }[] = source.map((r) => ({
    seed: (v2ToV1[r.seed] ?? (r.seed as Seed)) as Seed,
    sig: sig(r.stats as unknown as KvkBenchmarkStats),
  }));

  return (r: ScanRow) => {
    const rowSig = [
      Math.log10(Math.max(1, r.kp ?? 0)),
      Math.log10(Math.max(1, r.dkp ?? 0)),
      Math.log10(Math.max(1, r.t5 ?? 0)),
      Math.log10(Math.max(1, r.deaths ?? 0)),
    ];
    let best: Seed = "D";
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
  // Source-aware filter: skip v1 legacy aggregates so they don't
  // pollute the new (seed × tier) blends. v1 rows are the ones tagged
  // with old seed values (Imperium / A / B / C / D) AND no rows[]
  // attached — flagged via seedSource. Once the user re-uploads, only
  // v2 entries (seedSource = "kingdom_seed_tier" | "general" | "auto_classify")
  // contribute.
  const liveSeedSources = [
    "kingdom_seed_tier",
    "general",
    "auto_classify",
  ];
  const uploads =
    kvkId === "soc" && seed === "general"
      ? await prisma.benchmarkUpload.findMany({
          where: { kvkId, seedSource: { in: liveSeedSources } },
          select: { stats: true, rowCount: true },
        })
      : await prisma.benchmarkUpload.findMany({
          where: {
            kvkId,
            seed,
            seedSource: { in: liveSeedSources },
          },
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
      // SoC v2 has 14 cells: general + imperium + (a/b/c/d) × (high/mid/low).
      for (const seed of SEED_BUCKETS) {
        await rebuildBenchmark(k, seed);
      }
    } else {
      // LK KvKs (kvk1-4) only have the general bucket.
      await rebuildBenchmark(k, "general");
    }
  }

  // Sweep stale v1 cells. After the v2 rebuild the only KvkBenchmark
  // rows we care about are the ones in SEED_BUCKETS; anything else
  // (legacy "Imperium" / "A" / etc.) was deleted by rebuildBenchmark
  // when it ran for that bucket. But if someone changed SEED_BUCKETS
  // and didn't run rebuild for the dropped value, an obsolete row
  // could linger — so we also do an explicit cleanup of soc cells
  // that aren't in the active vocab.
  const known = new Set<string>(SEED_BUCKETS);
  await prisma.kvkBenchmark.deleteMany({
    where: { kvkId: "soc", seed: { notIn: Array.from(known) } },
  });
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
