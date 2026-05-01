/**
 * Account scoring + tag derivation for migration applications.
 *
 * Stage-aware. RoK has two distinct game phases with ~10× different
 * KP / power / deaths magnitudes:
 *   - Lost Kingdom (LK), KvK 1–4 — first ~6 months of a kingdom.
 *     Mostly T4 troops, T5 unlocks at KvK4. No Hall of Heroes.
 *   - Season of Conquest (SoC) — post-LK seasons (Pass of Change,
 *     Heroic Anthem, etc). Heavily T5 (and T6 in newest), Hall of
 *     Heroes returns ~50% of dead troops.
 *
 * Pivots are picked per-applicant via `scoringProfile`. Default for
 * kingdom 4028 (currently in KvK1) is `lost-kingdom` — see Obsidian
 * `rok/research/rok-account-scoring-2026-05.md` for the research.
 *
 * Tags are derived independently of the score — they describe the
 * applicant's profile (veteran / fighter / spender / red-flag) rather
 * than rank them. Multiple tags can apply at once.
 *
 * The model stays additive + transparent: caller can read the
 * breakdown and the sanity-penalty table to explain any score back to
 * an officer or applicant.
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

/**
 * Default profile for new submissions. Pinned to `lost-kingdom` until
 * kingdom 4028 progresses to Season of Conquest (estimated mid-2026
 * per opening date ~Jan-2026 + standard ~6mo LK timeline). Flip this
 * constant — or set `scoringProfile` on individual applications via
 * admin PATCH — when SoC starts.
 */
export const DEFAULT_PROFILE: ScoringProfile = "lost-kingdom";

interface ProfilePivots {
  agePivotMonths: number;
  vipPivot: number;
  powerPivot: number;
  killPointsPivot: number;
  deathsPivot: number;
  valorPivot: number;
  /** Absolute T5 kills pivot — full credit at pivot. Using count, not
   *  ratio, to prevent the loophole where someone with 50k T4 + 50k T5
   *  gets max t5Score on a 100% T5 ratio. */
  t5KillsPivot: number;
  prevKvkDkpPivot: number;
  /** "Variant A/B" split for last-KvK DKP recompute. */
  prevKvkDkpWeights: { t4: number; t5: number; deaths: number };
  /** How harshly farm-only applicants are penalized in this stage. */
  farmOnlyPenalty: number;
}

const PROFILES: Record<ScoringProfile, ProfilePivots> = {
  "lost-kingdom": {
    agePivotMonths: 18,
    vipPivot: 12,
    powerPivot: 60_000_000,
    killPointsPivot: 100_000_000,
    deathsPivot: 2_000_000,
    valorPivot: 3_000_000,
    t5KillsPivot: 1_000_000,
    prevKvkDkpPivot: 30_000_000,
    prevKvkDkpWeights: { t4: 10, t5: 20, deaths: 50 }, // Variant B
    farmOnlyPenalty: -10,
  },
  "season-of-conquest": {
    agePivotMonths: 30,
    vipPivot: 15,
    powerPivot: 250_000_000,
    killPointsPivot: 1_500_000_000,
    deathsPivot: 10_000_000,
    valorPivot: 10_000_000,
    t5KillsPivot: 5_000_000,
    prevKvkDkpPivot: 1_000_000_000,
    prevKvkDkpWeights: { t4: 10, t5: 30, deaths: 80 }, // Variant A
    farmOnlyPenalty: -15,
  },
};

/** Component caps (max pts) — stable across profiles, only pivots shift. */
const CAPS = {
  age: 18,
  vip: 10,
  power: 18,
  killPoints: 16,
  deaths: 12,
  valor: 8,
  t5Kills: 8,
  prevKvkDkp: 10,
};

export interface ScoreInputs {
  accountBornAt: Date | null;
  vipLevel: string;
  powerN: number | null;
  killPointsN: number | null;
  /** Per-tier kill counts from the in-game Kill Data popup (all 5). */
  t1KillsN: number | null;
  t2KillsN: number | null;
  t3KillsN: number | null;
  t4KillsN: number | null;
  t5KillsN: number | null;
  deathsN: number | null;
  maxValorPointsN: number | null;
  /** Last-KvK stats from the applicant's DKP-scan upload. Optional. */
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
  /** Server-computed DKP for the last KvK using the profile's weights.
   *  Null when no prevKvk* data was supplied. */
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
 * Saturating curve: input → 0..1 as `value` rises through `pivot`,
 * with diminishing returns past it. Log10 normalization handles the
 * heavy-tailed RoK numerics (10× differences) gracefully.
 */
function logScore(value: number | null | undefined, pivot: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  if (pivot <= 0) return 0;
  return Math.max(0, Math.min(1, Math.log10(value + 1) / Math.log10(pivot + 1)));
}

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
 * Lilith's in-game Kill Points formula: T1=1, T2=2, T3=4, T4=10,
 * T5=20 KP per kill (T6 still maps to T5 weight as of Heroic Anthem).
 * Returns the share of KP coming from low-tier kills (T1+T2+T3) — the
 * canonical signal for "T1 trader" detection.
 *
 * Why it works: a legitimate combat whale produces lots of T1 kills
 * as a side-effect of zeroing real cities (real cities have ~10–20%
 * T1 reserves), but T4/T5 still dominate the KP because their
 * multipliers are 10× and 20× higher. A T1-trader who farms low-tier
 * kills to pad MVP thresholds gets KP almost entirely from T1.
 *
 * Empirical thresholds (see Obsidian research note):
 *   < 0.40  → normal
 *   0.40–0.60 → mostly-low-tier (officer-review pill)
 *   > 0.60  → t1-trader (numeric penalty)
 */
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
  const total = v1 * 1 + v2 * 2 + v3 * 4 + v4 * 10 + v5 * 20;
  if (total < 100_000) return 0; // sample too small — no signal
  const lowTier = v1 * 1 + v2 * 2 + v3 * 4;
  return lowTier / total;
}

