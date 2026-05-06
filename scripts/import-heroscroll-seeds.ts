/**
 * Scrape HeroScrolls' Kingdom Seeds page and upsert all rows into the
 * KingdomSeed table. Run periodically to track shifts between Groups
 * (kingdoms get promoted/relegated as power changes).
 *
 *   npx tsx scripts/import-heroscroll-seeds.ts
 *
 * The page (heroscroll.com/rok/seeds) embeds the kingdom array inline as
 * Next.js streamed JSON. We grab the HTML, extract every rollup record,
 * sort by HeroScrolls' rank, and re-derive the seed (Imperium / A / B /
 * C / D) using the same partition the site itself uses:
 *
 *   ranks 1-24                  → "Imperium" (Elite 24)
 *   next ⌊(N-24)/4⌋             → "A"
 *   next ⌊(N-24)/4⌋             → "B"
 *   next ⌊(N-24)/4⌋             → "C"
 *   remainder                   → "D"
 *
 * Idempotent — re-running just upserts the same kingdomIds with fresh
 * stats + maybe-different seeds.
 */

import { prisma } from "../lib/db";

const SEEDS_URL = "https://heroscroll.com/rok/seeds";

interface RawRollup {
  rollup_type: string;
  timestamp: string;
  last_updated: number;
  kingdom_id: number;
  total_power: number;
  total_killpoints: number;
  total_deads: number;
  total_troop_power: number;
  player_count: number;
  ch25_count: number;
  domain_count: number;
  inactive_player_count: number;
  total_acclaim: number;
  rank: number;
  power: number;
  killpoints: number;
  deads: number;
  troop_power: number;
}

async function main() {
  console.log(`Fetching ${SEEDS_URL} ...`);
  const res = await fetch(SEEDS_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (rok-api importer)" },
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status} from heroscroll`);
    process.exit(1);
  }
  const html = await res.text();
  console.log(`Got ${(html.length / 1024).toFixed(0)} KB`);

  // The data is double-escaped JSON inside <script>self.__next_f.push(...)</script>.
  // Each kingdom rollup starts with \"rollup_type\":\"top300\" and ends with
  // \"troop_power\":N.
  const re =
    /\\"rollup_type\\":\\"top300\\"[\s\S]*?\\"troop_power\\":\d+/g;
  const matches = html.match(re);
  if (!matches) {
    console.error("No rollup matches found — page format may have changed.");
    process.exit(1);
  }
  console.log(`Found ${matches.length} kingdom records in HTML`);

  const rollups: RawRollup[] = [];
  for (const m of matches) {
    const decoded = m.replace(/\\"/g, '"');
    try {
      const obj = JSON.parse("{" + decoded + "}") as RawRollup;
      rollups.push(obj);
    } catch (e) {
      console.warn(`Failed to parse one record: ${(e as Error).message}`);
    }
  }
  console.log(`Parsed ${rollups.length} rollups`);

  // Sort by heroscroll rank ascending (1 = strongest), then assign seeds.
  rollups.sort((a, b) => a.rank - b.rank);

  const N = rollups.length;
  const IMPERIUM_COUNT = 24;
  const remaining = N - IMPERIUM_COUNT;
  const per = Math.floor(remaining / 4);

  // Assign by absolute index after sorting:
  //   [0..24)   → Imperium
  //   [24..24+per)         → A
  //   [24+per..24+2*per)   → B
  //   [24+2*per..24+3*per) → C
  //   [24+3*per..N)        → D (catches the remainder)
  const seedFor = (idx: number): string => {
    if (idx < IMPERIUM_COUNT) return "Imperium";
    const offset = idx - IMPERIUM_COUNT;
    if (offset < per) return "A";
    if (offset < 2 * per) return "B";
    if (offset < 3 * per) return "C";
    return "D";
  };

  // Bulk upsert — Prisma doesn't have native bulk upsert so we delete-then-
  // createMany for atomicity.
  const data = rollups.map((r, idx) => ({
    kingdomId: r.kingdom_id,
    seed: seedFor(idx),
    rank: r.rank,
    totalPower: r.total_power,
    totalKillpoints: r.total_killpoints,
    totalDeads: r.total_deads,
    totalTroopPower: r.total_troop_power,
    totalAcclaim: r.total_acclaim ?? 0,
    playerCount: r.player_count,
    ch25Count: r.ch25_count,
    domainCount: r.domain_count,
    inactivePlayerCount: r.inactive_player_count,
    scrapedTimestamp: r.timestamp,
    lastUpdated: BigInt(r.last_updated),
  }));

  console.log("Truncating + bulk inserting ...");
  await prisma.$transaction([
    prisma.kingdomSeed.deleteMany({}),
    prisma.kingdomSeed.createMany({ data }),
  ]);

  // Summary
  const counts = await prisma.kingdomSeed.groupBy({
    by: ["seed"],
    _count: { _all: true },
  });
  console.log("\nSeed distribution:");
  const order = ["Imperium", "A", "B", "C", "D"];
  for (const seed of order) {
    const c = counts.find((x) => x.seed === seed);
    console.log(`  ${seed.padEnd(10)} ${(c?._count._all ?? 0).toString().padStart(5)}`);
  }

  // Spot-check some interesting kingdoms
  const interesting = [4028, 3091, 3801, 1, 100, 1500, 3000];
  console.log("\nSpot check:");
  for (const id of interesting) {
    const k = await prisma.kingdomSeed.findUnique({ where: { kingdomId: id } });
    if (k) {
      console.log(
        `  KD ${id.toString().padStart(4)} → ${k.seed.padEnd(10)} rank=${k.rank.toString().padStart(4)} power=${(k.totalPower / 1e9).toFixed(2)}B`,
      );
    } else {
      console.log(`  KD ${id.toString().padStart(4)} → not in dataset`);
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
