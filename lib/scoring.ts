/**
 * Account scoring + tag derivation for migration applications.
 *
 * Stage-aware. RoK has two distinct game phases with ~10× different
 * KP / power / deaths magnitudes:
 *   - Lost Kingdom (LK), KvK 1–4 — first ~6–12 months of a kingdom.
 *     Mostly T4 troops, T5 unlocks at KvK4. No Hall of Heroes.
 *   - Season of Conquest (SoC) — post-LK seasons (Pass of Change,
 *     Heroic Anthem, etc). Heavily T5 (and T6 in newest), Hall of
 *     Heroes returns ~50% of dead troops.
 *
 * Profile is auto-inferred from account age (≥12mo → SoC) unless an
 * explicit override is set on the application.
 *
 * Curve: piecewise-linear with 4 anchors per stat (p50/p80/p95/p99).
 * Replaces the old log10 curve which saturated mid-whales at 95+ and
 * left no headroom for genuine top-1% accounts. Anchors are calibrated
 * against marketplace listings (Eldorado, U7Buy, FunPay, Zeusx),
 * top-kingdom rankings (riseofstats, rokboard), and Devish19-class
 * top-1% references — see the research note in
 * `obsidian/rok/research/rok-account-scoring-2026-05.md`.
 *
 * Calibration targets:
 *   p50 (median active player) → 40 pts of the stat's cap (~50 total)
 *   p80 (mid-whale 12-24mo)   → 70 pts (~75 total)
 *   p95 (top whale)            → 90 pts (~88 total)
 *   p99 (genuine top-1%)       → 96 pts (~94 total)
 *   above p99                  → asymptote to 100 (~96 total)
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

export type ScoringProfile = "lost-kingdom" | "season-of-conquest";

export const SCORING_PROFILES: ScoringProfile[] = [
  "lost-kingdom",
  "season-of-conquest",
];

export const DEFAULT_PROFILE: ScoringProfile = "lost-kingdom";

/** Account age threshold (months) — see Obsidian research note for the
 *  KvK timeline derivation. KvK1 starts ~day 85-105, each LK season is
 *  50 days, KvK4 ends month 13-15, then SoC. ≥12mo accounts have
 *  almost certainly seen SoC. */
export const SOC_ACCOUNT_AGE_THRESHOLD_MONTHS = 12;

export function inferProfile(accountBornAt: Date | null): ScoringProfile {
  if (!accountBornAt) return DEFAULT_PROFILE;
  const months = ageMonthsFromDate(accountBornAt);
  return months >= SOC_ACCOUNT_AGE_THRESHOLD_MONTHS
    ? "season-of-conquest"
    : "lost-kingdom";
}

/** Anchor set for piecewise-linear scoring. value at p50→0.40,
 *  p80→0.70, p95→0.90, p99→0.96, asymptote 1.0 above 1.5×p99. */
interface PiecewiseAnchors {
  p50: number;
  p80: number;
  p95: number;
  p99: number;
}

interface ProfilePivots {
  power: PiecewiseAnchors;
  killPoints: PiecewiseAnchors;
  deaths: PiecewiseAnchors;
  valor: PiecewiseAnchors;
  t5Kills: PiecewiseAnchors;
  prevKvkDkp: PiecewiseAnchors;
  agePivotMonths: number;
  vipPivot: number;
  prevKvkDkpWeights: { t4: number; t5: number; deaths: number };
  farmOnlyPenalty: number;
}

