/**
 * One-shot backfill: populate MigrationApplication.detectedSeed for
 * existing rows where it's null, by parsing `currentKingdom` (free-text
 * field where the applicant typed their KD number) and looking up the
 * KingdomSeed table.
 *
 *   npx tsx scripts/backfill-detected-seed.ts
 *
 * Idempotent — re-running re-derives from current KingdomSeed snapshot,
 * so a row's seed can move when heroscroll's weekly refresh shifts the
 * source kingdom between groups.
 */

import { prisma } from "../lib/db";
import { computeScore, type ScoringProfile, type SpendingTier } from "../lib/scoring";
import { loadBenchmarkLookup } from "../lib/benchmarks";

async function main() {
  const apps = await prisma.migrationApplication.findMany({
    select: {
      id: true,
      nickname: true,
      governorId: true,
      currentKingdom: true,
      detectedSeed: true,
    },
  });
  console.log(`Scanning ${apps.length} applications for detectedSeed backfill...\n`);

  // Pre-load KingdomSeed map.
  const seedMap = new Map<number, string>(
    (await prisma.kingdomSeed.findMany({ select: { kingdomId: true, seed: true } }))
      .map((k) => [k.kingdomId, k.seed]),
  );
  console.log(`KingdomSeed snapshot: ${seedMap.size} kingdoms\n`);

  let updated = 0;
  let skipped = 0;
  for (const app of apps) {
    const oldSeed = app.detectedSeed;
    const kdNum = Number.parseInt((app.currentKingdom ?? "").replace(/\D/g, ""), 10);
    if (!Number.isFinite(kdNum) || kdNum <= 0) {
      console.log(`  ${app.nickname.padEnd(20)} skip — currentKingdom="${app.currentKingdom}" not parseable`);
      skipped++;
      continue;
    }
    const newSeed = seedMap.get(kdNum) ?? null;
    if (newSeed === oldSeed) {
      console.log(`  ${app.nickname.padEnd(20)} unchanged (KD ${kdNum} → ${newSeed ?? "—"})`);
      continue;
    }
    await prisma.migrationApplication.update({
      where: { id: app.id },
      data: { detectedSeed: newSeed },
    });
    console.log(`  ${app.nickname.padEnd(20)} KD ${kdNum} → ${oldSeed ?? "—"} → ${newSeed ?? "—"}`);
    updated++;
  }
  console.log(`\nUpdated ${updated} apps, skipped ${skipped}, ${apps.length - updated - skipped} unchanged.`);

  // Recompute scores so seed-aware scoring + tags reflect the new seeds.
  console.log("\nRecomputing all scores with fresh seed assignments...");
  const lookup = await loadBenchmarkLookup();
  const all = await prisma.migrationApplication.findMany();
  let scoreChanged = 0;
  for (const a of all) {
    const r = computeScore(
      {
        accountBornAt: a.accountBornAt,
        vipLevel: a.vipLevel,
        powerN: a.powerN,
        killPointsN: a.killPointsN,
        t1KillsN: a.t1KillsN,
        t2KillsN: a.t2KillsN,
        t3KillsN: a.t3KillsN,
        t4KillsN: a.t4KillsN,
        t5KillsN: a.t5KillsN,
        deathsN: a.deathsN,
        maxValorPointsN: a.maxValorPointsN,
        prevKvkT4KillsN: a.prevKvkT4KillsN,
        prevKvkT5KillsN: a.prevKvkT5KillsN,
        prevKvkDeathsN: a.prevKvkDeathsN,
        prevKvkRank: a.prevKvkRank ?? null,
        prevKvkScanActiveCount: a.prevKvkScanActiveCount ?? null,
        detectedSeed: a.detectedSeed ?? null,
        spendingTier: a.spendingTier as SpendingTier | null,
        scoringProfile: a.scoringProfile as ScoringProfile | null,
      },
      lookup,
    );
    const old = a.overallScore;
    if (old != null && Math.abs(old - r.score) < 0.05) continue;
    await prisma.migrationApplication.update({
      where: { id: a.id },
      data: {
        overallScore: r.score,
        tags: r.tags as unknown as object,
      },
    });
    console.log(`  ${a.nickname.padEnd(20)} ${String(old ?? "—").padStart(5)} → ${String(r.score).padStart(5)} (seed=${a.detectedSeed ?? "—"}, tags=[${r.tags.join(",")}])`);
    scoreChanged++;
  }
  console.log(`\nDone. ${scoreChanged} scores changed.`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
