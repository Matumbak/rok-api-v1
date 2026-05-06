import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { withCors } from "@/lib/cors";
import { parseDkpXlsx } from "@/lib/xlsx-parser";
import {
  processScanForBenchmark,
  rebuildBenchmark,
  type ScanRow,
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
const HEADER_ALIASES: Record<keyof ScanRow, string[]> = {
  power: ["Current Power", "Power", "Cur Power"],
  startPower: ["Start Power", "Starting Power"],
  t4: ["T4 Kills", "T4", "Tier 4 Kills"],
  t5: ["T5 Kills", "T5", "Tier 5 Kills"],
  deaths: ["Dead", "Deaths", "Death"],
  kp: ["KP (T4+T5)", "KP", "Kill Points", "Killpoints"],
  acclaim: ["Acclaim", "Valor", "Honor"],
  dkp: ["DKP", "DKPScore", "Score"],
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function pickNumber(
  data: Record<string, string | number | null>,
  candidates: string[],
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
      // Native fields aren't in r.data — they're at the top level. The
      // benchmark only needs numeric stats, all of which are non-native.
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
      };
    });

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
        notes,
        rowCount,
        stats: stats as unknown as object,
      },
    });

    await rebuildBenchmark(kvkId);

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
        sampleCount: b.sampleCount,
        updatedAt: b.updatedAt,
      })),
    }),
  );
}