const PROFILES: Record<ScoringProfile, ProfilePivots> = {
  // Lost Kingdom — younger kingdoms, T4-dominant, lower magnitudes.
  // Anchors derived from typical KvK1-4 community benchmarks.
  "lost-kingdom": {
    power:      { p50: 25_000_000,  p80: 60_000_000,  p95: 100_000_000, p99: 150_000_000 },
    killPoints: { p50: 50_000_000,  p80: 200_000_000, p95: 500_000_000, p99: 1_200_000_000 },
    deaths:     { p50: 700_000,     p80: 2_000_000,   p95: 4_500_000,   p99: 8_000_000 },
    valor:      { p50: 800_000,     p80: 2_500_000,   p95: 5_000_000,   p99: 8_000_000 },
    t5Kills:    { p50: 100_000,     p80: 800_000,     p95: 2_000_000,   p99: 4_000_000 },
    prevKvkDkp: { p50: 20_000_000,  p80: 80_000_000,  p95: 200_000_000, p99: 400_000_000 },
    agePivotMonths: 12,
    vipPivot: 12,
    prevKvkDkpWeights: { t4: 10, t5: 20, deaths: 50 }, // Variant B
    farmOnlyPenalty: -10,
  },
  // Season of Conquest — post-LK, T5-heavy, ~10× the LK magnitudes.
  // Anchors:
  //   p50 from average active SoC kingdom governor (30M power),
  //   p80 from mid-whale 12-24mo (~100M power, marketplace $300-800
  //   listings, Devish19 reference at 200M is mid-p95),
  //   p99 above the top-1 in top-100 SoC kingdom (~250M power).
  "season-of-conquest": {
    power:      { p50: 30_000_000,  p80: 100_000_000, p95: 200_000_000, p99: 400_000_000 },
    killPoints: { p50: 600_000_000, p80: 3_000_000_000, p95: 8_000_000_000, p99: 18_000_000_000 },
    deaths:     { p50: 4_000_000,   p80: 12_000_000,  p95: 25_000_000,  p99: 50_000_000 },
    valor:      { p50: 3_000_000,   p80: 10_000_000,  p95: 20_000_000,  p99: 30_000_000 },
    t5Kills:    { p50: 1_000_000,   p80: 5_000_000,   p95: 12_000_000,  p99: 25_000_000 },
    prevKvkDkp: { p50: 200_000_000, p80: 1_200_000_000, p95: 3_500_000_000, p99: 8_000_000_000 },
    agePivotMonths: 30,
    vipPivot: 15,
    prevKvkDkpWeights: { t4: 10, t5: 30, deaths: 80 }, // Variant A
    farmOnlyPenalty: -15,
  },
};

/** Component caps (max pts). Sum to 100 minus headroom for spending
 *  modifier (±5) and sanity penalties. */
const CAPS = {
  age: 12,
  vip: 8,
  power: 18,
  killPoints: 18,
  deaths: 14,
  valor: 10,
  t5Kills: 12,
  prevKvkDkp: 8,
};

export interface ScoreInputs {
  accountBornAt: Date | null;
  vipLevel: string;
  powerN: number | null;
  killPointsN: number | null;
  t1KillsN: number | null;
  t2KillsN: number | null;
  t3KillsN: number | null;
  t4KillsN: number | null;
  t5KillsN: number | null;
  deathsN: number | null;
  maxValorPointsN: number | null;
  prevKvkT4KillsN: number | null;
  prevKvkT5KillsN: number | null;
  prevKvkDeathsN: number | null;
  spendingTier: SpendingTier | null;
  scoringProfile: ScoringProfile | null;
}

export interface ScoreResult {
  score: number;
  tags: string[];
  profile: ScoringProfile;
  prevKvkDkpComputed: number | null;
  breakdown: {
    accountAge: number;
    vip: number;
    power: number;
    killPoints: number;
    deaths: number;
    valor: number;
    t5Kills: number;
    prevKvkDkp: number;
    spendingModifier: number;
    sanityPenalty: number;
  };
}

/**
 * Piecewise-linear curve with population checkpoints. Returns 0..1.
 *   value ≤ 0      → 0
 *   value at p50   → 0.40
 *   value at p80   → 0.70
 *   value at p95   → 0.90
 *   value at p99   → 0.96
 *   value at 1.5×p99 → 1.00 (asymptote)
 *
 * Why not log10: log saturates by p80 — every whale lands at 95+ and
 * the formula loses discrimination in the band that matters most.
 * Piecewise-linear preserves dynamic range across the upper tail.
 */