/**
 * Returns the last-KvK DKP using the active profile's weights:
 *   LK   (Variant B) → t4×10 + t5×20 + deaths×50
 *   SoC  (Variant A) → t4×10 + t5×30 + deaths×80
 * Both formulas are publicly used by 2779 / 2708 alliance rules; LK
 * variant accommodates thinner T5 supply during Lost Kingdom seasons.
 */
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

/**
 * Compute the applicant's score, tags, and breakdown. Pure function.
 * Caller plumbs percentile-derived tags (top-1pct etc.) since those
 * need cohort context.
 */
export function computeScore(input: ScoreInputs): ScoreResult {
  const profile = input.scoringProfile ?? DEFAULT_PROFILE;
  const pivots = PROFILES[profile];

  const months = ageMonths(input.accountBornAt);
  const vip = Number.parseInt(input.vipLevel, 10);

  // ---------------- positive components ----------------
  const ageScore = Math.min(
    CAPS.age,
    (months / pivots.agePivotMonths) * CAPS.age,
  );
  const vipScore = Number.isFinite(vip)
    ? Math.min(CAPS.vip, (vip / pivots.vipPivot) * CAPS.vip)
    : 0;
  const powerScore = logScore(input.powerN, pivots.powerPivot) * CAPS.power;

  // KP is scaled down by the low-tier KP share — a T1-trader with 100M
  // KP that's 90% T1 contributes only ~10% effective combat KP. Combat
  // whales who zero real cities have ~10–25% low-tier share (city
  // reserves include T1) so they're barely affected. Without this
  // scaling, the KP component rewards the inflated number directly.
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
    logScore(effectiveKp, pivots.killPointsPivot) * CAPS.killPoints;

  const deathsScore =
    logScore(input.deathsN, pivots.deathsPivot) * CAPS.deaths;
  const valorScore =
    logScore(input.maxValorPointsN, pivots.valorPivot) * CAPS.valor;

  // T5 component — uses absolute kill count vs pivot, NOT a ratio.
  // Ratio gave a loophole: 50k T4 + 50k T5 = 50% ratio = max t5Score
  // even though the player has microscopic absolute combat output.
  const t5Score =
    logScore(input.t5KillsN, pivots.t5KillsPivot) * CAPS.t5Kills;

  // Last-KvK DKP component.
  const prevDkp = computePrevKvkDkp(
    input.prevKvkT4KillsN,
    input.prevKvkT5KillsN,
    input.prevKvkDeathsN,
    profile,
  );
  const prevDkpScore =
    prevDkp != null
      ? logScore(prevDkp, pivots.prevKvkDkpPivot) * CAPS.prevKvkDkp
      : 0;

  const baseStats =
    powerScore + kpScore + deathsScore + valorScore + t5Score + prevDkpScore;

  // ---------------- spending modifier (±5) ----------------
  let spendingMod = 0;
  if (input.spendingTier === "f2p") {
    spendingMod = baseStats > 40 ? 5 : baseStats > 20 ? 2 : 0;
  } else if (input.spendingTier === "low") {
    spendingMod = baseStats > 45 ? 3 : 0;
  } else if (
    input.spendingTier === "kraken" ||
    input.spendingTier === "whale"
  ) {
    if (baseStats < 20) spendingMod = -5;
    else if (baseStats < 30) spendingMod = -2;
  }

  // ---------------- sanity penalties ----------------
  const sanityTags: string[] = [];
  let sanityPenalty = 0;

  // T1-trade detection — see lowTierKpShare doc. Reuses the share we
  // already computed for the KP-component scaling above.
  if (ltShareForKp > 0.6) {
    sanityPenalty -= 12;
    sanityTags.push("t1-trader");
  } else if (ltShareForKp > 0.4) {
    sanityPenalty -= 6;
    sanityTags.push("mostly-low-tier");
  }

  // Farm-only — high KP without any T5 kills. Useless in real KvK
  // because T5 is the bulk of post-CH25 combat.
  if (
    input.killPointsN != null &&
    input.killPointsN > 200_000_000 &&
    (input.t5KillsN ?? 0) < 1_000_000
  ) {
    sanityPenalty += pivots.farmOnlyPenalty; // negative
    sanityTags.push("farm-only");
  }

  // Bunkerer — sub-2% deaths/power ratio on a real-sized account
  // signals kill-feeding without committing troops.
  if (
    input.powerN != null &&
    input.powerN > 50_000_000 &&
    input.deathsN != null &&
    input.deathsN / input.powerN < 0.02
  ) {
    sanityPenalty -= 6;
    sanityTags.push("bunkerer");
  }

  // Dormant veteran — lifetime valor proves they were active once,
  // but recent KP doesn't match. Account peaked then went idle.
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

  // Weak-whale needs the final score — second pass after clamp.
  if (
    (input.spendingTier === "whale" || input.spendingTier === "kraken") &&
    score < 40
  ) {
    sanityTags.push("weak-whale");
    // Penalty is informational at this point — the low score IS the
    // penalty. We don't subtract again to avoid feedback loop.
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

  // Combat profile.
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

  // T5 readiness — orthogonal to the score, just the binary signal.
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
