/**
 * RATIO-BASED ACCOUNT SCORING
 * ===========================
 * Score reflects how an applicant's stats compare to the EXPECTED output
 * of an average player who played the same KvK history. We infer KvK
 * history from accountBornAt (age in months → list of KvKs participated)
 * and accumulate per-KvK median outputs to get the expected lifetime.
 * The applicant's actual lifetime stats / expected ratio drives the score.
 *
 * Why ratio not cohort:
 *   The previous (stage × spending_tier) cohort approach broke down because
 *   spending tier doesn't reliably predict KvK output — an active F2P with
 *   maxed gear can match kraken output in SoC, while a "lazy whale" who
 *   only fought 1-2 hours posts kraken-claim-stats below median. Officers
 *   don't need the formula to encode "spending tier expectation"; they
 *   read the tier label themselves and judge holistically.
 *
 * KvK benchmarks come from DKP-scan uploads (lib/benchmarks.ts).
 * Hardcoded priors below act as fallback until real scans accumulate;
 * once any BenchmarkUpload exists for a kvkId the priors are blended out.
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

export type ScoringStage = "lk-early" | "lk-late" | "soc-fresh" | "soc-mature";

export const SCORING_STAGES: ScoringStage[] = [
  "lk-early",
  "lk-late",
  "soc-fresh",
  "soc-mature",
];

export type KvkId = "kvk1" | "kvk2" | "kvk3" | "kvk4" | "soc";

export const KVK_IDS: KvkId[] = ["kvk1", "kvk2", "kvk3", "kvk4", "soc"];

/** Ratio-based curve: applicant_actual / expected_population_median.
 *  ratio = 0   → 0.00
 *  ratio = 0.5 → 0.30   (half the median, weak)
 *  ratio = 1   → 0.55   (matches median = passing)
 *  ratio = 2   → 0.80
 *  ratio = 4   → 0.92   (whale-class output)
 *  ratio = 8   → 0.98   (kraken-class)
 *  ratio ≥ 12  → 1.00   (clipped) */
function ratioToScore(r: number): number {
  if (!Number.isFinite(r) || r <= 0) return 0;
  if (r <= 0.5) return r * 0.6; // 0..0.30
  if (r <= 1.0) return 0.3 + (r - 0.5) * 0.5; // 0.30..0.55
  if (r <= 2.0) return 0.55 + (r - 1.0) * 0.25; // 0.55..0.80
  if (r <= 4.0) return 0.8 + (r - 2.0) * 0.06; // 0.80..0.92
  if (r <= 8.0) return 0.92 + (r - 4.0) * 0.015; // 0.92..0.98
  if (r <= 12.0) return 0.98 + (r - 8.0) * 0.005; // 0.98..1.00
  return 1.0;
}

/** Map a rank-percentile (1.0 = best in kingdom, 0.0 = worst) onto a
 *  score band. Tail-heavy: rewards top-of-kingdom finishes hard,
 *  passes median quickly, doesn't crash bottom performers as much
 *  (everyone who showed up and fought deserves something).
 *
 *    pct = 1.000 (rank 1 of N)     → 1.00
 *    pct = 0.99  (top 1%)          → 0.95
 *    pct = 0.95  (top 5%)          → 0.85
 *    pct = 0.80  (top 20%)         → 0.65
 *    pct = 0.50  (median)          → 0.40
 *    pct = 0.10  (bottom 10%)      → 0.10 */
function rankToScore(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  if (pct >= 1) return 1.0;
  if (pct <= 0.5) return pct * 0.8; // 0..0.40
  if (pct <= 0.8) return 0.4 + (pct - 0.5) * (0.25 / 0.3); // 0.40..0.65
  if (pct <= 0.95) return 0.65 + (pct - 0.8) * (0.20 / 0.15); // 0.65..0.85
  if (pct <= 0.99) return 0.85 + (pct - 0.95) * (0.10 / 0.04); // 0.85..0.95
  return 0.95 + (pct - 0.99) * (0.05 / 0.01); // 0.95..1.00
}

/** Map an arbitrary value into the 0..1 score band of a percentile
 *  distribution. Uses linear interpolation between p50/p80/p95/p99. */
export interface PercentileAnchors {
  p50: number;
  p80: number;
  p95: number;
  p99: number;
}

