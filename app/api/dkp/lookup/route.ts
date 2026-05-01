import { NextResponse } from "next/server";
import { withCors } from "@/lib/cors";
import { parseDkpXlsx } from "@/lib/xlsx-parser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

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
    if (!/\.(xlsx|xlsm|xls)$/i.test(fileField.name)) {
      return withCors(
        request,
        NextResponse.json(
          { error: "only .xlsx/.xlsm/.xls accepted" },
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

    return withCors(
      request,
      NextResponse.json({
        ok: true,
        row,
        columns: result.columns,
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
