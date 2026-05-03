/**
 * Account scoring + tag derivation for migration applications.
 *
 * COHORT-BASED CALIBRATION
 * ------------------------
 * Each account belongs to one of 24 cohorts: 4 stages × 6 spending tiers.
 * Every cohort has its OWN piecewise anchors per stat — there is no
 * universal "what's a good KP" — what's good depends entirely on
 * (account_age, declared_spend).
 *
 * Stages (auto-derived from accountBornAt, NOT user-overridable):
 *   lk-early    0-6 mo   — KvK 1-2, mostly T4 unlock phase
 *   lk-late     6-15 mo  — KvK 3-4, T5 unlocking
 *   soc-fresh   15-30 mo — first SoC seasons, T5/T6 economy
 *   soc-mature  30+ mo   — established SoC veteran
 *
 * Spending tiers (Zoe Guides $/mo calibration, self-reported):
 *   f2p     $0
 *   low     $1-200/mo lifetime equivalent
 *   mid     $200-1000/mo
 *   high    $1000-5000/mo
 *   whale   $5000-20000/mo
 *   kraken  $20000+/mo (no upper bound — top imperials hit $1M+ lifetime,
 *                       Lilith Ratusha tier added at $500K, AoE city skins
 *                       at $20K-$500K). The cohort anchors are calibrated
 *                       to the LOWER bound of kraken; super-krakens with
 *                       150B+ KP naturally breach the asymptote and score
 *                       95+ from the curve, no special handling.
 *
 * scoringProfile (LK / SoC, 2-value) is RETAINED for the user-facing UI
 * pill but is NOT used in scoring math anymore. Stage handles all scoring
 * branching internally.
 *
 * Curve design:
 *   Anchors are calibrated so that the REAL top-1 player in their cohort
 *   sits at p99. p99 maps directly to 1.00 (full cap) — clipped, no
 *   asymptote past it. Result: a true top-of-game kraken with maxed
 *   stats scores ~100. Players above p99 (rare super-elite outliers)
 *   also score 100 — no further bonus. The prior "asymptote at 4×p99"
 *   design left even the #1 player at ~96/100, which contradicted the
 *   intent that 100 = "the actual best player in the kingdom".
 *
 * Calibration sources (~/obsidian/rok/research/rok-account-scoring-2026-05-deep.md):
 *   - riseofstats kingdom rankings (live top-N tracking)
 *   - YouTube kraken showcases (PEACEMAKER268 mid-SoC 61B, F2P record 3B
 *     single KvK, Nephisto $115K pre-KvK1)
 *   - FunPay/Eldorado/U7Buy marketplace listings (€2921 = 25B KP)
 *   - HoH mechanics (deaths counter NOT decremented → SoC visible deaths
 *     ~2× LK at same combat intensity, anchors reflect this)
 *   - Valor = SINGLE-KVK PEAK (NOT cumulative lifetime)
 *   - Power = CURRENT army (drops with deaths, not lifetime peak)
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

/** Stage boundaries derived from typical RoK kingdom timeline:
 *  Day 1-180   = LK KvK 1-2 phase (lk-early)
 *  Day 180-450 = LK KvK 3-4, T5 unlocks at end (lk-late)
 *  Day 450-900 = First 1-3 SoC seasons (soc-fresh)
 *  Day 900+    = Established SoC veteran (soc-mature) */
export function inferStage(accountBornAt: Date | null): ScoringStage {
  if (!accountBornAt) return "lk-early";
  const months = ageMonthsFromDate(accountBornAt);
  if (months < 6) return "lk-early";
  if (months < 15) return "lk-late";
  if (months < 30) return "soc-fresh";
  return "soc-mature";
}

/** UI-pill profile (2-value), derived from stage. Kept for human-readable
 *  labelling — not used in scoring math. */
export function inferProfile(accountBornAt: Date | null): ScoringProfile {
  const stage = inferStage(accountBornAt);
  return stage === "lk-early" || stage === "lk-late"
    ? "lost-kingdom"
    : "season-of-conquest";
}

/** Anchors for piecewise-linear scoring within one cohort/stat.
 *  value at p50 → 0.40, p80 → 0.70, p95 → 0.90, p99 → 1.00 (clipped).
 *  Calibrate p99 to "the real top-1 player in this cohort" — a true
 *  cohort-topper hits all stats at p99, summing to 100/100. */
