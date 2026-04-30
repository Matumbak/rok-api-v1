import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { withCors } from "@/lib/cors";
import { STATUSES } from "@/lib/migration-application";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sortable columns. Numeric fields use the normalized `*N` Float column —
 * the API accepts the friendlier alias (e.g. `power`) and rewrites it to
 * `powerN` internally.
 */
const SORT_ALIAS: Record<string, string> = {
  power: "powerN",
  killPoints: "killPointsN",
  t1Kills: "t1KillsN",
  t2Kills: "t2KillsN",
  t3Kills: "t3KillsN",
  t4Kills: "t4KillsN",
  t5Kills: "t5KillsN",
  deaths: "deathsN",
  healed: "healedN",
  resourcesGathered: "resourcesGatheredN",
  food: "foodN",
  wood: "woodN",
  stone: "stoneN",
  gold: "goldN",
  previousKvkDkp: "previousKvkDkpN",
};

const SORTABLE_COLUMNS = new Set([
  "createdAt",
  "updatedAt",
  "reviewedAt",
  "nickname",
  "governorId",
  "currentKingdom",
  "status",
  "speedupsMinutes",
  "speedupsUniversalMinutes",
  "speedupsConstructionMinutes",
  "speedupsResearchMinutes",
  "speedupsTrainingMinutes",
  "speedupsHealingMinutes",
  ...Object.values(SORT_ALIAS),
  ...Object.keys(SORT_ALIAS),
]);

/**
 * GET /api/migration-applications/admin
 *
 * Query:
 *   status      one of pending|approved|rejected|archived (multiple via comma)
 *   q           free-text contains-match across nickname / governorId / discord
 *   kingdom     exact match against currentKingdom
 *   sortBy      column name (whitelist above), default createdAt
 *   sortDir     asc | desc, default desc
 *   page        1-based, default 1
 *   pageSize    default 25, max 100
 */
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const url = new URL(request.url);
    const sp = url.searchParams;

    const statusParam = sp.get("status");
    const statusList = statusParam
      ? statusParam
          .split(",")
          .map((s) => s.trim())
          .filter((s): s is (typeof STATUSES)[number] =>
            (STATUSES as readonly string[]).includes(s),
          )
      : null;

    const q = sp.get("q")?.trim() || null;
    const kingdom = sp.get("kingdom")?.trim() || null;

    const sortByRaw = sp.get("sortBy") ?? "createdAt";
    const sortByValid = SORTABLE_COLUMNS.has(sortByRaw)
      ? sortByRaw
      : "createdAt";
    // Normalize friendly aliases ("power" → "powerN") so Prisma sorts by
    // the numeric column.
    const sortBy = SORT_ALIAS[sortByValid] ?? sortByValid;
    const sortDir = sp.get("sortDir") === "asc" ? "asc" : "desc";

    const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number.parseInt(sp.get("pageSize") ?? "25", 10) || 25),
    );

    const where: Prisma.MigrationApplicationWhereInput = {};
    if (statusList && statusList.length > 0) where.status = { in: statusList };
    if (kingdom) where.currentKingdom = kingdom;
    if (q) {
      where.OR = [
        { nickname: { contains: q, mode: "insensitive" } },
        { governorId: { contains: q, mode: "insensitive" } },
        { discordHandle: { contains: q, mode: "insensitive" } },
      ];
    }

    // Range filters: ?powerMin=80000000&killPointsMin=100000000 etc.
    // Each alias key (power, killPoints, ...) maps to its `*N` Float column.
    for (const [alias, col] of Object.entries(SORT_ALIAS)) {
      const min = sp.get(`${alias}Min`);
      const max = sp.get(`${alias}Max`);
      if (min == null && max == null) continue;
      const range: Prisma.FloatNullableFilter = {};
      if (min != null) {
        const n = Number.parseFloat(min);
        if (Number.isFinite(n)) range.gte = n;
      }
      if (max != null) {
        const n = Number.parseFloat(max);
        if (Number.isFinite(n)) range.lte = n;
      }
      if (range.gte != null || range.lte != null) {
        (where as Record<string, unknown>)[col] = range;
      }
    }
    if (sp.get("hasScrolls") === "true") where.hasScrolls = true;

    const [total, items, statusCounts] = await Promise.all([
      prisma.migrationApplication.count({ where }),
      prisma.migrationApplication.findMany({
        where,
        orderBy: { [sortBy]: sortDir },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          governorId: true,
          nickname: true,
          currentKingdom: true,
          currentAlliance: true,
          power: true,
          killPoints: true,
          vipLevel: true,
          discordHandle: true,
          t4Kills: true,
          t5Kills: true,
          deaths: true,
          hasScrolls: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          reviewedAt: true,
          screenshots: true,
          powerN: true,
          killPointsN: true,
          t4KillsN: true,
          t5KillsN: true,
          deathsN: true,
          healedN: true,
          foodN: true,
          woodN: true,
          stoneN: true,
          goldN: true,
          previousKvkDkpN: true,
          speedupsMinutes: true,
        },
      }),
      prisma.migrationApplication.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
    ]);

    const counts = Object.fromEntries(
      statusCounts.map((c) => [c.status, c._count._all]),
    );

    return withCors(
      request,
      NextResponse.json({
        items,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        counts,
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
