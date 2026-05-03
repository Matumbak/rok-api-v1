/**
 * Self-learning cohort calibration.
 *
 * The hardcoded COHORTS table in lib/scoring.ts encodes "what we think a
 * top-of-cohort player looks like". Real applicants reveal what the
 * population ACTUALLY looks like. Each approved application contributes
 * an observation to its (stage, spending_tier) cohort; we keep a Bayesian
 * blend of the hardcoded prior and the empirical distribution:
 *
 *   effective_p99 = (PRIOR_WEIGHT × hardcoded_p99 + n × empirical_p99)
 *                 / (PRIOR_WEIGHT + n)
 *
 * At n = 0 the prior dominates (= current behavior). At n ≈ PRIOR_WEIGHT
 * the blend is 50/50. By n = 100+ the empirical signal owns the anchor.
 *
 * Per user direction (2026-05): drift is INTENTIONALLY uncapped. The
 * hardcoded anchors were calibrated from limited research data and should
 * be quickly overridden by reality once real submissions accumulate.
 *
 * Only `status="approved"` applications count — officer confirmation acts
 * as the trust signal. Pending/rejected/archived rows are excluded.
 */

import { prisma } from "@/lib/db";
import {
  COHORTS,
  SCORING_STAGES,
  SPENDING_TIERS,
  type ScoringStage,
  type SpendingTier,
  type ScoringProfile,
} from "@/lib/scoring";

/** Stat keys that participate in calibration. Mirrors CohortAnchors. */
const STAT_KEYS = [
  "power",
  "killPoints",
  "deaths",
  "valor",
  "t5Kills",
  "prevKvkDkp",
] as const;
type StatKey = (typeof STAT_KEYS)[number];

interface PiecewiseAnchors {
  p50: number;
  p80: number;
  p95: number;
  p99: number;
}
type CohortAnchors = Record<StatKey, PiecewiseAnchors>;

/** Bayesian prior strength. Hardcoded values count as if we had this many
 *  fake samples already. Tune higher for slower drift, lower for faster. */
const PRIOR_WEIGHT = 30;

/** Linear interpolation percentile. Cheap and good enough for our N. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function blend(prior: number, empirical: number, n: number): number {
  return Math.round(
    (PRIOR_WEIGHT * prior + n * empirical) / (PRIOR_WEIGHT + n),
  );
}

/** Map a stage to the date range its accountBornAt would fall into NOW.
 *  Stage moves with calendar time — a player born 14mo ago is currently
 *  lk-late; in 2 months they'll be soc-fresh. We calibrate "current"
 *  cohort, not "cohort-at-submission". */
function stageDateRange(stage: ScoringStage): {
  gte?: Date;
  lt?: Date;
} {
  const now = Date.now();
  const monthMs = 30.4 * 24 * 3600 * 1000;
  const monthsAgo = (m: number) => new Date(now - m * monthMs);
  switch (stage) {
    case "lk-early":
      return { gte: monthsAgo(6) };
    case "lk-late":
      return { gte: monthsAgo(15), lt: monthsAgo(6) };
    case "soc-fresh":
      return { gte: monthsAgo(30), lt: monthsAgo(15) };
    case "soc-mature":
      return { lt: monthsAgo(30) };
  }
}

function profileForStage(stage: ScoringStage): ScoringProfile {
  return stage === "lk-early" || stage === "lk-late"
    ? "lost-kingdom"
    : "season-of-conquest";
}

/** DKP weights matching scoring.ts PREV_KVK_DKP_WEIGHTS. Duplicated to
 *  keep this module self-contained. */
const DKP_WEIGHTS: Record<
  ScoringProfile,
  { t4: number; t5: number; deaths: number }
> = {
  "lost-kingdom": { t4: 10, t5: 20, deaths: 50 },
  "season-of-conquest": { t4: 10, t5: 30, deaths: 80 },};

/**
 * Recompute one cohort's anchors from the current pool of approved
 * applications matching that (stage, spending_tier). Idempotent — safe
 * to run on every PATCH-to-approved.
 *
 * Strategy:
 *   1. Pull approved apps where spendingTier == tier and accountBornAt
 *      falls in stage's current date range.
 *   2. For each stat, gather non-null values, sort, compute empirical
 *      p50/p80/p95/p99.
 *   3. Blend with hardcoded prior using PRIOR_WEIGHT = 30 (Bayesian).
 *   4. Upsert into ScoringCalibration. If n == 0, delete any stale row.
 */