interface PiecewiseAnchors {
  p50: number;
  p80: number;
  p95: number;
  p99: number;
}

interface CohortAnchors {
  power: PiecewiseAnchors;
  killPoints: PiecewiseAnchors;
  deaths: PiecewiseAnchors;
  valor: PiecewiseAnchors;
  t5Kills: PiecewiseAnchors;
  prevKvkDkp: PiecewiseAnchors;
}

interface StagePivots {
  agePivotMonths: number;
  vipPivot: number;
  farmOnlyPenalty: number;
}

const STAGE_PIVOTS: Record<ScoringStage, StagePivots> = {
  "lk-early":   { agePivotMonths: 5,  vipPivot: 10, farmOnlyPenalty: -10 },
  "lk-late":    { agePivotMonths: 12, vipPivot: 14, farmOnlyPenalty: -10 },
  "soc-fresh":  { agePivotMonths: 24, vipPivot: 17, farmOnlyPenalty: -12 },
  "soc-mature": { agePivotMonths: 42, vipPivot: 20, farmOnlyPenalty: -15 },
};

/** Per-profile DKP weights. prevKvkDkp = T4 + 3·T5 + 2·deaths style.
 *  LK uses lower deaths weight (no HoH so deaths reflect real losses,
 *  but per-KvK losses are smaller in LK). SoC weights deaths higher
 *  because the visible counter is HoH-inflated AND a SoC kvk is much
 *  bigger absolute. Kept per-profile (not per-stage) since the formula
 *  is about "what counts as DKP" not "what's a good amount". */
const PREV_KVK_DKP_WEIGHTS: Record<
  ScoringProfile,
  { t4: number; t5: number; deaths: number }
> = {
  "lost-kingdom":      { t4: 10, t5: 20, deaths: 50 },
  "season-of-conquest": { t4: 10, t5: 30, deaths: 80 },
};

/** =================================================================
 *  THE 24 COHORT TABLES
 *  =================================================================
 *  Each cohort = stage × spending tier. Anchors are p50/p80/p95/p99
 *  for what an honest player at that cohort produces. p50 = "median
 *  player at this cohort", p99 = "rare top of cohort", asymptote at
 *  4×p99 = "literally impossible".
 *
 *  Calibration intent:
 *    A player whose stats match cohort p80 (good, but not exceptional)
 *    should score ~75-85 of 100. A player whose stats are a full tier
 *    BELOW their claimed cohort scores in single digits per stat, so
 *    a Matumba-type "1.7B KP claiming kraken @ SoC-mature" lands ~30.
 */

