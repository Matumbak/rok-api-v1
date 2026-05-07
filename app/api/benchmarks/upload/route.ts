import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { withCors } from "@/lib/cors";
import { parseDkpXlsx } from "@/lib/xlsx-parser";
import {
  processScanForBenchmark,
  processScanForSocBenchmark,
  rebuildBenchmark,
  SEED_BUCKETS,
  type ScanRow,
  type SeedBucket,
} from "@/lib/benchmarks";
import { KVK_IDS, type KvkId } from "@/lib/scoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Vercel serverless body limit on Hobby/Pro is 4.5MB by default — we
// accept up to that. CSV is preferred for big rosters (raw text, no ZIP
// overhead → typically 4-5× smaller than the equivalent xlsx).
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ACCEPTED_EXT = /\.(xlsx|xlsm|xls|csv|tsv)$/i;

/** Header aliases we accept on the DKP-scan xlsx. Flexible because
 *  exports from different community tools name columns slightly
 *  differently (riseofstats / rokboard / private spreadsheets). */
const HEADER_ALIASES = {
  power: ["Current Power", "Power", "Cur Power"],
  startPower: ["Start Power", "Starting Power"],
  t4: ["T4 Kills", "T4", "Tier 4 Kills"],
  t5: ["T5 Kills", "T5", "Tier 5 Kills"],
  deaths: ["Dead", "Deaths", "Death"],
  kp: ["KP (T4+T5)", "KP", "Kill Points", "Killpoints"],
  acclaim: ["Acclaim", "Valor", "Honor"],
  dkp: ["DKP", "DKPScore", "Score"],
  kd: ["KD", "Kingdom", "Kingdom ID", "Home Kingdom", "Home"],
  governorId: ["Governor ID", "GovernorID", "ID", "Player ID", "Lord ID"],
} as const;

/** Freshness window for KingdomSeed-based seed assignment. Scans older
 *  than this can't trust today's heroscroll seed (kingdoms drift between
 *  groups over months) — fall through to auto-classification mode if
 *  scanDate is provided and beyond this window. */
