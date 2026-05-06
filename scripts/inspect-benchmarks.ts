import { prisma } from "../lib/db";

async function main() {
  const benchmarks = await prisma.kvkBenchmark.findMany({
    orderBy: [{ kvkId: "asc" }, { seed: "asc" }],
    select: { kvkId: true, seed: true, sampleCount: true, updatedAt: true },
  });
  console.log("\n=== KvkBenchmark ===");
  console.table(benchmarks);

  const uploads = await prisma.$queryRawUnsafe<
    Array<{ kvkId: string; seed: string; n: number; last: Date }>
  >(`
    SELECT "kvkId", seed, COUNT(*)::int as n, MAX("uploadedAt") as last, SUM("rowCount")::int as rows
    FROM "benchmark_uploads"
    GROUP BY "kvkId", seed
    ORDER BY "kvkId", seed
  `);
  console.log("\n=== BenchmarkUpload by (kvkId, seed) ===");
  console.table(uploads);

  // Per-seed row counts inside the SoC uploads (rows fed into seed buckets)
  const socRows = await prisma.$queryRawUnsafe<Array<{ seed: string; n: number }>>(`
    SELECT seed, COUNT(*)::int as n, SUM("rowCount")::int as rows
    FROM "benchmark_uploads"
    WHERE "kvkId" = 'soc'
    GROUP BY seed
    ORDER BY seed
  `);
  console.log("\n=== SoC uploads by seed (file-level) ===");
  console.table(socRows);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