function percentileScore(
  value: number | null | undefined,
  anchors: PercentileAnchors,
): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  const { p50, p80, p95, p99 } = anchors;
  if (p50 <= 0) {
    if (value <= p99) return 0.4 + (value / p99) * 0.6;
    return 1.0;
  }
  if (value <= p50) return (value / p50) * 0.4;
  if (value <= p80) return 0.4 + ((value - p50) / (p80 - p50)) * 0.3;
  if (value <= p95) return 0.7 + ((value - p80) / (p95 - p80)) * 0.2;
  if (value <= p99) return 0.9 + ((value - p95) / (p99 - p95)) * 0.1;
  return 1.0;
}

export interface KvkBenchmarkStats {
  power: PercentileAnchors;
  kp: PercentileAnchors;
  t5: PercentileAnchors;
  deaths: PercentileAnchors;
  acclaim: PercentileAnchors;
  dkp: PercentileAnchors;
}

/** Hardcoded per-KvK prior distributions. Used as fallback when no
 *  BenchmarkUpload has been ingested yet. Numbers calibrated as follows:
 *
 *    kvk4 — derived from a real KvK4 export (kingdom 3801, ~2500 active
 *           fighters, May 2026)
 *    kvk1-3 — extrapolated downward from kvk4 (smaller magnitudes, less
 *           T5, fewer fights)
 *    soc — extrapolated upward (bigger fights, T5/T6 era, HoH inflates
 *          deaths counter ~2× for same intensity)
 *
 *  These priors get blended out once real scans accumulate per kvkId.
 */
export const KVK_PRIORS: Record<KvkId, KvkBenchmarkStats> = {
  kvk1: {
    power:   { p50:    8e6, p80:   18e6, p95:   30e6, p99:   50e6 },
    kp:      { p50:    5e6, p80:   25e6, p95:  100e6, p99:  250e6 },
    t5:      { p50:      0, p80:    5e3, p95:   30e3, p99:  100e3 },
    deaths:  { p50:   50e3, p80:  200e3, p95:  500e3, p99:  1.2e6 },
    acclaim: { p50:  100e3, p80:  400e3, p95:  1.5e6, p99:    5e6 },
    dkp:     { p50:    8e6, p80:   50e6, p95:  200e6, p99:  500e6 },
  },
  kvk2: {
    power:   { p50:   20e6, p80:   35e6, p95:   55e6, p99:   80e6 },
    kp:      { p50:   15e6, p80:   80e6, p95:  350e6, p99:  800e6 },
    t5:      { p50:   50e3, p80:  300e3, p95:  1.5e6, p99:    5e6 },
    deaths:  { p50:  150e3, p80:  600e3, p95:  1.5e6, p99:    3e6 },
    acclaim: { p50:  250e3, p80:  800e3, p95:    4e6, p99:   12e6 },
    dkp:     { p50:   25e6, p80:  150e6, p95:  600e6, p99:  1.5e9 },
  },
  kvk3: {
    power:   { p50:   30e6, p80:   50e6, p95:   70e6, p99:   95e6 },
    kp:      { p50:   18e6, p80:  130e6, p95:  700e6, p99:  1.5e9 },
    t5:      { p50:  250e3, p80:  1.2e6, p95:    8e6, p99:   22e6 },
    deaths:  { p50:  250e3, p80:  800e3, p95:  2.2e6, p99:  4.5e6 },
    acclaim: { p50:  350e3, p80:  1.2e6, p95:    6e6, p99:   18e6 },
    dkp:     { p50:   35e6, p80:  220e6, p95:  900e6, p99:  2.2e9 },
  },
  // Real numbers from kingdom 3801 KvK4 export, May 2026.
  kvk4: {
    power:   { p50:   42e6, p80:   60e6, p95:   72e6, p99:   86e6 },
    kp:      { p50:   23e6, p80:  148e6, p95:  577e6, p99:  1.66e9 },
    t5:      { p50:  790e3, p80:  5.5e6, p95:   23e6, p99:   64e6 },
    deaths:  { p50:  412e3, p80:    1e6, p95:  1.86e6, p99: 3.27e6 },
    acclaim: { p50:  463e3, p80:  2.21e6, p95:  7.86e6, p99: 21.9e6 },
    dkp:     { p50:   45e6, p80:  172e6, p95:  609e6, p99:  1.69e9 },
  },
  // SoC: roughly 2× kvk4 magnitudes for KP/dkp, deaths ×2 for HoH inflation.
  // Single-bucket; could split into soc1/soc2/.. if officers want per-season
  // granularity later.
  soc: {
    power:   { p50:   60e6, p80:  100e6, p95:  140e6, p99:  180e6 },
    kp:      { p50:   80e6, p80:  600e6, p95:    2e9, p99:    5e9 },
    t5:      { p50:    3e6, p80:   18e6, p95:   70e6, p99:  200e6 },
    deaths:  { p50:  1.2e6, p80:    4e6, p95:    9e6, p99:   18e6 },
    acclaim: { p50:  1.5e6, p80:    7e6, p95:   25e6, p99:   70e6 },
    dkp:     { p50:  150e6, p80:  800e6, p95:    3e9, p99:    8e9 },
  },
};

