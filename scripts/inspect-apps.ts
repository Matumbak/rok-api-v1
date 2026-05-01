import { prisma } from "../lib/db";
async function main() {
  const apps = await prisma.migrationApplication.findMany({
    select: {
      nickname: true, scoringProfile: true, overallScore: true, accountBornAt: true, vipLevel: true,
      powerN: true, killPointsN: true, t1KillsN: true, t2KillsN: true, t3KillsN: true,
      t4KillsN: true, t5KillsN: true, deathsN: true, maxValorPointsN: true,
      prevKvkT4KillsN: true, prevKvkT5KillsN: true, prevKvkDeathsN: true, previousKvkDkpN: true,
      spendingTier: true, id: true,
    },
  });
  for (const a of apps) {
    const age = a.accountBornAt ? Math.round((Date.now() - a.accountBornAt.getTime())/(86400000*30)) : null;
    console.log(a.nickname, "score=" + a.overallScore, a.scoringProfile, a.spendingTier, "age=" + age + "mo VIP=" + a.vipLevel);
    console.log("  power=" + a.powerN, "KP=" + a.killPointsN, "deaths=" + a.deathsN, "valor=" + a.maxValorPointsN);
    console.log("  t1-5: " + [a.t1KillsN, a.t2KillsN, a.t3KillsN, a.t4KillsN, a.t5KillsN].join("/"));
    console.log("  prevKvk t4/t5/d/DKP: " + [a.prevKvkT4KillsN, a.prevKvkT5KillsN, a.prevKvkDeathsN, a.previousKvkDkpN].join("/"));
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
