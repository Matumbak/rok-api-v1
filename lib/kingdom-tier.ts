/**
 * Kingdom-tier classification for the benchmark partition.
 *
 * Each non-Imperium kingdom in `KingdomSeed` is assigned a tier within
 * its seed group (A / B / C / D) based on aggregate KP performance:
 *
 *   top 10% by totalKillpoints  → "high"
 *   next 20% (10–30%)           → "mid"
 *   bottom 70% (30–100%)        → "low"
 *
 * Imperium kingdoms (top-24 globally) always get tier=null — the whole
 * roster of an Imperium kingdom is treated as a single elite bucket,
 * no within-tier split needed.
 *
 * Source data: `KingdomSeed.totalKillpoints` (sum of top-300 governors'
 * lifetime KP, scraped from heroscroll). This means tier classification
 * works against the exact same data that determined seed assignment —
 * no scan re-uploads required.
 *
 * Why tier = a property of the KINGDOM and not the PLAYER:
 *   When an applicant submits, we look up their home kingdom in
 *   KingdomSeed and read both seed + tier in one shot. Their score gets
 *   benchmarked against the (seed × tier) bucket their kingdom falls
 *   into. The same applicant from an A-high kingdom always benchmarks
 *   against A-high, regardless of where they personally rank inside
 *   their kingdom's top-300 list — kingdom tier is the environment, the
 *   applicant's stats decide whether they thrive in it.
 *
 * Re-run safety: the function is idempotent. It reads the current
 * `totalKillpoints` snapshot and overwrites `tier` for every kingdom in
 * one pass. Schedule it after every heroscroll refresh so tier shifts
 * with the live ranking.
 */

import { prisma } from "@/lib/db";

/** Cutoffs for the within-seed kingdom rank → tier mapping. Mirror of
 *  TIER_CUTOFFS in lib/benchmarks.ts (player-level partition) so a
 *  "high" kingdom and a "high" player share the same intuitive meaning
 *  ("top 10% of their reference group"). */
const TIER_CUTOFFS = {
  high: 0.1, // top 10% of kingdoms within the seed
  mid: 0.3, // next 20% (10–30%)
  // remainder is "low"
} as const;

const NON_IMPERIUM_SEEDS = ["A", "B", "C", "D"] as const;

export type ClassifyKingdomTiersResult = {
  perSeed: Record<
    "A" | "B" | "C" | "D",
    { high: number; mid: number; low: number; total: number }
  >;
  imperium: number;
  unclassified: number;
};

/**
 * Compute and persist the within-seed tier for every kingdom in
 * KingdomSeed. Called by:
 *   - the heroscroll refresh cron, right after the seed import (so a
 *     fresh seed snapshot also gets fresh tiers)
 *   - the manual /api/benchmarks/reclassify-kingdoms admin endpoint
 *
 * Returns a per-seed breakdown of how many kingdoms landed in each
 * tier — handy for sanity-checking after a re-import.
 */
export async function classifyKingdomTiers(): Promise<ClassifyKingdomTiersResult> {
  const all = await prisma.kingdomSeed.findMany({
    select: { kingdomId: true, seed: true, totalKillpoints: true },
  });

  const perSeed: ClassifyKingdomTiersResult["perSeed"] = {
    A: { high: 0, mid: 0, low: 0, total: 0 },
    B: { high: 0, mid: 0, low: 0, total: 0 },
    C: { high: 0, mid: 0, low: 0, total: 0 },
    D: { high: 0, mid: 0, low: 0, total: 0 },
  };
  let imperium = 0;
  let unclassified = 0;

  // Group by seed.
  const grouped: Record<string, typeof all> = {};
  for (const k of all) {
    if (!grouped[k.seed]) grouped[k.seed] = [];
    grouped[k.seed].push(k);
  }

  // Build a flat list of (kingdomId, tier) updates.
  const updates: Array<{ kingdomId: number; tier: string | null }> = [];

  // Imperium → null tier (single bucket).
  for (const k of grouped.Imperium ?? []) {
    updates.push({ kingdomId: k.kingdomId, tier: null });
    imperium++;
  }

  // A / B / C / D → rank by totalKillpoints desc, slice into 10/20/70.
  for (const seed of NON_IMPERIUM_SEEDS) {
    const group = grouped[seed] ?? [];
    if (group.length === 0) continue;

    // Sort descending — biggest KP first.
    const sorted = [...group].sort(
      (a, b) => b.totalKillpoints - a.totalKillpoints,
    );
    const n = sorted.length;
    // At least 1 kingdom per tier — otherwise tiny seed groups (e.g.
    // a fresh import with very few D-seed entries) end up with empty
    // high or mid buckets and the whole group falls into low.
    const highEnd = Math.max(1, Math.round(n * TIER_CUTOFFS.high));
    const midEnd = Math.max(highEnd + 1, Math.round(n * TIER_CUTOFFS.mid));

    perSeed[seed].total = n;
    for (let i = 0; i < n; i++) {
      const tier: "high" | "mid" | "low" =
        i < highEnd ? "high" : i < midEnd ? "mid" : "low";
      updates.push({ kingdomId: sorted[i].kingdomId, tier });
      perSeed[seed][tier]++;
    }
  }

  // Anything else (no seed match — shouldn't happen with current data,
  // but safe to count) → null tier, unclassified bucket.
  const handled = new Set(updates.map((u) => u.kingdomId));
  for (const k of all) {
    if (!handled.has(k.kingdomId)) {
      updates.push({ kingdomId: k.kingdomId, tier: null });
      unclassified++;
    }
  }

  // Persist via transaction. updateMany per-tier batches would be
  // tighter, but the dataset is small (~3k rows) and per-row updates
  // give us idempotent writes that survive partial failures cleanly.
  // Using a single transaction so the whole reclassification is atomic.
  await prisma.$transaction(
    updates.map((u) =>
      prisma.kingdomSeed.update({
        where: { kingdomId: u.kingdomId },
        data: { tier: u.tier },
      }),
    ),
  );

  return { perSeed, imperium, unclassified };
}