/** KvK benchmark lookup signature. Returns merged (prior + uploaded scans)
 *  benchmark for a kvkId, optionally specialised by seed bucket.
 *
 *  For LK KvKs (kvk1-4) the seed param is ignored — there's only ever
 *  one benchmark per LK kvkId (the "general" cell).
 *
 *  For SoC, passing the applicant's detected seed picks the matching
 *  per-seed benchmark (B-seed applicant gets B-seed anchors). When no
 *  seed is passed or that seed has no data yet, falls back to the
 *  flat soc-general benchmark. */
export type BenchmarkLookup = (
  kvkId: KvkId,
  seed?: string,
) => KvkBenchmarkStats;

/** From accountBornAt months, infer the list of KvKs the player has
 *  participated in. Order matches calendar progression — used both for
 *  expected-lifetime computation (sum medians) and "which KvK is most
 *  recent" (last element).
 *
 *  Approximate timing (varies by kingdom & individual join date):
 *    KvK 1 closes:  ~5 months after account creation
 *    KvK 2 closes:  ~7 months
 *    KvK 3 closes:  ~10 months
 *    KvK 4 closes:  ~14 months  (last LK KvK)
 *    SoC seasons:   ~every 2.5 months thereafter */
export function kvksPlayed(months: number): KvkId[] {
  if (months < 4) return [];
  const list: KvkId[] = ["kvk1"];
  if (months >= 7) list.push("kvk2");
  if (months >= 10) list.push("kvk3");
  if (months >= 14) list.push("kvk4");
  if (months > 14) {
    const socCount = Math.floor((months - 14) / 2.5) + 1;
    for (let i = 0; i < socCount; i++) list.push("soc");
  }
  return list;
}

/** Stage classification — kept for backwards compat with existing admin
 *  UI labels. Not used in new scoring math. */
export function inferStage(accountBornAt: Date | null): ScoringStage {
  if (!accountBornAt) return "lk-early";
  const months = ageMonthsFromDate(accountBornAt);
  if (months < 6) return "lk-early";
  if (months < 15) return "lk-late";
  if (months < 30) return "soc-fresh";
  return "soc-mature";
}

/** UI-pill profile (LK/SoC). Kept for human-readable label only. */
export function inferProfile(accountBornAt: Date | null): ScoringProfile {
  const stage = inferStage(accountBornAt);
  return stage === "lk-early" || stage === "lk-late"
    ? "lost-kingdom"
    : "season-of-conquest";
}

export function ageMonthsFromDate(born: Date | null): number {
  if (!born) return 0;
  const now = new Date();
  let m =
    (now.getUTCFullYear() - born.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - born.getUTCMonth());
  if (now.getUTCDate() < born.getUTCDate()) m -= 1;
  return Math.max(0, m);
}

/** Component caps (max pts). Sum to 100; sanity penalties subtract. */
const CAPS = {
  age: 10,
  vip: 6,
  power: 16, // current power vs latest-KvK distribution percentile
  killPoints: 18, // ratio: actual / sum(p50 of kp across played KvKs)
  deaths: 12,
  valor: 8, // max valor vs cumulative-acclaim estimate
  t5Kills: 14,
  prevKvkDkp: 16, // applicant's prevKvkDkp vs latest-KvK percentile (when provided)
};
// Total = 100