export async function recalibrateCohort(
  stage: ScoringStage,
  tier: SpendingTier,
): Promise<void> {
  const range = stageDateRange(stage);
  const apps = await prisma.migrationApplication.findMany({
    where: {
      status: "approved",
      spendingTier: tier,
      accountBornAt: range.lt
        ? range.gte
          ? { gte: range.gte, lt: range.lt }
          : { lt: range.lt }
        : range.gte
          ? { gte: range.gte }
          : undefined,
    },
    select: {
      powerN: true,
      killPointsN: true,
      deathsN: true,
      maxValorPointsN: true,
      t5KillsN: true,
      prevKvkT4KillsN: true,
      prevKvkT5KillsN: true,
      prevKvkDeathsN: true,
    },
  });

  const n = apps.length;
  const cohortKey = `${stage}:${tier}`;

  if (n === 0) {
    // deleteMany doesn't throw when no row matches (unlike delete).
    await prisma.scoringCalibration.deleteMany({ where: { cohortKey } });
    return;
  }

  const profile = profileForStage(stage);
  const dkpW = DKP_WEIGHTS[profile];

  // Bucket values per stat. Filter null/0 — zeros mean "no data" not
  // "actually zero", and including them would tank the percentiles.
  const buckets: Record<StatKey, number[]> = {
    power: [],
    killPoints: [],
    deaths: [],
    valor: [],
    t5Kills: [],
    prevKvkDkp: [],
  };

  for (const a of apps) {
    if (a.powerN && a.powerN > 0) buckets.power.push(a.powerN);
    if (a.killPointsN && a.killPointsN > 0)
      buckets.killPoints.push(a.killPointsN);
    if (a.deathsN && a.deathsN > 0) buckets.deaths.push(a.deathsN);
    if (a.maxValorPointsN && a.maxValorPointsN > 0)
      buckets.valor.push(a.maxValorPointsN);
    if (a.t5KillsN && a.t5KillsN > 0) buckets.t5Kills.push(a.t5KillsN);
    const prev =
      (a.prevKvkT4KillsN ?? 0) * dkpW.t4 +
      (a.prevKvkT5KillsN ?? 0) * dkpW.t5 +
      (a.prevKvkDeathsN ?? 0) * dkpW.deaths;
    if (prev > 0) buckets.prevKvkDkp.push(prev);
  }

  const prior = COHORTS[stage][tier];
  const blended: CohortAnchors = {
    power: prior.power,
    killPoints: prior.killPoints,
    deaths: prior.deaths,
    valor: prior.valor,
    t5Kills: prior.t5Kills,
    prevKvkDkp: prior.prevKvkDkp,
  };

  for (const k of STAT_KEYS) {
    const vals = buckets[k];
    if (vals.length === 0) continue; // keep prior unchanged
    vals.sort((a, b) => a - b);
    const priorAnchors = prior[k];
    const empirical = {
      p50: percentile(vals, 0.5),
      p80: percentile(vals, 0.8),
      p95: percentile(vals, 0.95),
      p99: percentile(vals, 0.99),
    };
    // n here is OVERALL cohort size, not per-stat — gives a single
    // per-cohort blend strength rather than uneven per-stat behavior
    // when some stats are missing on some applicants.
    blended[k] = {
      p50: blend(priorAnchors.p50, empirical.p50, n),
      p80: blend(priorAnchors.p80, empirical.p80, n),
      p95: blend(priorAnchors.p95, empirical.p95, n),
      p99: blend(priorAnchors.p99, empirical.p99, n),
    };
  }

  await prisma.scoringCalibration.upsert({
    where: { cohortKey },
    create: {
      cohortKey,
      anchors: blended as unknown as object,
      sampleCount: n,
    },
    update: {
      anchors: blended as unknown as object,
      sampleCount: n,
    },
  });
}

/** Recompute ALL 24 cohorts. Used by the nightly cron. */
export async function recalibrateAllCohorts(): Promise<{
  cohorts: number;
  approvedTotal: number;
}> {
  let approvedTotal = 0;
  for (const stage of SCORING_STAGES) {
    for (const tier of SPENDING_TIERS) {
      await recalibrateCohort(stage, tier);
    }
  }
  approvedTotal = await prisma.migrationApplication.count({
    where: { status: "approved" },
  });
  return { cohorts: SCORING_STAGES.length * SPENDING_TIERS.length, approvedTotal };
}

/**
 * Load all calibration rows and return a lookup function suitable to pass
 * to computeScore(). Falls back to hardcoded COHORTS for cohorts that
 * have no calibration row (n=0 or never calibrated).
 *
 * Caller pattern: call once per request (or per recompute batch), then
 * pass the closure to multiple computeScore() calls.
 */
export async function loadCalibrationLookup(): Promise<
  (stage: ScoringStage, tier: SpendingTier) => CohortAnchors
> {
  const rows = await prisma.scoringCalibration.findMany();
  const map = new Map<string, CohortAnchors>();
  for (const r of rows) {
    map.set(r.cohortKey, r.anchors as unknown as CohortAnchors);
  }
  return (stage, tier) => {
    return (
      map.get(`${stage}:${tier}`) ??
      (COHORTS[stage][tier] as unknown as CohortAnchors)
    );
  };
}