const COHORTS: Record<ScoringStage, Record<SpendingTier, CohortAnchors>> = {
  // ─────────────────────────────────────────────────────────────────
  //  STAGE: lk-early (0-6 months) — KvK 1-2, mostly T4 phase
  // ─────────────────────────────────────────────────────────────────
  "lk-early": {
    f2p: {
      power:      { p50:    5e6, p80:   12e6, p95:   20e6, p99:   30e6 },
      killPoints: { p50:    5e6, p80:   20e6, p95:   50e6, p99:  100e6 },
      deaths:     { p50:   50e3, p80:  200e3, p95:  500e3, p99:    1e6 },
      valor:      { p50:  200e3, p80:  800e3, p95:  1.5e6, p99:  2.5e6 },
      t5Kills:    { p50:      0, p80:   10e3, p95:   50e3, p99:  200e3 },
      prevKvkDkp: { p50:      0, p80:    5e6, p95:   20e6, p99:   50e6 },
    },
    low: {
      power:      { p50:    8e6, p80:   18e6, p95:   30e6, p99:   45e6 },
      killPoints: { p50:   15e6, p80:   50e6, p95:  120e6, p99:  250e6 },
      deaths:     { p50:  100e3, p80:  400e3, p95:    1e6, p99:    2e6 },
      valor:      { p50:  400e3, p80:  1.2e6, p95:    2e6, p99:    3e6 },
      t5Kills:    { p50:    5e3, p80:   30e3, p95:  100e3, p99:  300e3 },
      prevKvkDkp: { p50:    5e6, p80:   20e6, p95:   50e6, p99:  100e6 },
    },
    mid: {
      power:      { p50:   15e6, p80:   30e6, p95:   45e6, p99:   65e6 },
      killPoints: { p50:   30e6, p80:  100e6, p95:  250e6, p99:  500e6 },
      deaths:     { p50:  200e3, p80:  700e3, p95:  1.5e6, p99:    3e6 },
      valor:      { p50:  600e3, p80:  1.5e6, p95:  2.5e6, p99:  3.5e6 },
      t5Kills:    { p50:   10e3, p80:   50e3, p95:  200e3, p99:  500e3 },
      prevKvkDkp: { p50:   10e6, p80:   40e6, p95:  100e6, p99:  200e6 },
    },
    high: {
      power:      { p50:   25e6, p80:   45e6, p95:   65e6, p99:   90e6 },
      killPoints: { p50:   60e6, p80:  200e6, p95:  500e6, p99:    1e9 },
      deaths:     { p50:  350e3, p80:    1e6, p95:    2e6, p99:    4e6 },
      valor:      { p50:  800e3, p80:    2e6, p95:    3e6, p99:    4e6 },
      t5Kills:    { p50:   30e3, p80:  150e3, p95:  400e3, p99:  800e3 },
      prevKvkDkp: { p50:   20e6, p80:   80e6, p95:  200e6, p99:  400e6 },
    },
    whale: {
      power:      { p50:   35e6, p80:   60e6, p95:   85e6, p99:  120e6 },
      killPoints: { p50:  100e6, p80:  350e6, p95:  800e6, p99:  1.5e9 },
      deaths:     { p50:  500e3, p80:  1.5e6, p95:    3e6, p99:    6e6 },
      valor:      { p50:    1e6, p80:  2.5e6, p95:  3.5e6, p99:    5e6 },
      t5Kills:    { p50:   80e3, p80:  300e3, p95:  700e3, p99:  1.5e6 },
      prevKvkDkp: { p50:   40e6, p80:  150e6, p95:  350e6, p99:  700e6 },
    },
    kraken: {
      power:      { p50:   50e6, p80:   80e6, p95:  110e6, p99:  160e6 },
      killPoints: { p50:  150e6, p80:  500e6, p95:  1.2e9, p99:  2.5e9 },
      deaths:     { p50:  700e3, p80:    2e6, p95:    4e6, p99:    8e6 },
      valor:      { p50:  1.2e6, p80:    3e6, p95:    4e6, p99:    6e6 },
      t5Kills:    { p50:  200e3, p80:  600e3, p95:  1.2e6, p99:  2.5e6 },
      prevKvkDkp: { p50:   80e6, p80:  250e6, p95:  600e6, p99:  1.2e9 },
    },
  },

  // ─────────────────────────────────────────────────────────────────
  //  STAGE: lk-late (6-15 months) — KvK 3-4, T5 unlocking
  // ─────────────────────────────────────────────────────────────────
  "lk-late": {
    f2p: {
      power:      { p50:   20e6, p80:   40e6, p95:   60e6, p99:   80e6 },
      killPoints: { p50:   50e6, p80:  200e6, p95:  500e6, p99:  1.2e9 },
      deaths:     { p50:  300e3, p80:    1e6, p95:  2.5e6, p99:    5e6 },
      valor:      { p50:  800e3, p80:    2e6, p95:    3e6, p99:    4e6 },
      t5Kills:    { p50:   50e3, p80:  300e3, p95:  800e3, p99:    2e6 },
      prevKvkDkp: { p50:   10e6, p80:   50e6, p95:  150e6, p99:  300e6 },
    },
    low: {
      power:      { p50:   30e6, p80:   55e6, p95:   80e6, p99:  110e6 },
      killPoints: { p50:  150e6, p80:  500e6, p95:  1.2e9, p99:  2.5e9 },
      deaths:     { p50:  600e3, p80:    2e6, p95:  4.5e6, p99:    8e6 },
      valor:      { p50:  1.5e6, p80:    3e6, p95:  4.5e6, p99:    6e6 },
      t5Kills:    { p50:  150e3, p80:  700e3, p95:  1.5e6, p99:    3e6 },
      prevKvkDkp: { p50:   30e6, p80:  120e6, p95:  300e6, p99:  600e6 },
    },
    mid: {
      power:      { p50:   45e6, p80:   75e6, p95:  100e6, p99:  140e6 },
      killPoints: { p50:  400e6, p80:  1.2e9, p95:  2.5e9, p99:    5e9 },
      deaths:     { p50:    1e6, p80:    3e6, p95:    6e6, p99:   10e6 },
      valor:      { p50:    2e6, p80:    4e6, p95:  5.5e6, p99:    7e6 },
      t5Kills:    { p50:  300e3, p80:  1.2e6, p95:  2.5e6, p99:    5e6 },
      prevKvkDkp: { p50:   60e6, p80:  250e6, p95:  600e6, p99:  1.2e9 },
    },
    high: {
      power:      { p50:   60e6, p80:   95e6, p95:  130e6, p99:  180e6 },
      killPoints: { p50:  800e6, p80:  2.5e9, p95:    5e9, p99:    9e9 },
      deaths:     { p50:  1.5e6, p80:    4e6, p95:    8e6, p99:   14e6 },
      valor:      { p50:  2.5e6, p80:    5e6, p95:  6.5e6, p99:    8e6 },
      t5Kills:    { p50:  600e3, p80:    2e6, p95:    4e6, p99:    8e6 },
      prevKvkDkp: { p50:  120e6, p80:  450e6, p95:    1e9, p99:    2e9 },
    },
    whale: {
      power:      { p50:   80e6, p80:  120e6, p95:  160e6, p99:  220e6 },
      killPoints: { p50:  1.5e9, p80:  4.5e9, p95:    8e9, p99:   15e9 },
      deaths:     { p50:    2e6, p80:    5e6, p95:   10e6, p99:   18e6 },
      valor:      { p50:    3e6, p80:  5.5e6, p95:    7e6, p99:    9e6 },
      t5Kills:    { p50:  1.2e6, p80:  3.5e6, p95:    6e6, p99:   12e6 },
      prevKvkDkp: { p50:  200e6, p80:  700e6, p95:  1.6e9, p99:    3e9 },
    },
    kraken: {
      power:      { p50:  100e6, p80:  150e6, p95:  200e6, p99:  280e6 },
      killPoints: { p50:  2.5e9, p80:    6e9, p95:   12e9, p99:   22e9 },
      deaths:     { p50:    3e6, p80:    7e6, p95:   13e6, p99:   22e6 },
      valor:      { p50:  3.5e6, p80:    6e6, p95:    8e6, p99:   10e6 },
      t5Kills:    { p50:    2e6, p80:    5e6, p95:    9e6, p99:   18e6 },
      prevKvkDkp: { p50:  350e6, p80:    1e9, p95:  2.5e9, p99:  4.5e9 },
    },
  },

  // ─────────────────────────────────────────────────────────────────
  //  STAGE: soc-fresh (15-30 months) — first SoC seasons
  //  Deaths anchors ~2× LK because HoH inflates the visible counter.
  // ─────────────────────────────────────────────────────────────────
  "soc-fresh": {
    f2p: {
      power:      { p50:   25e6, p80:   50e6, p95:   75e6, p99:  100e6 },
      killPoints: { p50:  200e6, p80:  800e6, p95:    2e9, p99:    5e9 },
      deaths:     { p50:  800e3, p80:    3e6, p95:    7e6, p99:   13e6 },
      valor:      { p50:  1.5e6, p80:  3.5e6, p95:    5e6, p99:    7e6 },
      t5Kills:    { p50:  300e3, p80:  1.5e6, p95:    4e6, p99:    8e6 },
      prevKvkDkp: { p50:   50e6, p80:  200e6, p95:  600e6, p99:  1.2e9 },
    },
    low: {
      power:      { p50:   35e6, p80:   70e6, p95:  100e6, p99:  140e6 },
      killPoints: { p50:  500e6, p80:    2e9, p95:    5e9, p99:   12e9 },
      deaths:     { p50:  1.5e6, p80:    5e6, p95:   10e6, p99:   18e6 },
      valor:      { p50:  2.5e6, p80:    5e6, p95:    7e6, p99:    9e6 },
      t5Kills:    { p50:  600e3, p80:    3e6, p95:    7e6, p99:   14e6 },
      prevKvkDkp: { p50:  120e6, p80:  500e6, p95:  1.5e9, p99:    3e9 },
    },
    mid: {
      power:      { p50:   50e6, p80:   95e6, p95:  130e6, p99:  180e6 },
      killPoints: { p50:  1.2e9, p80:    5e9, p95:   12e9, p99:   25e9 },
      deaths:     { p50:    3e6, p80:    8e6, p95:   16e6, p99:   28e6 },
      valor:      { p50:  3.5e6, p80:    6e6, p95:    8e6, p99:   10e6 },
      t5Kills:    { p50:  1.5e6, p80:    5e6, p95:   12e6, p99:   22e6 },
      prevKvkDkp: { p50:  300e6, p80:    1e9, p95:    3e9, p99:    6e9 },
    },
    high: {
      power:      { p50:   75e6, p80:  120e6, p95:  170e6, p99:  230e6 },
      killPoints: { p50:    3e9, p80:   10e9, p95:   22e9, p99:   45e9 },
      deaths:     { p50:    5e6, p80:   12e6, p95:   22e6, p99:   40e6 },
      valor:      { p50:  4.5e6, p80:    7e6, p95:  9.5e6, p99:   12e6 },
      t5Kills:    { p50:    3e6, p80:    9e6, p95:   20e6, p99:   35e6 },
      prevKvkDkp: { p50:  700e6, p80:  2.5e9, p95:    6e9, p99:   12e9 },
    },
    whale: {
      power:      { p50:  100e6, p80:  160e6, p95:  220e6, p99:  300e6 },
      killPoints: { p50:    6e9, p80:   18e9, p95:   38e9, p99:   70e9 },
      deaths:     { p50:    7e6, p80:   16e6, p95:   30e6, p99:   55e6 },
      valor:      { p50:    5e6, p80:    8e6, p95:   11e6, p99:   14e6 },
      t5Kills:    { p50:    5e6, p80:   14e6, p95:   28e6, p99:   50e6 },
      prevKvkDkp: { p50:  1.5e9, p80:  4.5e9, p95:   10e9, p99:   20e9 },
    },
    kraken: {
      power:      { p50:  130e6, p80:  200e6, p95:  270e6, p99:  380e6 },
      killPoints: { p50:   10e9, p80:   25e9, p95:   55e9, p99:  100e9 },
      deaths:     { p50:   10e6, p80:   22e6, p95:   40e6, p99:   70e6 },
      valor:      { p50:    6e6, p80:  9.5e6, p95:   13e6, p99:   17e6 },
      t5Kills:    { p50:    8e6, p80:   20e6, p95:   40e6, p99:   70e6 },
      prevKvkDkp: { p50:  2.5e9, p80:    7e9, p95:   16e9, p99:   30e9 },
    },
  },

  // ─────────────────────────────────────────────────────────────────
  //  STAGE: soc-mature (30+ months) — established SoC veteran
  //  Kraken p99 is calibrated to the LIVE top-1 of the entire game
  //  (riseofstats live ranks, May 2026: top KP ~150B, top power ~500M,
  //  top single-KvK valor peak ~22M, top T5 cumulative ~100M, mega-KvK
  //  DKP ~15-25B). A real top-of-game player hits p99 across the board
  //  and scores ~100/100. Above-p99 outliers (theoretical 200B+ KP
  //  super-krakens) clip at 100 — no further bonus.
  // ─────────────────────────────────────────────────────────────────
  "soc-mature": {
    f2p: {
      power:      { p50:   35e6, p80:   65e6, p95:   90e6, p99:  120e6 },
      killPoints: { p50:  800e6, p80:    3e9, p95:    8e9, p99:   18e9 },
      deaths:     { p50:    2e6, p80:    7e6, p95:   16e6, p99:   30e6 },
      valor:      { p50:    2e6, p80:    4e6, p95:    6e6, p99:    8e6 },
      t5Kills:    { p50:  800e3, p80:    3e6, p95:    8e6, p99:   16e6 },
      prevKvkDkp: { p50:  200e6, p80:  800e6, p95:    2e9, p99:    4e9 },
    },
    low: {
      power:      { p50:   50e6, p80:   85e6, p95:  120e6, p99:  160e6 },
      killPoints: { p50:    2e9, p80:    7e9, p95:   18e9, p99:   35e9 },
      deaths:     { p50:    4e6, p80:   12e6, p95:   25e6, p99:   45e6 },
      valor:      { p50:    3e6, p80:  5.5e6, p95:    8e6, p99:   11e6 },
      t5Kills:    { p50:    2e6, p80:    6e6, p95:   14e6, p99:   25e6 },
      prevKvkDkp: { p50:  400e6, p80:  1.5e9, p95:    4e9, p99:    8e9 },
    },
    mid: {
      power:      { p50:   70e6, p80:  110e6, p95:  150e6, p99:  200e6 },
      killPoints: { p50:    4e9, p80:   14e9, p95:   32e9, p99:   60e9 },
      deaths:     { p50:    6e6, p80:   18e6, p95:   35e6, p99:   60e6 },
      valor:      { p50:    4e6, p80:    7e6, p95:   10e6, p99:   13e6 },
      t5Kills:    { p50:    4e6, p80:   10e6, p95:   22e6, p99:   40e6 },
      prevKvkDkp: { p50:  800e6, p80:    3e9, p95:    8e9, p99:   16e9 },
    },
    high: {
      power:      { p50:  100e6, p80:  150e6, p95:  200e6, p99:  270e6 },
      killPoints: { p50:    8e9, p80:   25e9, p95:   55e9, p99:  100e9 },
      deaths:     { p50:   10e6, p80:   25e6, p95:   50e6, p99:   85e6 },
      valor:      { p50:    5e6, p80:  8.5e6, p95:   12e6, p99:   16e6 },
      t5Kills:    { p50:    7e6, p80:   18e6, p95:   35e6, p99:   60e6 },
      prevKvkDkp: { p50:  1.5e9, p80:    5e9, p95:   12e9, p99:   24e9 },
    },
    whale: {
      power:      { p50:  150e6, p80:  220e6, p95:  290e6, p99:  380e6 },
      killPoints: { p50:   15e9, p80:   40e9, p95:   80e9, p99:  140e9 },
      deaths:     { p50:   15e6, p80:   35e6, p95:   65e6, p99:  110e6 },
      valor:      { p50:  6.5e6, p80:   10e6, p95:   14e6, p99:   18e6 },
      t5Kills:    { p50:   12e6, p80:   28e6, p95:   50e6, p99:   85e6 },
      prevKvkDkp: { p50:    3e9, p80:    8e9, p95:   18e9, p99:   35e9 },
    },
    kraken: {
      power:      { p50:  180e6, p80:  280e6, p95:  380e6, p99:  500e6 },
      killPoints: { p50:   20e9, p80:   50e9, p95:   90e9, p99:  150e9 },
      deaths:     { p50:   18e6, p80:   40e6, p95:   75e6, p99:  130e6 },
      valor:      { p50:    7e6, p80:   11e6, p95:   15e6, p99:   22e6 },
      t5Kills:    { p50:   15e6, p80:   35e6, p95:   60e6, p99:  100e6 },
      prevKvkDkp: { p50:  1.5e9, p80:    4e9, p95:   10e9, p99:   20e9 },
    },
  },
};