const SPENDING_LABELS: Record<SpendingTier, string> = {
  f2p: "f2p",
  low: "lo-spend",
  mid: "mid-spend",
  high: "hi-spend",
  whale: "whale",
  kraken: "kraken",
};

/** Game KP yield ratios per troop tier, used for low-tier-share gate.
 *  Verified from live profile screens: T1 0.2 / T2 2 / T3 4 / T4 10 / T5 20.
 *  Relative weights below match those ratios (×5 for integer math). */
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
  const total = v1 + v2 * 10 + v3 * 20 + v4 * 50 + v5 * 100;
  if (total < 100_000) return 0;
  const lowTier = v1 + v2 * 10 + v3 * 20;
  return lowTier / total;
}

/** Composite single-KvK DKP from raw kill counts using profile weights.
 *  Mirrors what KvK leaderboards compute for "DKP" column. */
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
  const w =
    profile === "season-of-conquest"
      ? { t4: 10, t5: 30, deaths: 80 }
      : { t4: 10, t5: 20, deaths: 50 };
  return v4 * w.t4 + v5 * w.t5 + vd * w.deaths;
}

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
  /** Position within the source-kingdom DKP scan (1-based, lower = better).
   *  Null when applicant didn't attach a DKP scan. */
  prevKvkRank: number | null;
  /** Total active fighters in that scan. Denominator for the rank
   *  percentile. Null when no scan attached. */
  prevKvkScanActiveCount: number | null;
  /** Applicant's detected seed group from KingdomSeed[homeKD] lookup
   *  (Imperium / A / B / C / D). When present, SoC KvKs are scored
   *  against the matching `(soc, <seed>)` benchmark. Null = LK-only
   *  applicant or unknown seed; falls back to general soc benchmark. */
  detectedSeed: string | null;
  spendingTier: SpendingTier | null;
  scoringProfile: ScoringProfile | null;
}

export interface ScoreBreakdown {
  accountAge: number;
  vip: number;
  power: number;
  killPoints: number;
  deaths: number;
  valor: number;
  t5Kills: number;
  prevKvkDkp: number;
  sanityPenalty: number;
  /** Ratios for transparency in the popover. Each = applicant_actual /
   *  expected_population. Null when expected was 0 (player too young to
   *  have played any KvK yet). */
  ratios: {
    killPoints: number | null;
    t5Kills: number | null;
    deaths: number | null;
    valor: number | null;
  };
  /** Position within applicant's source-kingdom scan, when provided.
   *  rank/total = "top X% of fighters in their KvK". Null when no scan
   *  was attached at submit time. */
  prevKvkPosition: {
    rank: number;
    total: number;
    /** rank as a fraction of "fighters BEHIND you", 0..1 (1 = best). */
    pct: number;
  } | null;
}

export interface ScoreResult {
  score: number;
  tags: string[];
  profile: ScoringProfile;
  stage: ScoringStage;
  /** KvKs the player is estimated to have participated in based on
   *  account age. Used for the ratio comparisons. */
  playedKvks: KvkId[];
  prevKvkDkpComputed: number | null;
  breakdown: ScoreBreakdown;
}

