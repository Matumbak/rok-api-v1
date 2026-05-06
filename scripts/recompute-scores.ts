/**
 * One-shot recompute of overallScore + tags for every existing
 * MigrationApplication. Use after a scoring formula change to bring
 * persisted rows in line with the new logic — admin won't see stale
 * scores until the next PATCH would otherwise trigger the recompute.
 *
 * Run: `npx tsx scripts/recompute-scores.ts`
 *
 * Reads from Neon via the configured DATABASE_URL. Idempotent —
 * running it twice produces the same result.
 */

import { prisma } from "../lib/db";
import { computeScore, type ScoringProfile, type SpendingTier } from "../lib/scoring";

async function main() {
  const apps = await prisma.migrationApplication.findMany({
    select: {
      id: true,
      governorId: true,
      nickname: true,
      accountBornAt: true,
      vipLevel: true,
      powerN: true,
      killPointsN: true,
      t1KillsN: true,
      t2KillsN: true,
      t3KillsN: true,
      t4KillsN: true,
      t5KillsN: true,
      deathsN: true,
      maxValorPointsN: true,
      prevKvkT4KillsN: true,
      prevKvkT5KillsN: true,
      prevKvkDeathsN: true,
      prevKvkRank: true,
      prevKvkScanActiveCount: true,
      spendingTier: true,
      scoringProfile: true,
      overallScore: true,
      tags: true,
    },
  });

  console.log(`Recomputing ${apps.length} applications...\n`);

  let updated = 0;
  for (const app of apps) {
    const result = computeScore({
      accountBornAt: app.accountBornAt,
      vipLevel: app.vipLevel,
      powerN: app.powerN,
      killPointsN: app.killPointsN,
      t1KillsN: app.t1KillsN,
      t2KillsN: app.t2KillsN,
      t3KillsN: app.t3KillsN,
      t4KillsN: app.t4KillsN,
      t5KillsN: app.t5KillsN,
      deathsN: app.deathsN,
      maxValorPointsN: app.maxValorPointsN,
      prevKvkT4KillsN: app.prevKvkT4KillsN,
      prevKvkT5KillsN: app.prevKvkT5KillsN,
      prevKvkDeathsN: app.prevKvkDeathsN,
      prevKvkRank: app.prevKvkRank ?? null,
      prevKvkScanActiveCount: app.prevKvkScanActiveCount ?? null,
      spendingTier: app.spendingTier as SpendingTier | null,
      scoringProfile: app.scoringProfile as ScoringProfile | null,
    });

    const oldScore = app.overallScore;
    const oldTags = Array.isArray(app.tags) ? (app.tags as string[]) : [];

    await prisma.migrationApplication.update({
      where: { id: app.id },
      data: {
        overallScore: result.score,
        tags: result.tags as unknown as object,
      },
    });

    const tagsAdded = result.tags.filter((t) => !oldTags.includes(t));
    const tagsRemoved = oldTags.filter((t) => !result.tags.includes(t));
    const scoreDelta =
      oldScore != null ? (result.score - oldScore).toFixed(1) : "NEW";

    console.log(
      `  ${app.nickname.padEnd(20)} #${app.governorId.padEnd(11)} ` +
        `${String(oldScore ?? "—").padStart(5)} → ${String(result.score).padStart(5)} ` +
        `(Δ ${scoreDelta}, profile=${result.profile})`,
    );
    if (tagsAdded.length > 0)
      console.log(`    + ${tagsAdded.join(", ")}`);
    if (tagsRemoved.length > 0)
      console.log(`    − ${tagsRemoved.join(", ")}`);

    updated++;
  }

  console.log(`\nDone. Updated ${updated} rows.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