function piecewiseScore(
  value: number | null | undefined,
  anchors: PiecewiseAnchors,
): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  const { p50, p80, p95, p99 } = anchors;
  if (value <= p50) return (value / p50) * 0.4;
  if (value <= p80) return 0.4 + ((value - p50) / (p80 - p50)) * 0.3;
  if (value <= p95) return 0.7 + ((value - p80) / (p95 - p80)) * 0.2;
  if (value <= p99) return 0.9 + ((value - p95) / (p99 - p95)) * 0.06;
  return Math.min(1.0, 0.96 + ((value - p99) / (p99 * 0.5)) * 0.04);
}

function ageMonthsFromDate(born: Date | null): number {
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

function lowTierKpShare(
  t1: number | null,
  t2: number | null,
  t3: number | null,
  t4: number | null,
  t5: number | null,
): number {
  const v1 = t1 ?? 0;
  const v2 = t2 ?? 0;
  const v3 = t3 ?? 0;
  const v4 = t4 ?? 0;
  const v5 = t5 ?? 0;
  const total = v1 + v2 * 2 + v3 * 4 + v4 * 10 + v5 * 20;
  if (total < 100_000) return 0;
  const lowTier = v1 + v2 * 2 + v3 * 4;
  return lowTier / total;
}

function computePrevKvkDkp(
  t4: number | null,
  t5: number | null,
  deaths: number | null,
  profile: ScoringProfile,
): number | null {
  const v4 = t4 ?? 0;
  const v5 = t5 ?? 0;
  const vd = deaths ?? 0;
  if (v4 + v5 + vd === 0) return null;
  const w = PROFILES[profile].prevKvkDkpWeights;
  return v4 * w.t4 + v5 * w.t5 + vd * w.deaths;
}

export function computeScore(input: ScoreInputs): ScoreResult {
  const profile = input.scoringProfile ?? inferProfile(input.accountBornAt);
  const pivots = PROFILES[profile];

  const months = ageMonthsFromDate(input.accountBornAt);
  const vip = Number.parseInt(input.vipLevel, 10);

  const ageScore = Math.min(
    CAPS.age,
    (months / pivots.agePivotMonths) * CAPS.age,
  );
  const vipScore = Number.isFinite(vip)
    ? Math.min(CAPS.vip, (vip / pivots.vipPivot) * CAPS.vip)
    : 0;
  const powerScore = piecewiseScore(input.powerN, pivots.power) * CAPS.power;

  // KP scaled by (1 - lowTierShare) — a T1-trader with inflated KP
  // gets discounted at source instead of needing a heavier penalty
  // downstream. Combat whales who zero real cities (~10-25% T1
  // share) are barely affected.
  const ltShareForKp = lowTierKpShare(
    input.t1KillsN,
    input.t2KillsN,
    input.t3KillsN,
    input.t4KillsN,
    input.t5KillsN,
  );
  const effectiveKp =
    input.killPointsN != null
      ? input.killPointsN * (1 - ltShareForKp)
      : null;
  const kpScore =
    piecewiseScore(effectiveKp, pivots.killPoints) * CAPS.killPoints;

  const deathsScore =
    piecewiseScore(input.deathsN, pivots.deaths) * CAPS.deaths;
  const valorScore =
    piecewiseScore(input.maxValorPointsN, pivots.valor) * CAPS.valor;

  // T5 absolute count (not ratio) — see prior commits for the
  // loophole rationale.
  const t5Score =
    piecewiseScore(input.t5KillsN, pivots.t5Kills) * CAPS.t5Kills;

  const prevDkp = computePrevKvkDkp(
    input.prevKvkT4KillsN,
    input.prevKvkT5KillsN,
    input.prevKvkDeathsN,
    profile,
  );
  const prevDkpScore =
    prevDkp != null
      ? piecewiseScore(prevDkp, pivots.prevKvkDkp) * CAPS.prevKvkDkp
      : 0;

  const baseStats =
    powerScore + kpScore + deathsScore + valorScore + t5Score + prevDkpScore;

  // ---------------- spending modifier (±5) ----------------
  let spendingMod = 0;
  if (input.spendingTier === "f2p") {
    spendingMod = baseStats > 50 ? 5 : baseStats > 30 ? 2 : 0;
  } else if (input.spendingTier === "low") {
    spendingMod = baseStats > 55 ? 3 : 0;
  } else if (
    input.spendingTier === "kraken" ||
    input.spendingTier === "whale"
  ) {
    if (baseStats < 25) spendingMod = -5;
    else if (baseStats < 40) spendingMod = -2;
  }

  // ---------------- sanity penalties ----------------
  const sanityTags: string[] = [];
  let sanityPenalty = 0;

  if (ltShareForKp > 0.6) {
    sanityPenalty -= 12;
    sanityTags.push("t1-trader");
  } else if (ltShareForKp > 0.4) {
    sanityPenalty -= 6;
    sanityTags.push("mostly-low-tier");
  }

  if (
    input.killPointsN != null &&
    input.killPointsN > 200_000_000 &&
    (input.t5KillsN ?? 0) < 1_000_000
  ) {
    sanityPenalty += pivots.farmOnlyPenalty;
    sanityTags.push("farm-only");
  }

  if (
    input.powerN != null &&
    input.powerN > 50_000_000 &&
    input.deathsN != null &&
    input.deathsN / input.powerN < 0.02
  ) {
    sanityPenalty -= 6;
    sanityTags.push("bunkerer");
  }

  if (
    (input.maxValorPointsN ?? 0) > 5_000_000 &&
    (input.killPointsN ?? 0) < 50_000_000
  ) {
    sanityPenalty -= 5;
    sanityTags.push("dormant");
  }

  // ---------------- final score ----------------
  const ageVip = ageScore + vipScore;
  const raw = ageVip + baseStats + spendingMod + sanityPenalty;
  const score = Math.max(0, Math.min(100, Math.round(raw * 10) / 10));

  if (
    (input.spendingTier === "whale" || input.spendingTier === "kraken") &&
    score < 40
  ) {
    sanityTags.push("weak-whale");
  }

  // ---------------- descriptive tags ----------------
  const tags = new Set<string>(sanityTags);

  if (input.accountBornAt) {
    if (months >= 24) tags.add("veteran");
    else if (months < 2) tags.add("very-young-account");
    else if (months < 6) tags.add("young-account");
    if (months >= 9 && (input.maxValorPointsN ?? 0) >= 3_000_000) {
      tags.add("lk-veteran");
    }
  }

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

  if ((input.t5KillsN ?? 0) > 1_000_000) {
    tags.add("t5-ready");
  } else if (
    (input.t5KillsN ?? 0) < 100_000 &&
    (input.powerN ?? 0) > 50_000_000
  ) {
    tags.add("pre-t5");
  }

  if (input.spendingTier) {
    tags.add(SPENDING_LABELS[input.spendingTier]);
  }

  if (input.spendingTier === "f2p" && score >= 60) tags.add("f2p-hero");

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
    profile,
    prevKvkDkpComputed: prevDkp,
    breakdown: {
      accountAge: round1(ageScore),
      vip: round1(vipScore),
      power: round1(powerScore),
      killPoints: round1(kpScore),
      deaths: round1(deathsScore),
      valor: round1(valorScore),
      t5Kills: round1(t5Score),
      prevKvkDkp: round1(prevDkpScore),
      spendingModifier: spendingMod,
      sanityPenalty,
    },
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function percentileTag(pct: number | null | undefined): string | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct >= 0.99) return "top-1pct";
  if (pct >= 0.95) return "top-5pct";
  if (pct >= 0.75) return "top-25pct";
  return null;
}