/** Component caps (max pts). Sum to 100; headroom for sanity penalties. */
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
  stage: ScoringStage;
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
 *   value ≤ 0     → 0
 *   value at p50  → 0.40
 *   value at p80  → 0.70
 *   value at p95  → 0.90
 *   value at p99  → 1.00 (clipped — no asymptote past)
 *
 * p99 = "the actual top-1 player in this cohort", calibrated to live
 * top-of-kingdom benchmarks. Hitting p99 on all stats simultaneously
 * → 100/100. Above-p99 outliers also score 100; no further reward.
 *
 * Why piecewise (not log10): log saturates by p80 — every whale lands
 * at 95+ and the formula loses discrimination in the band that matters
 * most. Piecewise preserves dynamic range across the upper tail.
 */
function piecewiseScore(
  value: number | null | undefined,
  anchors: PiecewiseAnchors,
): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  const { p50, p80, p95, p99 } = anchors;
  if (p50 <= 0) {
    // Cohort where the stat doesn't apply (e.g. T5 in lk-early f2p).
    // Any positive value lands above expectations; map onto the upper
    // band relative to p99 alone.
    if (value <= p99) return 0.4 + (value / p99) * 0.6;
    return 1.0;
  }
  if (value <= p50) return (value / p50) * 0.4;
  if (value <= p80) return 0.4 + ((value - p50) / (p80 - p50)) * 0.3;
  if (value <= p95) return 0.7 + ((value - p80) / (p95 - p80)) * 0.2;
  if (value <= p99) return 0.9 + ((value - p95) / (p99 - p95)) * 0.1;
  return 1.0;
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

