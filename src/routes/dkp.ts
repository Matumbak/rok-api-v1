import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireAdmin } from "../middleware/auth.js";
import {
  parseDkpXlsx,
  type DkpColumn,
} from "../services/xlsx-parser.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xlsm|xls)$/i.test(file.originalname);
    if (!ok) return cb(new Error("only .xlsx/.xlsm/.xls accepted"));
    cb(null, true);
  },
});

const NATIVE_KEYS = new Set(["rank", "nickname", "alliance", "governorId"]);

const querySchema = z.object({
  search: z.string().trim().max(80).optional(),
  alliance: z.string().trim().max(40).optional(),
  sortBy: z.string().trim().max(80).optional(),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
});

/**
 * Loads the most recent scan + parses its `columns` JSON.
 * Returns null if no scan has been uploaded yet.
 */
async function loadCurrentScan() {
  const scan = await prisma.dkpScan.findFirst({
    orderBy: { uploadedAt: "desc" },
  });
  if (!scan) return null;
  let columns: DkpColumn[] = [];
  try {
    columns = JSON.parse(scan.columns);
  } catch {
    columns = [];
  }
  return { scan, columns };
}

router.get("/", async (req, res, next) => {
  try {
    const q = querySchema.parse(req.query);
    const current = await loadCurrentScan();

    if (!current) {
      return res.json({
        columns: [],
        items: [],
        page: q.page,
        pageSize: q.pageSize,
        total: 0,
        totalPages: 1,
        filters: { alliances: [] },
        scan: null,
      });
    }

    const { scan, columns } = current;
    const sortByCol = columns.find((c) => c.key === q.sortBy);
    const sortBy = sortByCol?.sortable ? sortByCol.key : "rank";
    const sortOrder = q.sortOrder;

    const where: Prisma.DkpRowWhereInput = { scanId: scan.id };
    if (q.search) {
      where.OR = [
        { nickname: { contains: q.search } },
        { governorId: { contains: q.search } },
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

    let rawRows: { id: string; rank: number; governorId: string; nickname: string; alliance: string; data: string }[];

    if (NATIVE_KEYS.has(sortBy)) {
      rawRows = await prisma.dkpRow.findMany({
        where,
        orderBy: { [sortBy]: sortOrder } as Prisma.DkpRowOrderByWithRelationInput,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      });
    } else {
      // JSON sort via raw SQL — sortBy is whitelisted by sortByCol check above.
      // Cast to REAL for numeric columns; otherwise sort lexicographically.
      const isNumeric =
        sortByCol?.type === "number" || sortByCol?.type === "percent";
      const orderExpr = isNumeric
        ? `CAST(json_extract(data, '$."${sortBy.replace(/"/g, '""')}"') AS REAL)`
        : `json_extract(data, '$."${sortBy.replace(/"/g, '""')}"')`;
      const dir = sortOrder === "desc" ? "DESC" : "ASC";
      const offset = (q.page - 1) * q.pageSize;

      rawRows = await prisma.$queryRawUnsafe<typeof rawRows>(
        `SELECT id, rank, governorId, nickname, alliance, data
         FROM dkp_rows
         WHERE scanId = ?
           AND (? = '' OR nickname LIKE '%' || ? || '%' OR governorId LIKE '%' || ? || '%')
           AND (? = '' OR alliance = ?)
         ORDER BY ${orderExpr} ${dir} NULLS LAST
         LIMIT ? OFFSET ?`,
        scan.id,
        q.search ?? "",
        q.search ?? "",
        q.search ?? "",
        q.alliance ?? "",
        q.alliance ?? "",
        q.pageSize,
        offset,
      );
    }

    // flatten: hoist data fields onto the row object alongside native fields
    const items = rawRows.map((r) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(r.data);
      } catch {
        parsed = {};
      }
      return {
        id: r.id,
        rank: r.rank,
        governorId: r.governorId,
        nickname: r.nickname,
        alliance: r.alliance,
        ...parsed,
      };
    });

    res.json({
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
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/dkp/upload — multipart/form-data with `file` field.
 * Atomically replaces the entire scan + rows.
 */
router.post(
  "/upload",
  requireAdmin,
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "no_file" });

      const result = parseDkpXlsx(req.file.buffer);
      if (!result.ok) return res.status(400).json({ error: result.error });
      if (result.rows.length === 0)
        return res.status(400).json({ error: "no_rows" });

      const columnsJson = JSON.stringify(result.columns);
      const filename = req.file.originalname;

      // wipe existing scans (cascade → rows), then create new
      await prisma.$transaction(async (tx) => {
        await tx.dkpScan.deleteMany({});
        const scan = await tx.dkpScan.create({
          data: {
            filename,
            columns: columnsJson,
            rowCount: result.rows.length,
          },
        });
        // chunk createMany to avoid SQLite parameter limit
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
              data: JSON.stringify(r.data),
            })),
          });
        }
      });

      res.json({
        replaced: result.rows.length,
        columns: result.columns.map((c) => c.label),
        filename,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.delete("/", requireAdmin, async (_req, res, next) => {
  try {
    const r = await prisma.dkpScan.deleteMany({});
    res.json({ deleted: r.count });
  } catch (err) {
    next(err);
  }
});

export default router;
