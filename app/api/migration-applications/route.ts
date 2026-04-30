import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withCors } from "@/lib/cors";
import {
  NORMALIZED_FIELD_MAP,
  SPEEDUP_FIELD_MAP,
  submitSchema,
} from "@/lib/migration-application";
import { parseRokNumber } from "@/lib/parse-rok-number";
import { parseRokDuration } from "@/lib/parse-rok-duration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/migration-applications — public form submit.
 *
 * Screenshots referenced here are expected to already be uploaded via
 * /api/uploads/screenshot. We do not re-validate that the URLs point at
 * our blob store — Vercel Blob URLs are unguessable and orphan-cleanup
 * will reap anything that goes stale.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const data = submitSchema.parse(body);

    // Compute normalized numeric fields from the raw string inputs.
    const normalized: Record<string, number | null> = {};
    for (const [raw, normCol] of Object.entries(NORMALIZED_FIELD_MAP)) {
      const value = (data as unknown as Record<string, string | null>)[raw];
      normalized[normCol] = parseRokNumber(value);
    }

    // Compute per-category speedup minutes + grand total. If the user
    // typed something into the legacy `speedupsMinutes` field we still
    // honor it (treats it as the universal bucket fallback).
    const speedupMins: Record<string, number | null> = {};
    let grandTotal = 0;
    let anyParsed = false;
    for (const [raw, col] of Object.entries(SPEEDUP_FIELD_MAP)) {
      const v = (data as unknown as Record<string, string | null>)[raw];
      const mins = parseRokDuration(v);
      speedupMins[col] = mins;
      if (mins != null) {
        grandTotal += mins;
        anyParsed = true;
      }
    }
    const legacyTotal = data.speedupsMinutes
      ? Number.parseInt(data.speedupsMinutes, 10) || null
      : null;
    const speedupsMinutesTotal = anyParsed
      ? grandTotal
      : legacyTotal;

    const created = await prisma.migrationApplication.create({
      data: {
        governorId: data.governorId,
        nickname: data.nickname,
        currentKingdom: data.currentKingdom,
        currentAlliance: data.currentAlliance ?? null,
        power: data.power,
        killPoints: data.killPoints,
        vipLevel: data.vipLevel,
        discordHandle: data.discordHandle,

        t1Kills: data.t1Kills ?? null,
        t2Kills: data.t2Kills ?? null,
        t3Kills: data.t3Kills ?? null,
        t4Kills: data.t4Kills ?? null,
        t5Kills: data.t5Kills ?? null,
        deaths: data.deaths ?? null,
        healed: data.healed ?? null,
        resourcesGathered: data.resourcesGathered ?? null,
        food: data.food ?? null,
        wood: data.wood ?? null,
        stone: data.stone ?? null,
        gold: data.gold ?? null,

        speedupsMinutes: speedupsMinutesTotal,
        speedupsUniversalMinutes: speedupMins.speedupsUniversalMinutes,
        speedupsConstructionMinutes: speedupMins.speedupsConstructionMinutes,
        speedupsResearchMinutes: speedupMins.speedupsResearchMinutes,
        speedupsTrainingMinutes: speedupMins.speedupsTrainingMinutes,
        speedupsHealingMinutes: speedupMins.speedupsHealingMinutes,
        speedupsBreakdown:
          data.speedupsBreakdown == null
            ? Prisma.JsonNull
            : (data.speedupsBreakdown as Prisma.InputJsonValue),

        marches: data.marches ?? null,
        equipmentSummary:
          data.equipmentSummary == null
            ? Prisma.JsonNull
            : (data.equipmentSummary as Prisma.InputJsonValue),
        previousKvkDkp: data.previousKvkDkp ?? null,

        activityHours: data.activityHours ?? null,
        timezone: data.timezone ?? null,
        hasScrolls: data.hasScrolls,
        reason: data.reason ?? null,

        ocrRawText: data.ocrRawText ?? null,

        powerN: normalized.powerN,
        killPointsN: normalized.killPointsN,
        t1KillsN: normalized.t1KillsN,
        t2KillsN: normalized.t2KillsN,
        t3KillsN: normalized.t3KillsN,
        t4KillsN: normalized.t4KillsN,
        t5KillsN: normalized.t5KillsN,
        deathsN: normalized.deathsN,
        healedN: normalized.healedN,
        resourcesGatheredN: normalized.resourcesGatheredN,
        foodN: normalized.foodN,
        woodN: normalized.woodN,
        stoneN: normalized.stoneN,
        goldN: normalized.goldN,
        previousKvkDkpN: normalized.previousKvkDkpN,

        screenshots: data.screenshots as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, createdAt: true },
    });

    return withCors(
      request,
      NextResponse.json(
        { id: created.id, createdAt: created.createdAt },
        { status: 201 },
      ),
    );
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
