/**
 * DEPRECATED — kept as thin re-exports for migration period.
 *
 * The cohort-based calibration system (24 cohorts = stage × spending tier)
 * was replaced by ratio-based scoring driven by per-KvK benchmarks
 * (lib/benchmarks.ts). New scoring uses:
 *
 *   - kvksPlayed(months) → estimate which KvKs an applicant has done
 *   - sum of per-KvK p50 stats → expected lifetime
 *   - applicant_actual / expected → ratio → score curve
 *
 * Spending tier no longer participates in scoring math; it's an
 * informational label only.
 *
 * This file's exports are kept so existing call sites (admin route,
 * cron) compile during the migration. They'll be removed once those
 * call sites switch to importing directly from lib/benchmarks.
 */

import {
  loadBenchmarkLookup,
  rebuildAllBenchmarks,
  rebuildBenchmark,
} from "@/lib/benchmarks";
import {
  KVK_IDS,
  kvksPlayed,
  type ScoringStage,
  type SpendingTier,
} from "@/lib/scoring";

/** @deprecated Use loadBenchmarkLookup from @/lib/benchmarks. */
export { loadBenchmarkLookup as loadCalibrationLookup };

/** @deprecated The recalibrate-on-approval path now rebuilds the
 *  applicant's most-recent KvK benchmark (so an officer-approved
 *  applicant's prevKvk* output gets folded into the relevant KvK's
 *  population). Stage and spending tier are unused. */
export async function recalibrateCohort(
  _stage: ScoringStage,
  _tier: SpendingTier,
): Promise<void> {
  // No-op under the new system. Approved applicants no longer feed
  // calibration directly — only DKP-scan uploads do (richer signal).
  // Approval still triggers a rebuild of all benchmarks so the score
  // popovers show fresh ratios.
  await rebuildAllBenchmarks();
}

/** @deprecated Use rebuildAllBenchmarks from @/lib/benchmarks. */
export async function recalibrateAllCohorts(): Promise<{
  cohorts: number;
  approvedTotal: number;
}> {
  await rebuildAllBenchmarks();
  return { cohorts: KVK_IDS.length, approvedTotal: 0 };
}

// Re-exports kept used elsewhere in the codebase.
export { rebuildBenchmark, kvksPlayed };
