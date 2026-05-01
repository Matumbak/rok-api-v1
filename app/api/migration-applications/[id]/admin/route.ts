import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { withCors } from "@/lib/cors";
import { deleteBlobs } from "@/lib/blob";
import {
  BLOB_RETENTION_DAYS,
  NORMALIZED_FIELD_MAP,
  SPEEDUP_FIELD_MAP,
  STATUSES,
  screenshotSchema,
} from "@/lib/migration-application";
import { parseRokNumber } from "@/lib/parse-rok-number";
import { parseRokDuration } from "@/lib/parse-rok-duration";
import {
  computeScore,
  percentileTag,
  SPENDING_TIERS,
  type SpendingTier,
} from "@/lib/scoring";
import { getPercentilesForApp } from "@/lib/percentiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    adminNotes: z.string().max(4000).optional().nullable(),

    governorId: z.string().min(1).max(20).optional(),
    nickname: z.string().min(1).max(60).optional(),
    currentKingdom: z.string().min(1).max(20).optional(),
    currentAlliance: z.string().max(40).optional().nullable(),
    civilization: z.string().max(40).optional().nullable(),
    power: z.string().max(40).optional(),
    killPoints: z.string().max(40).optional(),
    vipLevel: z.string().max(10).optional(),
    discordHandle: z.string().min(1).max(60).optional(),
    constructionPower: z.string().max(40).optional().nullable(),
    technologyPower: z.string().max(40).optional().nullable(),
    troopPower: z.string().max(40).optional().nullable(),
    commanderPower: z.string().max(40).optional().nullable(),
    maxPower: z.string().max(40).optional().nullable(),
    wins: z.string().max(40).optional().nullable(),
    losses: z.string().max(40).optional().nullable(),
    arkOsirisWins: z.string().max(40).optional().nullable(),
    valorPoints: z.string().max(40).optional().nullable(),
    maxValorPoints: z.string().max(40).optional().nullable(),
    t1Kills: z.string().max(40).optional().nullable(),
    t2Kills: z.string().max(40).optional().nullable(),
    t3Kills: z.string().max(40).optional().nullable(),
    t4Kills: z.string().max(40).optional().nullable(),
    t5Kills: z.string().max(40).optional().nullable(),
    deaths: z.string().max(40).optional().nullable(),
    healed: z.string().max(40).optional().nullable(),
    resourcesGathered: z.string().max(40).optional().nullable(),
    food: z.string().max(40).optional().nullable(),
    wood: z.string().max(40).optional().nullable(),
    stone: z.string().max(40).optional().nullable(),
    gold: z.string().max(40).optional().nullable(),
    speedupsUniversal: z.string().max(40).optional().nullable(),
    speedupsConstruction: z.string().max(40).optional().nullable(),
    speedupsResearch: z.string().max(40).optional().nullable(),
    speedupsTraining: z.string().max(40).optional().nullable(),
    speedupsHealing: z.string().max(40).optional().nullable(),
    speedupsMinutes: z.number().int().nonnegative().optional().nullable(),
    speedupsBreakdown: z.record(z.string(), z.string()).optional().nullable(),
    accountBornAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
      .optional()
      .nullable(),
    scoutVerified: z.boolean().optional(),
    spendingTier: z
      .enum(SPENDING_TIERS as unknown as [string, ...string[]])
      .optional(),
    manualTags: z.array(z.string().min(1).max(40)).max(20).optional().nullable(),
    marches: z.number().int().min(0).max(20).optional().nullable(),
    equipmentSummary: z.record(z.string(), z.string()).optional().nullable(),
    previousKvkDkp: z.string().max(40).optional().nullable(),
    activityHours: z.string().max(80).optional().nullable(),
    timezone: z.string().max(40).optional().nullable(),
    hasScrolls: z.boolean().optional(),
    reason: z.string().max(2000).optional().nullable(),
    ocrRawText: z.string().max(50_000).optional().nullable(),
    screenshots: z.array(screenshotSchema).max(50).optional(),
  })
  .strict();

interface ScreenshotRecord {
  url: string;
  pathname?: string;
  category?: string;
  label?: string;
  size?: number;
  contentType?: string;
}

function getScreenshotUrls(json: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(json)) return [];
  return (json as unknown as ScreenshotRecord[])
    .map((s) => s?.url)
    .filter((u): u is string => typeof u === "string" && u.length > 0);
}