/** KP yields per tier (game-engine values, ×5 vs prior internal model
 *  but same RATIOS — used purely for low-tier-share computation):
 *    T1 = 5, T2 = 10, T3 = 20, T4 = 40, T5 = 100
 *  A "T1 trader" who farmed T1 kills for KP shows up as lowTierShare > 0.6. */
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
  const total = v1 * 5 + v2 * 10 + v3 * 20 + v4 * 40 + v5 * 100;
  if (total < 100_000) return 0;
  const lowTier = v1 * 5 + v2 * 10 + v3 * 20;
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
  const w = PREV_KVK_DKP_WEIGHTS[profile];
  return v4 * w.t4 + v5 * w.t5 + vd * w.deaths;
}

export function computeScore(input: ScoreInputs): ScoreResult {
  const stage = inferStage(input.accountBornAt);
  const profile = input.scoringProfile ?? inferProfile(input.accountBornAt);
  const tier = input.spendingTier ?? "f2p";
  const cohort = COHORTS[stage][tier];
  const stagePivots = STAGE_PIVOTS[stage];

  const months = ageMonthsFromDate(input.accountBornAt);
  const vip = Number.parseInt(input.vipLevel, 10);

  const ageScore = Math.min(
    CAPS.age,
    (months / stagePivots.agePivotMonths) * CAPS.age,
  );
  const vipScore = Number.isFinite(vip)
    ? Math.min(CAPS.vip, (vip / stagePivots.vipPivot) * CAPS.vip)
    : 0;

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

  const prevDkp = computePrevKvkDkp(
    input.prevKvkT4KillsN,
    input.prevKvkT5KillsN,
    input.prevKvkDeathsN,
    profile,
  );

  // Stat scores against the player's cohort (declared tier × derived stage).
  const powerScore = piecewiseScore(input.powerN, cohort.power) * CAPS.power;
  const kpScore = piecewiseScore(effectiveKp, cohort.killPoints) * CAPS.killPoints;
  const deathsScore = piecewiseScore(input.deathsN, cohort.deaths) * CAPS.deaths;
  const valorScore = piecewiseScore(input.maxValorPointsN, cohort.valor) * CAPS.valor;
  const t5Score = piecewiseScore(input.t5KillsN, cohort.t5Kills) * CAPS.t5Kills;
  const prevDkpScore =
    prevDkp != null
      ? piecewiseScore(prevDkp, cohort.prevKvkDkp) * CAPS.prevKvkDkp
      : 0;
  const baseStats =
    powerScore + kpScore + deathsScore + valorScore + t5Score + prevDkpScore;

  // What the SAME stats would have scored in the F2P-cohort baseline,
  // for the breakdown popover. The delta = "spending-tier impact":
  //   F2P-claim with high stats: ≈ 0 (you'd score the same as F2P)
  //   Kraken-claim with weak stats: large negative (kraken anchors are
  //     much higher, so your stats place much lower in the curve)
  const f2pCohort = COHORTS[stage]["f2p"];
  const baseStatsF2P =
    piecewiseScore(input.powerN, f2pCohort.power) * CAPS.power +
    piecewiseScore(effectiveKp, f2pCohort.killPoints) * CAPS.killPoints +
    piecewiseScore(input.deathsN, f2pCohort.deaths) * CAPS.deaths +
    piecewiseScore(input.maxValorPointsN, f2pCohort.valor) * CAPS.valor +
    piecewiseScore(input.t5KillsN, f2pCohort.t5Kills) * CAPS.t5Kills +
    (prevDkp != null
      ? piecewiseScore(prevDkp, f2pCohort.prevKvkDkp) * CAPS.prevKvkDkp
      : 0);
  const spendingMod = round1(baseStats - baseStatsF2P);

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
    sanityPenalty += stagePivots.farmOnlyPenalty;
    sanityTags.push("farm-only");
  }

  // Farm-padded: KP/deaths ratio > 4000 means killing a LOT without
  // dying — usually a result of weeks farming small-troop barb camps
  // (Lost Canyon, Goblins) for daily KP. Real KvK combat hits ~500-2000.
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

  // ---------------- final score ----------------
  const ageVip = ageScore + vipScore;
  const raw = ageVip + baseStats + sanityPenalty;
  const score = Math.max(0, Math.min(100, Math.round(raw * 10) / 10));

  if (
    (input.spendingTier === "whale" || input.spendingTier === "kraken") &&
    score < 50
  ) {
    sanityTags.push("weak-whale");
  }

  // ---------------- descriptive tags ----------------
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
    stage,
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
