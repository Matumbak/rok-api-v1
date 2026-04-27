import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { withCors } from "@/lib/cors";
import { parseDkpXlsx } from "@/lib/xlsx-parser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel hobby plan: 10s default. Scan replace + insert is well under that
// for our typical row counts (~300-2000), but bump explicitly anyway.
export const maxDuration = 30;

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * POST /api/dkp/upload — multipart/form-data, field "file".
 * Atomically replaces the entire scan + rows.
 */
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const fd = await request.formData();
    const fileField = fd.get("file");
    if (!fileField || !(fileField instanceof File)) {
      return withCors(
        request,
        NextResponse.json({ error: "no_file" }, { status: 400 }),
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
    if (result.rows.length === 0) {
      return withCors(
        request,
        NextResponse.json({ error: "no_rows" }, { status: 400 }),
      );
    }

    const filename = fileField.name;

    await prisma.$transaction(async (tx) => {
      await tx.dkpScan.deleteMany({});
      const scan = await tx.dkpScan.create({
        data: {
          filename,
          columns: result.columns as unknown as Prisma.InputJsonValue,
          rowCount: result.rows.length,
        },
      });
      const CHUNK = 200;
      for (let i = 0; i < result.rows.length; i += CHUNK) {
        const slice = result.rows.slice(i, i + CHUNK);
        await tx.dkpRow.createMany({
          data: slice.map((r) => ({
            scanId: scan.id,
            rank: r.rank,
            governorId: r.governorId,
            nickname: r.nickname,
            alliance: r.alliance,
            data: r.data as unknown as Prisma.InputJsonValue,
          })),
        });
      }
    });

    return withCors(
      request,
      NextResponse.json({
        replaced: result.rows.length,
        columns: result.columns.map((c) => c.label),
        filename,
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