export function computeScore(
  input: ScoreInputs,
  benchmarkLookup?: BenchmarkLookup,
): ScoreResult {
  const stage = inferStage(input.accountBornAt);
  const profile = input.scoringProfile ?? inferProfile(input.accountBornAt);
  const months = ageMonthsFromDate(input.accountBornAt);
  const played = kvksPlayed(months);
  const lookup =
    benchmarkLookup ?? ((k: KvkId, _seed?: string) => KVK_PRIORS[k]);
  // For SoC KvKs we want the seed-specific benchmark when applicant
  // has a detected seed; LK KvKs ignore seed (only one benchmark per
  // kvkId there).
  const seedFor = (k: KvkId): string | undefined =>
    k === "soc" && input.detectedSeed ? input.detectedSeed : undefined;
  const vip = Number.parseInt(input.vipLevel, 10);

  // Lifetime expected = sum of per-KvK contributions across played
  // history, anchored at the **p90** of active fighters in each KvK
  // (interpolated linearly between p80 and p95 since anchors only
  // store p50/p80/p95/p99).
  //
  //   - Out-of-KvK farming is genuinely rare in RoK — ~95% of lifetime
  //     KP comes from KvKs themselves.
  //   - Migration applicants self-select into the "serious fighter"
  //     pool. Top-10% per KvK matches the realistic ceiling for what
  //     an applicant we'd hire would have done; p80 leaves too many
  //     applicants with ratio >= 2× across ALL seeds, saturating the
  //     curve and visually flattening per-seed differentiation.
  //
  // ratio = 1× now means "you're a strong active fighter (top-10% per
  // KvK on average)". 2× = exceptional, 4× = kraken-tier.
  const p90 = (a: PercentileAnchors) => a.p80 + (a.p95 - a.p80) * (2 / 3);
  let expKp = 0;
  let expT5 = 0;
  let expDeaths = 0;
  // For valor, max-ever-held doesn't sum like cumulative kills — use
  // 1.5× the highest-acclaim-p80 of played KvKs as a rough estimate of
  // "max valor someone in this stage might have at peak".
  let valorRefP80 = 0;
  for (const k of played) {
    const b = lookup(k, seedFor(k));
    expKp += p90(b.kp);
    expT5 += p90(b.t5);
    expDeaths += p90(b.deaths);
    if (b.acclaim.p80 > valorRefP80) valorRefP80 = b.acclaim.p80;
  }
  const expValor = valorRefP80 * 1.5;

  // Discount KP by low-tier share — a T1-trader has inflated KP.
  const ltShare = lowTierKpShare(
    input.t1KillsN,
    input.t2KillsN,
    input.t3KillsN,
    input.t4KillsN,
    input.t5KillsN,
  );
  const effectiveKp =
    input.killPointsN != null ? input.killPointsN * (1 - ltShare) : null;

  const ratioOrNull = (
    actual: number | null,
    expected: number,
  ): number | null => {
    if (actual == null || !Number.isFinite(actual) || actual <= 0) return null;
    if (expected <= 0) return null;
    return actual / expected;
  };

  const kpRatio = ratioOrNull(effectiveKp, expKp);
  const t5Ratio = ratioOrNull(input.t5KillsN, expT5);
  const deathsRatio = ratioOrNull(input.deathsN, expDeaths);
  const valorRatio = ratioOrNull(input.maxValorPointsN, expValor);

  const kpScore = kpRatio != null ? ratioToScore(kpRatio) * CAPS.killPoints : 0;
  const t5Score = t5Ratio != null ? ratioToScore(t5Ratio) * CAPS.t5Kills : 0;
  const deathsScore =
    deathsRatio != null ? ratioToScore(deathsRatio) * CAPS.deaths : 0;
  const valorScore = valorRatio != null ? ratioToScore(valorRatio) * CAPS.valor : 0;

  // Power: percentile within the LATEST played KvK's power distribution
  // (current army size at end of that KvK is the most-comparable peer
  // group). For pre-KvK players, percentile in kvk1 prior.
  const latestKvk: KvkId = played.length > 0 ? played[played.length - 1] : "kvk1";
  const latestBench = lookup(latestKvk, seedFor(latestKvk));
  const powerScore = percentileScore(input.powerN, latestBench.power) * CAPS.power;

  // PrevKvkDkp: scored from TWO complementary signals when both present.
  //   (a) Absolute output — applicant's prevKvkDkp vs the population
  //       distribution at this kvkId (benchmark). Catches "did your
  //       cycle output match what people in your phase typically post?"
  //   (b) Position — applicant's RANK within their source-kingdom's
  //       active fighters (rank / activeCount). Catches "you carried
  //       your kingdom's KvK regardless of absolute scale" — important
  //       when the kingdom was small or the match-up was easy/hard.
  // Combined 60% absolute + 40% position. When position data is missing
  // (no scan attached), absolute carries the whole component.
  const prevDkp = computePrevKvkDkp(
    input.prevKvkT4KillsN,
    input.prevKvkT5KillsN,
    input.prevKvkDeathsN,
    profile,
  );
  let prevDkpScore = 0;
  let prevKvkPositionInfo:
    | { rank: number; total: number; pct: number }
    | null = null;
  if (prevDkp != null && played.length > 0) {
    const absoluteFrac = percentileScore(
      prevDkp,
      lookup(latestKvk, seedFor(latestKvk)).dkp,
    );
    let positionFrac: number | null = null;
    if (
      input.prevKvkRank != null &&
      input.prevKvkScanActiveCount != null &&
      input.prevKvkScanActiveCount > 0 &&
      input.prevKvkRank > 0
    ) {
      // pct = fraction of fighters BEHIND the applicant
      // (1 - (rank-1)/total) → rank=1 in 1000 → 1.000, rank=500 → 0.501.
      const pct = 1 - (input.prevKvkRank - 1) / input.prevKvkScanActiveCount;
      positionFrac = rankToScore(pct);
      prevKvkPositionInfo = {
        rank: input.prevKvkRank,
        total: input.prevKvkScanActiveCount,
        pct: round2(pct),
      };
    }
    const blended =
      positionFrac != null
        ? absoluteFrac * 0.6 + positionFrac * 0.4
        : absoluteFrac;
    prevDkpScore = blended * CAPS.prevKvkDkp;
  }

  // Age & VIP: capped scaling. Age uses month-pivot of 36 (3 years = max);
  // vip uses 25.
  const ageScore = Math.min(CAPS.age, (months / 36) * CAPS.age);
  const vipScore = Number.isFinite(vip)
    ? Math.min(CAPS.vip, (vip / 25) * CAPS.vip)
    : 0;

  const baseTotal =
    ageScore + vipScore + powerScore + kpScore + deathsScore +
    valorScore + t5Score + prevDkpScore;

  // ---- sanity penalties ----
  const sanityTags: string[] = [];
  let sanityPenalty = 0;

  if (ltShare > 0.6) {
    sanityPenalty -= 12;
    sanityTags.push("t1-trader");
  } else if (ltShare > 0.4) {
    sanityPenalty -= 6;
    sanityTags.push("mostly-low-tier");
  }

  if (
    input.killPointsN != null &&
    input.killPointsN > 200_000_000 &&
    (input.t5KillsN ?? 0) < 1_000_000 &&
    played.includes("kvk4")
  ) {
    // High KP, low T5, was around when T5 unlocked — likely farm-padded.
    sanityPenalty -= 10;
    sanityTags.push("farm-only");
  }

  if (
    input.killPointsN != null &&
    input.killPointsN > 500_000_000 &&
    input.deathsN != null &&
    input.deathsN > 0 &&
    input.killPointsN / input.deathsN > 4000 &&
    (input.t5KillsN ?? 0) < 2_000_000
  ) {
    sanityPenalty -= 8;
    sanityTags.push("farm-padded");
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

  // Spending tier vs score mismatch (informational, no math impact —
  // the tag itself catches the officer's eye).
  const score = Math.max(0, Math.min(100, Math.round((baseTotal + sanityPenalty) * 10) / 10));
  if (
    (input.spendingTier === "whale" || input.spendingTier === "kraken") &&
    score < 50
  ) {
    sanityTags.push("kraken-claim-weak");
  }

  // ---- descriptive tags ----
  const tags = new Set<string>(sanityTags);

  if (input.accountBornAt) {
    if (months >= 30) tags.add("veteran");
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
    const r = input.deathsN / input.powerN;
    if (r > 0.3) tags.add("active-fighter");
    else if (r < 0.05 && input.powerN > 50_000_000) tags.add("turtle");
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

  // NOTE: the "<seed>-seed-<band>" tag used to live here, but it's now
  // computed by computeApplicantScore() because the band depends on the
  // applicant's score IN their detected seed (not the main tier-blind
  // score). Adding it here would double-count or mis-band.

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
    stage,
    playedKvks: played,
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
      sanityPenalty,
      ratios: {
        killPoints: kpRatio != null ? round2(kpRatio) : null,
        t5Kills: t5Ratio != null ? round2(t5Ratio) : null,
        deaths: deathsRatio != null ? round2(deathsRatio) : null,
        valor: valorRatio != null ? round2(valorRatio) : null,
      },
      prevKvkPosition: prevKvkPositionInfo,
    },
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type Seed = "Imperium" | "A" | "B" | "C" | "D";
export const SEEDS: Seed[] = ["Imperium", "A", "B", "C", "D"];

export interface ApplicantScoreOutput {
  /** Main, tier-blind score — uses (soc, general) benchmark for SoC
   *  KvKs regardless of applicant's detected seed. This is what gets
   *  persisted as `overallScore` and shown as the primary number in
   *  admin. */
  main: ScoreResult;
  /** Per-seed scores: "if scored against <seed>-seed benchmark, X/100".
   *  Null for applicants who haven't played any SoC season — there's
   *  nothing seed-aware to compare. */
  perSeedScores: Record<Seed, number> | null;
  /** Final tags for persistence: main.tags + (optionally) the seed-
   *  band tag derived from the applicant's home seed × their score in
   *  that seed (e.g. "b-seed-high" = applicant from B-seed kingdom
   *  who scored ≥65 when graded against the B-seed benchmark). */
  tags: string[];
}

/** Top-level scoring helper used by all call sites (submit, admin GET,
 *  admin PATCH, cron, recompute scripts). Computes:
 *
 *    - main, tier-blind score (`detectedSeed` ignored for SoC math)
 *    - per-seed scores when applicant played SoC (5 separate runs)
 *    - composite tag list including the seed-band tag based on the
 *      applicant's home KD seed × their score in that seed
 *
 *  Persisting flow: caller saves `output.main.score` as overallScore
 *  and `output.tags` (NOT main.tags) so the seed-band tag survives. */
export function computeApplicantScore(
  input: ScoreInputs,
  benchmarkLookup?: BenchmarkLookup,
): ApplicantScoreOutput {
  // Main = tier-blind. Force detectedSeed=null so SoC KvKs use the
  // (soc, general) benchmark.
  const main = computeScore({ ...input, detectedSeed: null }, benchmarkLookup);

  const months = ageMonthsFromDate(input.accountBornAt);
  const playedSoC = kvksPlayed(months).includes("soc");

  let perSeedScores: Record<Seed, number> | null = null;
  if (playedSoC) {
    perSeedScores = {
      Imperium: computeScore({ ...input, detectedSeed: "Imperium" }, benchmarkLookup).score,
      A: computeScore({ ...input, detectedSeed: "A" }, benchmarkLookup).score,
      B: computeScore({ ...input, detectedSeed: "B" }, benchmarkLookup).score,
      C: computeScore({ ...input, detectedSeed: "C" }, benchmarkLookup).score,
      D: computeScore({ ...input, detectedSeed: "D" }, benchmarkLookup).score,
    };
  }

  // Seed-level tag is derived purely from PERFORMANCE, not home kingdom.
  // Walk seeds top-down (Imperium → A → B → C → D); the first seed where
  // the applicant clears the "mid" threshold (score ≥ 50) is the tier
  // they fight at. If applicant fights like mid-D but lives in a B-seed
  // kingdom, we tag them "d-seed-mid" — what they DO matters, not where
  // they currently sit.
  //
  // Non-Imperium seeds cap the band at "mid": exceeding mid in (say)
  // A-seed means the applicant should be tested against Imperium next.
  // Only Imperium has high/top bands (since there's no seed above it).
  // If applicant doesn't reach mid even in D-seed, they're below
  // active-fighter baseline → tag "d-seed-low".
  let tags = main.tags;
  if (perSeedScores) {
    const order: Seed[] = ["Imperium", "A", "B", "C", "D"];
    const MID = 50;
    const HIGH = 65;
    const TOP = 85;
    let tagOut: string | null = null;
    for (const seed of order) {
      const s = perSeedScores[seed];
      if (s < MID) continue;
      if (seed === "Imperium") {
        const band = s >= TOP ? "top" : s >= HIGH ? "high" : "mid";
        tagOut = `imperium-seed-${band}`;
      } else {
        tagOut = `${seed.toLowerCase()}-seed-mid`;
      }
      break;
    }
    if (!tagOut) tagOut = "d-seed-low";
    tags = [...main.tags, tagOut];
  }

  return { main, perSeedScores, tags };
}

export function percentileTag(pct: number | null | undefined): string | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct >= 0.99) return "top-1pct";
  if (pct >= 0.95) return "top-5pct";
  if (pct >= 0.75) return "top-25pct";
  return null;
}
