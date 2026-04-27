import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { withCors } from "@/lib/cors";
import type { DkpColumn } from "@/lib/xlsx-parser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NATIVE_KEYS = new Set(["rank", "nickname", "alliance", "governorId"]);

const querySchema = z.object({
  search: z.string().trim().max(80).optional(),
  alliance: z.string().trim().max(40).optional(),
  sortBy: z.string().trim().max(80).optional(),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
});

async function loadCurrentScan() {
  const scan = await prisma.dkpScan.findFirst({
    orderBy: { uploadedAt: "desc" },
  });
  if (!scan) return null;
  const columns = (scan.columns as unknown as DkpColumn[]) ?? [];
  return { scan, columns };
}

type RawDkpRow = {
  id: string;
  rank: number;
  governorId: string;
  nickname: string;
  alliance: string;
  data: Record<string, unknown>;
};

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const params = Object.fromEntries(url.searchParams.entries());
    const q = querySchema.parse(params);

    const current = await loadCurrentScan();
    if (!current) {
      return withCors(
        request,
        NextResponse.json({
          columns: [],
          items: [],
          page: q.page,
          pageSize: q.pageSize,
          total: 0,
          totalPages: 1,
          filters: { alliances: [] },
          scan: null,
        }),
      );
    }

    const { scan, columns } = current;
    const sortByCol = columns.find((c) => c.key === q.sortBy);
    const sortBy = sortByCol?.sortable ? sortByCol.key : "rank";
    const sortOrder = q.sortOrder;

    const where: Prisma.DkpRowWhereInput = { scanId: scan.id };
    if (q.search) {
      where.OR = [
        { nickname: { contains: q.search, mode: "insensitive" } },
        { governorId: { contains: q.search, mode: "insensitive" } },
      ];
    }
    if (q.alliance) where.alliance = q.alliance;

    const [total, alliances] = await Promise.all([
      prisma.dkpRow.count({ where }),
      prisma.dkpRow.findMany({
        where: { scanId: scan.id },
        select: { alliance: true },
        distinct: ["alliance"],
        orderBy: { alliance: "asc" },
      }),
    ]);

    let rawRows: RawDkpRow[];

    if (NATIVE_KEYS.has(sortBy)) {
      const found = await prisma.dkpRow.findMany({
        where,
        orderBy: { [sortBy]: sortOrder } as Prisma.DkpRowOrderByWithRelationInput,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      });
      rawRows = found.map((r) => ({
        id: r.id,
        rank: r.rank,
        governorId: r.governorId,
        nickname: r.nickname,
        alliance: r.alliance,
        data: (r.data as Record<string, unknown>) ?? {},
      }));
    } else {
      const isNumeric =
        sortByCol?.type === "number" || sortByCol?.type === "percent";
      const dir = sortOrder === "desc" ? "DESC" : "ASC";
      const orderExpr = isNumeric
        ? `(("data"->>$5)::numeric)`
        : `("data"->>$5)`;
      const offset = (q.page - 1) * q.pageSize;
      const sql = `
        SELECT id, rank, "governorId" as "governorId", nickname, alliance, data
        FROM dkp_rows
        WHERE "scanId" = $1
          AND ($2::text = '' OR nickname ILIKE '%' || $2 || '%' OR "governorId" ILIKE '%' || $2 || '%')
          AND ($3::text = '' OR alliance = $3)
        ORDER BY ${orderExpr} ${dir} NULLS LAST, rank ASC
        LIMIT $4 OFFSET $6
      `;
      const found = await prisma.$queryRawUnsafe<RawDkpRow[]>(
        sql,
        scan.id,
        q.search ?? "",
        q.alliance ?? "",
        q.pageSize,
        sortBy,
        offset,
      );
      rawRows = found.map((r) => ({
        ...r,
        data: (r.data as Record<string, unknown>) ?? {},
      }));
    }

    const items = rawRows.map((r) => ({
      id: r.id,
      rank: r.rank,
      governorId: r.governorId,
      nickname: r.nickname,
      alliance: r.alliance,
      ...r.data,
    }));

    return withCors(
      request,
      NextResponse.json({
        columns,
        items,
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
        filters: {
          alliances: alliances.map((a) => a.alliance).filter(Boolean),
        },
        scan: {
          id: scan.id,
          filename: scan.filename,
          uploadedAt: scan.uploadedAt,
          rowCount: scan.rowCount,
        },
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

// ADMIN: wipe all DKP data
export async function DELETE(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const r = await prisma.dkpScan.deleteMany({});
    return withCors(request, NextResponse.json({ deleted: r.count }));
  } catch (err) {
    return withCors(
      request,
      NextResponse.json({ error: (err as Error).message }, { status: 500 }),
    );
  }
}
