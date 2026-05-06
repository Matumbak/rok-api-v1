/**
 * One-shot bootstrap: ingest the kingdom 3801 KvK4 export as the first
 * BenchmarkUpload for kvkId="kvk4". After this runs, KvkBenchmark[kvk4]
 * blends the hardcoded prior with this real-world distribution
 * (sample-weighted), giving the scoring system genuine ground truth for
 * the kvk4 KvK.
 *
 * Run: npx tsx scripts/bootstrap-kvk4-from-3801.ts
 *
 * Idempotent — re-running creates another BenchmarkUpload row, which
 * the rebuild combines with weight = rowCount. If you re-run with the
 * same data, the kvk4 benchmark gets pulled toward those numbers more.
 * Delete the older BenchmarkUpload row via DELETE
 * /api/benchmarks/upload/{id} if you want a clean slate.
 */

import fs from "node:fs";
import { prisma } from "../lib/db";
import { processScanForBenchmark, rebuildBenchmark, type ScanRow } from "../lib/benchmarks";
import xlsx from "xlsx";

const SOURCE_PATH = "/Users/benzanikita/Downloads/kdall-stats-25mar1pm-to-26apr4pm.xlsx";

async function main() {
  if (!fs.existsSync(SOURCE_PATH)) {
    console.error(`File not found: ${SOURCE_PATH}`);
    process.exit(1);
  }
  const buffer = fs.readFileSync(SOURCE_PATH);
  const wb = xlsx.read(buffer);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json = xlsx.utils.sheet_to_json<Record<string, unknown>>(ws);

  // Map xlsx columns directly. Column names match what we saw earlier:
  //   Current Power, Start Power, T4 Kills, T5 Kills, Dead, KP (T4+T5),
  //   Acclaim, DKP
  const num = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number.parseFloat(v.replace(/[\s,]/g, ""));
      if (Number.isFinite(n)) return n;
    }
    return null;
  };

  const rows: ScanRow[] = json.map((r) => ({
    power: num(r["Current Power"]),
    startPower: num(r["Start Power"]),
    t4: num(r["T4 Kills"]),
    t5: num(r["T5 Kills"]),
    deaths: num(r["Dead"]),
    kp: num(r["KP (T4+T5)"]),
    acclaim: num(r["Acclaim"]),
    dkp: num(r["DKP"]),
  }));

  console.log(`Parsed ${rows.length} rows from ${SOURCE_PATH}`);

  const { stats, rowCount } = processScanForBenchmark(rows);
  console.log(`Active fighters: ${rowCount}`);
  console.log("Computed percentiles:");
  for (const [key, p] of Object.entries(stats)) {
    console.log(
      `  ${key.padEnd(8)} p50=${p.p50.toLocaleString().padStart(15)} ` +
        `p80=${p.p80.toLocaleString().padStart(15)} ` +
        `p95=${p.p95.toLocaleString().padStart(15)} ` +
        `p99=${p.p99.toLocaleString().padStart(15)}`,
    );
  }

  const upload = await prisma.benchmarkUpload.create({
    data: {
      kvkId: "kvk4",
      notes: "kingdom 3801 KvK4 export (Mar-Apr 2026) — bootstrap",
      rowCount,
      stats: stats as unknown as object,
    },
  });
  console.log(`\nSaved BenchmarkUpload id=${upload.id}`);

  await rebuildBenchmark("kvk4");
  const benchmark = await prisma.kvkBenchmark.findUnique({
    where: { kvkId: "kvk4" },
  });
  console.log(`\nRebuilt KvkBenchmark[kvk4]: sampleCount=${benchmark?.sampleCount}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
