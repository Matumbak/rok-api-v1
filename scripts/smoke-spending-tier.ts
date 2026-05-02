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
  scoringProfile: "lost-kingdom" as const,
};

// Lifetime-realistic SoC super-kraken: ~5 SoC seasons × ~25B = ~120B.
const realKrakenSoC = {
  accountBornAt: SOC_BORN,
  vipLevel: "22",
  powerN: 420_000_000,
  killPointsN: 120_000_000_000,
  t1KillsN: 2_000_000,
  t2KillsN: 1_500_000,
  t3KillsN: 1_000_000,
  t4KillsN: 25_000_000,
  t5KillsN: 60_000_000,
  deathsN: 80_000_000,
  maxValorPointsN: 32_000_000,
  prevKvkT4KillsN: 5_000_000,
  prevKvkT5KillsN: 25_000_000,
  prevKvkDeathsN: 35_000_000,
  scoringProfile: "season-of-conquest" as const,
};

function runCases(label: string, base: Omit<ScoreInputs, "spendingTier">) {
  console.log(`\n=== ${label} (KP=${((base.killPointsN ?? 0) / 1e9).toFixed(2)}B, profile=${base.scoringProfile}) ===`);
  const tiers: SpendingTier[] = ["f2p", "low", "mid", "high", "whale", "kraken"];
  for (const tier of tiers) {
    const r = computeScore({ ...base, spendingTier: tier });
    const b = r.breakdown;
    console.log(
      `  ${tier.padEnd(7)} score=${String(r.score).padStart(5)}  ` +
        `pwr=${b.power.toFixed(1).padStart(4)} kp=${b.killPoints.toFixed(1).padStart(4)} ` +
        `dth=${b.deaths.toFixed(1).padStart(4)} val=${b.valor.toFixed(1).padStart(4)} ` +
        `t5=${b.t5Kills.toFixed(1).padStart(4)} prv=${b.prevKvkDkp.toFixed(1).padStart(4)}  ` +
        `tier=${b.spendingModifier.toFixed(1).padStart(6)} sanity=${b.sanityPenalty.toFixed(0).padStart(3)}  ` +
        `tags=[${r.tags.join(",")}]`,
    );
  }
}

runCases("Mediocre LK account, 1.7B KP", baseLk);
runCases("Matumba (SoC, 1.7B KP)", matumba);
runCases("Real LK kraken (4.3B KP, 1 KvK)", realKrakenLK);
runCases("Real SoC super-kraken (35B KP, mega KvK)", realKrakenSoC);

console.log("\nExpected:");
console.log("  - F2P+1.7B LK     → high (e.g. 80+)  current Matumba @ kraken should drop to <40");
console.log("  - Real LK kraken  → high even claiming kraken (60-75)");
console.log("  - Real SoC super-kraken → near 100 claiming kraken");