/** GET /api/migration-applications/[id]/admin — full record. */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    const item = await prisma.migrationApplication.findUnique({
      where: { id },
    });
    if (!item) {
      return withCors(
        request,
        NextResponse.json({ error: "not_found" }, { status: 404 }),
      );
    }
    const percentiles = await getPercentilesForApp(id);
    return withCors(
      request,
      NextResponse.json({ ...item, percentiles }),
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
 * PATCH /api/migration-applications/[id]/admin
 * Updates any subset of fields. When `status` transitions away from `pending`,
 * we set `reviewedAt` and schedule blob cleanup based on
 * BLOB_RETENTION_DAYS.
 *
 * If status moves to `archived` (retention = 0), we delete the blobs inline
 * — no point waiting for the cron.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await ctx.params;

  try {
    const body = await request.json();
    const patch = patchSchema.parse(body);

    const existing = await prisma.migrationApplication.findUnique({
      where: { id },
      select: { status: true, screenshots: true },
    });
    if (!existing) {
      return withCors(
        request,
        NextResponse.json({ error: "not_found" }, { status: 404 }),
      );
    }

    const data: Prisma.MigrationApplicationUpdateInput = {};

    // Direct fields — only set when present.
    for (const k of [
      "governorId",
      "nickname",
      "currentKingdom",
      "currentAlliance",
      "civilization",
      "power",
      "killPoints",
      "vipLevel",
      "discordHandle",
      "constructionPower",
      "technologyPower",
      "troopPower",
      "commanderPower",
      "maxPower",
      "wins",
      "losses",
      "arkOsirisWins",
      "valorPoints",
      "maxValorPoints",
      "t1Kills",
      "t2Kills",
      "t3Kills",
      "t4Kills",
      "t5Kills",
      "deaths",
      "healed",
      "resourcesGathered",
      "food",
      "wood",
      "stone",
      "gold",
      "previousKvkDkp",
      "activityHours",
      "timezone",
      "reason",
      "adminNotes",
    ] as const) {
      if (k in patch) {
        (data as Record<string, unknown>)[k] = patch[k] ?? null;
      }
    }
    if ("hasScrolls" in patch) data.hasScrolls = patch.hasScrolls;
    if ("speedupsMinutes" in patch) data.speedupsMinutes = patch.speedupsMinutes ?? null;
    if ("marches" in patch) data.marches = patch.marches ?? null;
    if ("ocrRawText" in patch) data.ocrRawText = patch.ocrRawText ?? null;
    if ("accountBornAt" in patch) {
      data.accountBornAt = patch.accountBornAt
        ? new Date(`${patch.accountBornAt}T00:00:00.000Z`)
        : null;
    }
    if ("scoutVerified" in patch) data.scoutVerified = patch.scoutVerified ?? false;
    if ("spendingTier" in patch) data.spendingTier = patch.spendingTier;
    if ("manualTags" in patch) {
      data.manualTags = (patch.manualTags ??
        Prisma.JsonNull) as Prisma.InputJsonValue;
    }

    // Recompute normalized columns whenever the source string is touched.
    for (const [raw, normCol] of Object.entries(NORMALIZED_FIELD_MAP)) {
      if (raw in patch) {
        const value = (patch as unknown as Record<string, string | null>)[raw];
        (data as Record<string, unknown>)[normCol] = parseRokNumber(value);
      }
    }

    // Recompute speedup minutes per category when raw duration string
    // arrives. We only re-derive the grand total if at least one category
    // was touched in this patch — otherwise the admin's manual override
    // of `speedupsMinutes` (above) wins.
    let touchedSpeedups = false;
    for (const [raw, col] of Object.entries(SPEEDUP_FIELD_MAP)) {
      if (raw in patch) {
        const value = (patch as unknown as Record<string, string | null>)[raw];
        (data as Record<string, unknown>)[col] = parseRokDuration(value);
        touchedSpeedups = true;
      }
    }
    if (touchedSpeedups && !("speedupsMinutes" in patch)) {
      // Sum the five typed columns to refresh the grand total. We need
      // the existing values for columns the patch didn't touch.
      const current = await prisma.migrationApplication.findUnique({
        where: { id },
        select: {
          speedupsUniversalMinutes: true,
          speedupsConstructionMinutes: true,
          speedupsResearchMinutes: true,
          speedupsTrainingMinutes: true,
          speedupsHealingMinutes: true,
        },
      });
      const merged = {
        speedupsUniversalMinutes:
          (data as Record<string, unknown>).speedupsUniversalMinutes ??
          current?.speedupsUniversalMinutes ??
          null,
        speedupsConstructionMinutes:
          (data as Record<string, unknown>).speedupsConstructionMinutes ??
          current?.speedupsConstructionMinutes ??
          null,
        speedupsResearchMinutes:
          (data as Record<string, unknown>).speedupsResearchMinutes ??
          current?.speedupsResearchMinutes ??
          null,
        speedupsTrainingMinutes:
          (data as Record<string, unknown>).speedupsTrainingMinutes ??
          current?.speedupsTrainingMinutes ??
          null,
        speedupsHealingMinutes:
          (data as Record<string, unknown>).speedupsHealingMinutes ??
          current?.speedupsHealingMinutes ??
          null,
      };
      const total = Object.values(merged).reduce<number>(
        (s, v) => s + (typeof v === "number" ? v : 0),
        0,
      );
      data.speedupsMinutes = total > 0 ? total : null;
    }

    if (patch.screenshots) {
      data.screenshots = patch.screenshots as unknown as Prisma.InputJsonValue;
    }
    if ("speedupsBreakdown" in patch) {
      data.speedupsBreakdown = (patch.speedupsBreakdown ??
        Prisma.JsonNull) as Prisma.InputJsonValue;
    }
    if ("equipmentSummary" in patch) {
      data.equipmentSummary = (patch.equipmentSummary ??
        Prisma.JsonNull) as Prisma.InputJsonValue;
    }

    // Recompute score+tags if any scoring input changed. We pull the
    // post-patch projection — touched fields come from `data`, the
    // rest from the existing row — so the recompute reflects exactly
    // what's about to be persisted.
    const SCORE_INPUT_FIELDS = [
      "vipLevel",
      "power",
      "killPoints",
      "deaths",
      "maxValorPoints",
      "accountBornAt",
      "spendingTier",
    ] as const;
    const scoringDirty = SCORE_INPUT_FIELDS.some((f) => f in patch);
    if (scoringDirty) {
      const current = await prisma.migrationApplication.findUnique({
        where: { id },
        select: {
          vipLevel: true,
          accountBornAt: true,
          spendingTier: true,
          powerN: true,
          killPointsN: true,
          deathsN: true,
          maxValorPointsN: true,
        },
      });
      const merged = {
        vipLevel:
          (data.vipLevel as string | null | undefined) ??
          current?.vipLevel ??
          "",
        accountBornAt:
          (data.accountBornAt as Date | null | undefined) ??
          current?.accountBornAt ??
          null,
        spendingTier:
          (data.spendingTier as string | null | undefined) ??
          current?.spendingTier ??
          null,
        powerN:
          (data.powerN as number | null | undefined) ?? current?.powerN ?? null,
        killPointsN:
          (data.killPointsN as number | null | undefined) ??
          current?.killPointsN ??
          null,
        deathsN:
          (data.deathsN as number | null | undefined) ??
          current?.deathsN ??
          null,
        maxValorPointsN:
          (data.maxValorPointsN as number | null | undefined) ??
          current?.maxValorPointsN ??
          null,
      };
      const { score, tags } = computeScore({
        accountBornAt: merged.accountBornAt,
        vipLevel: merged.vipLevel ?? "",
        powerN: merged.powerN,
        killPointsN: merged.killPointsN,
        deathsN: merged.deathsN,
        maxValorPointsN: merged.maxValorPointsN,
        spendingTier: merged.spendingTier as SpendingTier | null,
      });
      data.overallScore = score;
      data.tags = tags as unknown as Prisma.InputJsonValue;
    }

    let archivedNow = false;
    if (patch.status && patch.status !== existing.status) {
      data.status = patch.status;
      data.reviewedAt = new Date();
      const retention = BLOB_RETENTION_DAYS[patch.status];
      if (retention === null) {
        data.blobCleanupAt = null;
      } else if (retention === 0) {
        archivedNow = true;
        data.blobCleanupAt = new Date();
      } else {
        const cleanup = new Date();
        cleanup.setDate(cleanup.getDate() + retention);
        data.blobCleanupAt = cleanup;
      }
    }

    const updated = await prisma.migrationApplication.update({
      where: { id },
      data,
    });

    if (archivedNow) {
      const urls = getScreenshotUrls(existing.screenshots);
      if (urls.length > 0) {
        try {
          await deleteBlobs(urls);
          await prisma.migrationApplication.update({
            where: { id },
            data: { screenshots: [] as unknown as Prisma.InputJsonValue },
          });
          updated.screenshots = [] as unknown as Prisma.JsonValue;
        } catch (err) {
          // Don't fail the patch if blob cleanup fails — cron will retry.
          console.error("[migration-app] blob cleanup failed", err);
        }
      }
    }

    return withCors(request, NextResponse.json(updated));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return withCors(
        request,
        NextResponse.json(
          { error: "validation_failed", issues: err.issues },
          { status: 400 },
        ),
      );
    }
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
 * DELETE /api/migration-applications/[id]/admin
 * Hard delete + immediate blob cleanup.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    const existing = await prisma.migrationApplication.findUnique({
      where: { id },
      select: { screenshots: true },
    });
    if (!existing) {
      return withCors(
        request,
        NextResponse.json({ error: "not_found" }, { status: 404 }),
      );
    }
    const urls = getScreenshotUrls(existing.screenshots);
    await prisma.migrationApplication.delete({ where: { id } });
    if (urls.length > 0) {
      try {
        await deleteBlobs(urls);
      } catch (err) {
        console.error("[migration-app] blob cleanup on delete failed", err);
      }
    }
    return withCors(request, NextResponse.json({ deleted: true }));
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