const SEED_FRESHNESS_DAYS = 180;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function pickNumber(
  data: Record<string, string | number | null>,
  candidates: readonly string[],
): number | null {
  const wanted = new Set(candidates.map(norm));
  for (const [key, val] of Object.entries(data)) {
    if (wanted.has(norm(key))) {
      if (typeof val === "number" && Number.isFinite(val)) return val;
      if (typeof val === "string") {
        const n = Number.parseFloat(val.replace(/[\s,]/g, ""));
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return null;
}

/** Like pickNumber but for IDs that we want to keep as a string —
 *  governor IDs are display values, not arithmetic, so leave them as
 *  the source's string form (drops loss-of-precision risk on 9-digit
 *  numerics). */
function pickStringId(
  data: Record<string, string | number | null>,
  candidates: readonly string[],
): string | null {
  const wanted = new Set(candidates.map(norm));
  for (const [key, val] of Object.entries(data)) {
    if (wanted.has(norm(key))) {
      if (val == null) continue;
      const s = String(val).trim();
      if (s.length > 0 && /^\d+$/.test(s.replace(/\.0$/, ""))) {
        return s.replace(/\.0$/, "");
      }
    }
  }
  return null;
}

/**
 * POST /api/benchmarks/upload — multipart/form-data
 *   file: xlsx (same format as /api/dkp/upload)
 *   kvkId: "kvk1" | "kvk2" | "kvk3" | "kvk4" | "soc"
 *   notes: optional free-text label (e.g. "kingdom 3801 KvK4 Apr 2026")
 *
 * Parses the scan, reduces to per-stat percentile aggregates (no row
 * storage), saves a BenchmarkUpload, then rebuilds KvkBenchmark[kvkId]
 * by sample-weighted blending across all uploads for that kvkId.
 *
 * Idempotent — re-uploading the same scan file just appends another
 * BenchmarkUpload row. To remove a contribution use DELETE
 * /api/benchmarks/upload/{id}.
 */
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const fd = await request.formData();
    const fileField = fd.get("file");
    const kvkIdField = fd.get("kvkId");
    const notesField = fd.get("notes");
    /// "YYYY-MM-DD" — when this scan was originally captured. Only used
    /// for SoC scans: if the date is older than SEED_FRESHNESS_DAYS we
    /// switch from KingdomSeed-based bucketing to auto-classification
    /// (heroscroll seeds drift over months — old scans need stat-
    /// signature inference instead of today's seed lookup).
    const scanDateField = fd.get("scanDate");

    if (!fileField || !(fileField instanceof File)) {
      return withCors(
        request,
        NextResponse.json({ error: "no_file" }, { status: 400 }),
      );
    }
    if (typeof kvkIdField !== "string" || !KVK_IDS.includes(kvkIdField as KvkId)) {
      return withCors(
        request,
        NextResponse.json(
          {
            error: "invalid_kvkId",
            expected: KVK_IDS,
            received: kvkIdField,
          },
          { status: 400 },
        ),
      );
    }
    const kvkId = kvkIdField as KvkId;
    const notes = typeof notesField === "string" ? notesField.slice(0, 500) : null;

    if (!ACCEPTED_EXT.test(fileField.name)) {
      return withCors(
        request,
        NextResponse.json(
          {
            error: "unsupported_format",
            accepted: ".xlsx, .xlsm, .xls, .csv, .tsv",
          },
          { status: 400 },
        ),
      );
    }
    if (fileField.size > MAX_FILE_BYTES) {
      return withCors(
        request,
        NextResponse.json({ error: "file_too_large" }, { status: 400 }),
      );
    }

    const buffer = Buffer.from(await fileField.arrayBuffer());
    const parsed = parseDkpXlsx(buffer);
    if (!parsed.ok) {
      return withCors(
        request,
        NextResponse.json({ error: parsed.error }, { status: 400 }),
      );
    }

    // Reduce to ScanRow shape via header-alias matching.
    const scanRows: ScanRow[] = parsed.rows.map((r) => {
      const d = r.data;
      return {
        power: pickNumber(d, HEADER_ALIASES.power),
        startPower: pickNumber(d, HEADER_ALIASES.startPower),
        t4: pickNumber(d, HEADER_ALIASES.t4),
        t5: pickNumber(d, HEADER_ALIASES.t5),
        deaths: pickNumber(d, HEADER_ALIASES.deaths),
        kp: pickNumber(d, HEADER_ALIASES.kp),
        acclaim: pickNumber(d, HEADER_ALIASES.acclaim),
        dkp: pickNumber(d, HEADER_ALIASES.dkp),
        kd: pickNumber(d, HEADER_ALIASES.kd),
        governorId: pickStringId(d, HEADER_ALIASES.governorId),
      };
    });

    // Scan date check — drives SoC seed-assignment mode.
    let classifierMode: "kingdom_seed" | "auto_classify" = "kingdom_seed";
    if (
      kvkId === "soc" &&
      typeof scanDateField === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(scanDateField)
    ) {
      const ageMs = Date.now() - new Date(scanDateField).getTime();
      if (ageMs > SEED_FRESHNESS_DAYS * 86400 * 1000) {
        classifierMode = "auto_classify";
      }
    }

    if (kvkId === "soc") {
      // Per-seed bucketing: split rows by home-kingdom seed, write
      // multiple BenchmarkUpload rows (one per seed share that meets
      // the minimum-rows threshold).
      const shares = await processScanForSocBenchmark(scanRows, classifierMode);
      if (shares.length === 0) {
        return withCors(
          request,
          NextResponse.json(
            {
              error: "no_seed_buckets",
              hint:
                "After partitioning rows by home-kingdom seed, no bucket " +
                "had >= 20 active fighters. Either the scan has no KD " +
                "column, or kingdoms aren't yet imported into KingdomSeed.",
            },
            { status: 400 },
          ),
        );
      }
      const created: Array<{
        seed: SeedBucket;
        seedSource: string;
        rowCount: number;
        uploadId: string;
      }> = [];
      for (const sh of shares) {
        const upload = await prisma.benchmarkUpload.create({
          data: {
            kvkId,
            seed: sh.seed,
            seedSource: sh.seedSource,
            notes,
            rowCount: sh.rowCount,
            stats: sh.stats as unknown as object,
          },
        });
        // Persist raw rows alongside the aggregate. Lets a future
        // re-bucketing (e.g. tweaked tier cutoffs, different seed
        // partition logic) work off the original data without asking
        // the user to re-upload the scan. createMany is bulk so a
        // 300-row upload is one round-trip.
        if (sh.rows.length > 0) {
          await prisma.benchmarkUploadRow.createMany({
            data: sh.rows.map((r) => ({
              uploadId: upload.id,
              kd: r.kd,
              governorId: r.governorId ?? null,
              power: r.power != null ? BigInt(Math.round(r.power)) : null,
              startPower:
                r.startPower != null
                  ? BigInt(Math.round(r.startPower))
                  : null,
              kp: r.kp != null ? BigInt(Math.round(r.kp)) : null,
              t4: r.t4 != null ? BigInt(Math.round(r.t4)) : null,
              t5: r.t5 != null ? BigInt(Math.round(r.t5)) : null,
              deaths:
                r.deaths != null ? BigInt(Math.round(r.deaths)) : null,
              acclaim:
                r.acclaim != null ? BigInt(Math.round(r.acclaim)) : null,
              dkp: r.dkp != null ? BigInt(Math.round(r.dkp)) : null,
            })),
          });
        }
        created.push({
          seed: sh.seed,
          seedSource: sh.seedSource,
          rowCount: sh.rowCount,
          uploadId: upload.id,
        });
      }
      // Rebuild every seed bucket that received data.
      for (const sh of shares) {
        await rebuildBenchmark(kvkId, sh.seed);
      }
      return withCors(
        request,
        NextResponse.json({
          ok: true,
          kvkId,
          mode: classifierMode,
          shares: created,
          totalRowsIngested: created.reduce((s, c) => s + c.rowCount, 0),
        }),
      );
    }

    // LK path — single bucket.
    const { stats, rowCount } = processScanForBenchmark(scanRows);
    if (rowCount === 0) {
      return withCors(
        request,
        NextResponse.json(
          {
            error: "no_active_fighters",
            hint:
              "After filtering by dkp>0 OR t5>100K, no rows remained. " +
              "Check column mapping or the source kingdom's KvK activity.",
          },
          { status: 400 },
        ),
      );
    }
    const upload = await prisma.benchmarkUpload.create({
      data: {
        kvkId,
        seed: "general",
        seedSource: "general",
        notes,
        rowCount,
        stats: stats as unknown as object,
      },
    });
    // Persist raw rows for LK uploads too. Same audit / future-proofing
    // motivation as the SoC path — if we change kvk1-4 logic later we
    // can rebuild without asking for re-upload. Only persist active
    // fighters (the same filter rowsToStats applies internally).
    const activeRows = scanRows.filter((r) => {
      const dkp = r.dkp ?? 0;
      const t5 = r.t5 ?? 0;
      return dkp > 0 || t5 > 100_000;
    });
    if (activeRows.length > 0) {
      await prisma.benchmarkUploadRow.createMany({
        data: activeRows.map((r) => ({
          uploadId: upload.id,
          kd: r.kd,
          governorId: r.governorId ?? null,
          power: r.power != null ? BigInt(Math.round(r.power)) : null,
          startPower:
            r.startPower != null ? BigInt(Math.round(r.startPower)) : null,
          kp: r.kp != null ? BigInt(Math.round(r.kp)) : null,
          t4: r.t4 != null ? BigInt(Math.round(r.t4)) : null,
          t5: r.t5 != null ? BigInt(Math.round(r.t5)) : null,
          deaths: r.deaths != null ? BigInt(Math.round(r.deaths)) : null,
          acclaim:
            r.acclaim != null ? BigInt(Math.round(r.acclaim)) : null,
          dkp: r.dkp != null ? BigInt(Math.round(r.dkp)) : null,
        })),
      });
    }
    await rebuildBenchmark(kvkId, "general");
    return withCors(
      request,
      NextResponse.json({
        ok: true,
        uploadId: upload.id,
        kvkId,
        rowCount,
        stats,
      }),
    );
  } catch (err) {
    return withCors(
      request,
      NextResponse.json(
        { error: (err as Error).message ?? "internal_error" },
        { status: 500 },
      ),
    );
  }
}

/**
 * GET /api/benchmarks/upload — list uploads (admin overview).
 */
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const uploads = await prisma.benchmarkUpload.findMany({
    orderBy: { uploadedAt: "desc" },
    select: {
      id: true,
      kvkId: true,
      seed: true,
      seedSource: true,
      notes: true,
      rowCount: true,
      uploadedAt: true,
    },
  });
  const benchmarks = await prisma.kvkBenchmark.findMany();

  return withCors(
    request,
    NextResponse.json({
      uploads,
      benchmarks: benchmarks.map((b) => ({
        kvkId: b.kvkId,
        seed: b.seed,
        sampleCount: b.sampleCount,
        updatedAt: b.updatedAt,
      })),
    }),
  );
}
