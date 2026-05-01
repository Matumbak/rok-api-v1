/**
 * Account scoring + tag derivation for migration applications.
 *
 * Scoring is intentionally simple — there's no ML or curve-fitting,
 * just a transparent additive model so officers can sanity-check why
 * an applicant got the score they did. All component scores are
 * normalized to a fixed cap, then summed and clamped to 0..100.
 *
 * Tags are derived independently of the score — they describe the
 * applicant's profile (veteran / fighter / spender) rather than rank
 * them. Multiple tags can apply at once.
 */

export type SpendingTier =
  | "f2p"
  | "low"
  | "mid"
  | "high"
  | "whale"
  | "kraken";

export const SPENDING_TIERS: SpendingTier[] = [
  "f2p",
  "low",
  "mid",
  "high",
  "whale",
  "kraken",
];

export interface ScoreInputs {
  accountBornAt: Date | null;
  vipLevel: string;
  powerN: number | null;
  killPointsN: number | null;
  deathsN: number | null;
  maxValorPointsN: number | null;
  spendingTier: SpendingTier | null;
}

export interface ScoreResult {
  score: number;
  tags: string[];
  /** Per-component breakdown, kept for admin tooltips/debugging. */
  breakdown: {
    accountAge: number;
    vip: number;
    power: number;
    killPoints: number;
    deaths: number;
    valor: number;
    spendingModifier: number;
  };
}

/**
 * Saturating curve: input → 0..max as `value` rises through `pivot`,
 * with diminishing returns past it. We use log10 normalization for
 * RoK-style heavy-tailed numerics so a 10× difference doesn't
 * single-handedly dominate the score.
 *
 *   logScore(value, pivot)  → 0   when value <= 1
 *                              ~0.5 when value == pivot
 *                              → 1 asymptotically as value >> pivot
 *
 * The curve is `log10(value+1) / log10(pivot+1)` clamped to [0, 1].
 */
function logScore(value: number | null | undefined, pivot: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  if (pivot <= 0) return 0;
  const v = Math.log10(value + 1);
  const p = Math.log10(pivot + 1);
  return Math.max(0, Math.min(1, v / p));
}

/** Account-age component: months since `accountBornAt`. */
function ageMonths(born: Date | null): number {
  if (!born) return 0;
  const now = new Date();
  let m =
    (now.getUTCFullYear() - born.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - born.getUTCMonth());
  if (now.getUTCDate() < born.getUTCDate()) m -= 1;
  return Math.max(0, m);
}

const SPENDING_LABELS: Record<SpendingTier, string> = {
  f2p: "f2p",
  low: "lo-spend",
  mid: "mid-spend",
  high: "hi-spend",
  whale: "whale",
  kraken: "kraken",
};

/**
 * Compute score + tags. Pure function — no DB access. Caller is
 * responsible for plumbing percentile-derived tags ("top-1pct",
 * "top-5pct", etc.) since those need the cohort, which lives outside.
 */
export function computeScore(input: ScoreInputs): ScoreResult {
  const months = ageMonths(input.accountBornAt);
  const vip = Number.parseInt(input.vipLevel, 10);

  // Component caps: total = 95 + spending modifier (±5) → clamp to 100.
  const ageScore = Math.min(20, (months / 30) * 20); // 30 mo → full
  const vipScore = Number.isFinite(vip) ? Math.min(15, (vip / 18) * 15) : 0; // VIP 18 → full
  const powerScore = logScore(input.powerN, 200_000_000) * 20;
  const kpScore = logScore(input.killPointsN, 500_000_000) * 15;
  const deathsScore = logScore(input.deathsN, 5_000_000) * 15;
  const valorScore = logScore(input.maxValorPointsN, 10_000_000) * 10;

  // Spending modifier: rewards F2P/low spenders for high stats,
  // penalizes high spenders for low stats. Net-zero on average.
  const baseStats = powerScore + kpScore + deathsScore + valorScore;
  // Pre-modifier 0..60 → above 40 means strong stats.
  let spendingMod = 0;
  if (input.spendingTier === "f2p") {
    spendingMod = baseStats > 40 ? 5 : baseStats > 20 ? 2 : 0;
  } else if (input.spendingTier === "low") {
    spendingMod = baseStats > 45 ? 3 : 0;
  } else if (input.spendingTier === "kraken" || input.spendingTier === "whale") {
    if (baseStats < 20) spendingMod = -5;
    else if (baseStats < 30) spendingMod = -2;
  }

  const raw =
    ageScore +
    vipScore +
    powerScore +
    kpScore +
    deathsScore +
    valorScore +
    spendingMod;
  const score = Math.max(0, Math.min(100, Math.round(raw * 10) / 10));

  // ---------------- tags ----------------
  const tags = new Set<string>();

  // Age buckets.
  if (input.accountBornAt) {
    if (months >= 24) tags.add("veteran");
    else if (months < 2) tags.add("very-young-account");
    else if (months < 6) tags.add("young-account");
  }

  // Combat profile — deaths-to-power ratio. RoK heuristic: fielded
  // combat troops vs total power. >0.30 ≈ active fighter; <0.05 ≈
  // builder/turtle.
  if (
    input.deathsN != null &&
    input.powerN != null &&
    input.powerN > 0 &&
    input.deathsN > 0
  ) {
    const ratio = input.deathsN / input.powerN;
    if (ratio > 0.3) tags.add("active-fighter");
    else if (ratio < 0.05 && input.powerN > 50_000_000) tags.add("turtle");
  }

  // Spending bucket.
  if (input.spendingTier) {
    tags.add(SPENDING_LABELS[input.spendingTier]);
  }

  // Cross-tags: F2P performing above water, big spender failing to perform.
  if (input.spendingTier === "f2p" && score >= 60) tags.add("f2p-hero");
  if (
    (input.spendingTier === "whale" || input.spendingTier === "kraken") &&
    score < 40
  ) {
    tags.add("pay-to-loose");
  }

  // KvK signal.
  if (input.maxValorPointsN != null && input.maxValorPointsN >= 5_000_000) {
    tags.add("kvk-veteran");
  } else if (
    input.maxValorPointsN == null ||
    input.maxValorPointsN < 500_000
  ) {
    tags.add("no-kvk");
  }

  return {
    score,
    tags: [...tags],
    breakdown: {
      accountAge: round1(ageScore),
      vip: round1(vipScore),
      power: round1(powerScore),
      killPoints: round1(kpScore),
      deaths: round1(deathsScore),
      valor: round1(valorScore),
      spendingModifier: spendingMod,
    },
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Returns the percentile-band tag for a given 0..1 percent_rank value,
 * or null if the applicant falls in the unremarkable middle.
 */
export function percentileTag(pct: number | null | undefined): string | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct >= 0.99) return "top-1pct";
  if (pct >= 0.95) return "top-5pct";
  if (pct >= 0.75) return "top-25pct";
  return null;
}
