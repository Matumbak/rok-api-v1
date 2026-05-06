/**
 * Smoke-test the spending-tier expectations divisor. Synthetic inputs
 * verify that:
 *   - F2P with 1.7B LK KP scores high (great output for tier)
 *   - Kraken with same 1.7B LK KP scores low (expected 12× more)
 *   - Mid-spend with proportional output scores in the middle band
 */

import {
  computeScore,
  type ScoreInputs,
  type SpendingTier,
} from "../lib/scoring";

const LK_BORN = new Date("2025-08-01");
const SOC_BORN = new Date("2024-01-01");

const baseLk = {
  accountBornAt: LK_BORN,
  vipLevel: "16",
  powerN: 75_000_000,
  killPointsN: 1_700_000_000,
  t1KillsN: 200_000,
  t2KillsN: 150_000,
  t3KillsN: 100_000,
  t4KillsN: 1_500_000,
  t5KillsN: 800_000,
  deathsN: 1_500_000,
  maxValorPointsN: 2_000_000,
  prevKvkT4KillsN: 800_000,
  prevKvkT5KillsN: 400_000,
  prevKvkDeathsN: 600_000,
  prevKvkRank: null,
  prevKvkScanActiveCount: null,
  detectedSeed: null,
  scoringProfile: "lost-kingdom" as const,
};

const matumba = {
  accountBornAt: SOC_BORN,
  vipLevel: "18",
  powerN: 95_000_000,
  killPointsN: 1_700_000_000,
  t1KillsN: 200_000,
  t2KillsN: 150_000,
  t3KillsN: 100_000,
  t4KillsN: 1_500_000,
  t5KillsN: 800_000,
  deathsN: 1_500_000,
  maxValorPointsN: 2_500_000,
  prevKvkT4KillsN: 800_000,
  prevKvkT5KillsN: 400_000,
  prevKvkDeathsN: 600_000,
  prevKvkRank: null,
  prevKvkScanActiveCount: null,
  detectedSeed: null,
  scoringProfile: "season-of-conquest" as const,
};

// Lifetime-realistic LK kraken: 4 KvKs × ~4B each = ~16B KP.
const realKrakenLK = {
  accountBornAt: LK_BORN,
  vipLevel: "20",
  powerN: 140_000_000,
  killPointsN: 16_000_000_000,
  t1KillsN: 1_000_000,
  t2KillsN: 800_000,
  t3KillsN: 600_000,
  t4KillsN: 18_000_000,
  t5KillsN: 12_000_000,
  deathsN: 12_000_000,
  maxValorPointsN: 9_000_000,
  prevKvkT4KillsN: 5_000_000,
  prevKvkT5KillsN: 4_500_000,
  prevKvkDeathsN: 8_000_000,
  prevKvkRank: null,
  prevKvkScanActiveCount: null,
  detectedSeed: null,
  scoringProfile: "lost-kingdom" as const,
};

// Live top-1 SoC super-kraken (Mr hope / Wild lion / Velociraptor 1 class,
// observed May 2026): power 1.77B current (max 3.18B), KP 127B, deaths 772M,
// max valor 428M, T5 cumulative 5.7B, T4 1.26B. Account ~4 years old, max VIP.
const realKrakenSoC = {
  accountBornAt: new Date("2022-05-01"),
  vipLevel: "25",
  powerN: 1_770_000_000,
  killPointsN: 150_000_000_000,
  t1KillsN: 81_000_000,
  t2KillsN: 30_000_000,
  t3KillsN: 20_000_000,
  t4KillsN: 1_260_000_000,
  t5KillsN: 5_700_000_000,
  deathsN: 772_000_000,
  maxValorPointsN: 500_000_000,
  // Single mega-KvK from a top kraken: ~200M T5 + ~250M deaths in one cycle.
  prevKvkT4KillsN: 80_000_000,
  prevKvkT5KillsN: 200_000_000,
  prevKvkDeathsN: 250_000_000,
  prevKvkRank: 5,
  prevKvkScanActiveCount: 2400,
  detectedSeed: "Imperium" as const,
  scoringProfile: "season-of-conquest" as const,
};

function runCases(label: string, base: Omit<ScoreInputs, "spendingTier">) {
  console.log(`\n=== ${label} (KP=${((base.killPointsN ?? 0) / 1e9).toFixed(2)}B, profile=${base.scoringProfile}) ===`);
  const tiers: SpendingTier[] = ["f2p", "low", "mid", "high", "whale", "kraken"];
  for (const tier of tiers) {
    const r = computeScore({ ...base, spendingTier: tier });
    const b = r.breakdown;
    const ratios = b.ratios;
    console.log(
      `  ${tier.padEnd(7)} score=${String(r.score).padStart(5)}  ` +
        `pwr=${b.power.toFixed(1).padStart(4)} kp=${b.killPoints.toFixed(1).padStart(4)} ` +
        `dth=${b.deaths.toFixed(1).padStart(4)} val=${b.valor.toFixed(1).padStart(4)} ` +
        `t5=${b.t5Kills.toFixed(1).padStart(4)} prv=${b.prevKvkDkp.toFixed(1).padStart(4)}  ` +
        `kvks=${r.playedKvks.length} kp×=${ratios.killPoints?.toFixed(1) ?? "—"} ` +
        `t5×=${ratios.t5Kills?.toFixed(1) ?? "—"} ` +
        `sanity=${b.sanityPenalty.toFixed(0).padStart(3)}  ` +
        `tags=[${r.tags.join(",")}]`,
    );
  }
}

runCases("Mediocre LK account, 1.7B KP", baseLk);
runCases("Matumba (SoC, 1.7B KP)", matumba);
runCases("Real LK kraken (4.3B KP, 1 KvK)", realKrakenLK);
runCases("Live top-1 SoC super-kraken (150B KP, 4yr vet)", realKrakenSoC);

console.log("\nExpected:");
console.log("  - F2P+1.7B LK              → high (e.g. 80+);  Matumba @ kraken should drop to <40");
console.log("  - Real LK kraken (16B)     → high even claiming kraken (90+)");
console.log("  - Live top-1 super-kraken  → ~100 claiming kraken (cohort-topper)");
