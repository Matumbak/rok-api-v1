import { NextResponse } from "next/server";
import { withCors } from "@/lib/cors";
import { parseDkpXlsx } from "@/lib/xlsx-parser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_FILE_BYTES = 4 * 1024 * 1024; // Vercel body limit
const ACCEPTED_EXT = /\.(xlsx|xlsm|xls|csv|tsv)$/i;

/** Norm + alias matching for the t5 / dkp columns we use to filter
 *  active fighters. */
const ACTIVITY_COL_ALIASES = {
  t5: ["T5 Kills", "T5", "Tier 5 Kills"],
  dkp: ["DKP", "DKPScore", "Score"],
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function pickColumnLabel(
  columns: { label: string }[],
  candidates: string[],
): string | null {
  const wanted = new Set(candidates.map(norm));
  for (const c of columns) {
    if (wanted.has(norm(c.label))) return c.label;
  }
  return null;
}

function parseNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.replace(/[\s,]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * POST /api/dkp/lookup — multipart/form-data, fields:
 *   file:        the DKP scan xlsx the applicant exports from RoK kit
 *   governorId:  the applicant's gov ID to find in the scan
 *
 * Public endpoint — used by the migration form so applicants can
 * pre-fill DKP-related stats from their KvK export instead of
 * typing them by hand. We don't persist anything: parse, find the
 * row, return it, drop the buffer.
 *
 * Response shape:
 *   200 { ok: true,  row, columns }     — match found, returns the
 *                                          full row (rank/nickname/
 *                                          alliance/data) plus the
 *                                          column metadata so the
 *                                          client can label values
 *                                          without re-parsing
 *   200 { ok: false, error: "not_in_scan", scanRows } — file parsed
 *                                          fine but no row matches
 *                                          the requested governorId.
 *                                          scanRows is the row count
 *                                          for the operator hint
 *                                          ("looked through 1 240
 *                                          governors, none with that
 *                                          ID").
 *   400                                 — invalid file / missing
 *                                          required fields / parse
 *                                          failure.
 */
export async function POST(request: Request) {
  try {
    const fd = await request.formData();
    const fileField = fd.get("file");
    const governorId = (fd.get("governorId") ?? "").toString().trim();

    if (!fileField || !(fileField instanceof File)) {
      return withCors(
        request,
        NextResponse.json({ error: "no_file" }, { status: 400 }),
      );
    }
    if (!governorId) {
      return withCors(
        request,
        NextResponse.json({ error: "no_governor_id" }, { status: 400 }),
      );
    }
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
    const result = parseDkpXlsx(buffer);
    if (!result.ok) {
      return withCors(
        request,
        NextResponse.json({ error: result.error }, { status: 400 }),
      );
    }

    const target = governorId.replace(/\D/g, "");
    const row = result.rows.find(
      (r) => r.governorId.replace(/\D/g, "") === target,
    );

    if (!row) {
      return withCors(
        request,
        NextResponse.json({
          ok: false,
          error: "not_in_scan",
          scanRows: result.rows.length,
        }),
      );
    }

    // Compute active-fighter count (same filter as benchmark ingestion:
    // dkp > 0 OR t5 > 100K) and the applicant's rank AMONG ACTIVE,
    // sorted by DKP desc. This becomes the position signal in scoring:
    // "ranked Nth out of M active fighters in their kingdom's KvK".
    const t5Col = pickColumnLabel(result.columns, ACTIVITY_COL_ALIASES.t5);
    const dkpCol = pickColumnLabel(result.columns, ACTIVITY_COL_ALIASES.dkp);
    const isActive = (
      r: (typeof result.rows)[number],
    ): boolean => {
      const dkp = dkpCol ? parseNumber(r.data[dkpCol]) : 0;
      const t5 = t5Col ? parseNumber(r.data[t5Col]) : 0;
      return dkp > 0 || t5 > 100_000;
    };
    const activeRows = result.rows.filter(isActive);
    const activeCount = activeRows.length;
    let rankAmongActive: number | null = null;
    if (isActive(row) && dkpCol) {
      const sorted = [...activeRows].sort(
        (a, b) => parseNumber(b.data[dkpCol]) - parseNumber(a.data[dkpCol]),
      );
      const idx = sorted.findIndex(
        (r) => r.governorId === row.governorId,
      );
      if (idx >= 0) rankAmongActive = idx + 1;
    }

    return withCors(
      request,
      NextResponse.json({
        ok: true,
        row,
        columns: result.columns,
        activeCount,
        rankAmongActive,
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
