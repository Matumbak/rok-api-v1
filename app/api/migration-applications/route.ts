import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { withCors } from "@/lib/cors";
import { deleteBlobs } from "@/lib/blob";
import {
  DRIFT_WATCHED_SPEEDUPS,
  DRIFT_WATCHED_STATS,
  NORMALIZED_FIELD_MAP,
  SPEEDUP_FIELD_MAP,
  submitSchema,
} from "@/lib/migration-application";
import { parseRokNumber } from "@/lib/parse-rok-number";
import { parseRokDuration } from "@/lib/parse-rok-duration";
import {
  computeApplicantScore,
  type ScoringProfile,
  type SpendingTier,
} from "@/lib/scoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cooldown window before a governor can resubmit. Anything submitted
 *  within this window is rejected outright; once exceeded, the old
 *  application is wiped (blobs + row) and replaced with the new one.
 *  Approved applications are exempt — they're a committed decision and
 *  must be re-opened by an officer manually. */
const COOLDOWN_DAYS = 15;
const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

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

    // ── Anti-spam: per-governor dedup with 15-day cooldown ──────────
    //
    // RoK Governor IDs are unique per player, so we use it as the
    // dedup key. Three outcomes:
    //   - approved        → 409, never overwrite via public form
    //   - <15 days old    → 429 with daysLeft, applicant must wait
    //   - ≥15 days old    → wipe (blobs + row) and let the new one
    //                       through, so we don't accumulate stale
    //                       drafts on a single governor
    //
    // Race condition: two concurrent submits for the same ID could
    // both pass this check before either inserts. The window is small
    // (single-digit ms) and the worst case is two rows for one
    // governor — recoverable in admin. Wrapping the whole flow in a
    // serializable transaction would be cleaner but adds latency on
    // every submit; not worth it for spam protection at this scale.
    const existing = await prisma.migrationApplication.findFirst({
      where: { governorId: data.governorId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        createdAt: true,
        screenshots: true,
      },
    });
    if (existing) {
      if (existing.status === "approved") {
        return withCors(
          request,
          NextResponse.json(
            { error: "already_approved" },
            { status: 409 },
          ),
        );
      }
      const ageMs = Date.now() - existing.createdAt.getTime();
      if (ageMs < COOLDOWN_MS) {
        const daysAgo = Math.floor(ageMs / 86_400_000);
        const daysLeft = Math.ceil((COOLDOWN_MS - ageMs) / 86_400_000);
        return withCors(
          request,
          NextResponse.json(
            {
              error: "cooldown_active",
              daysAgo,
              daysLeft,
            },
            { status: 429 },
          ),
        );
      }
      // Old enough — drop blobs + row before inserting the fresh one.
      // Blob delete is best-effort: if Vercel's API hiccups we still
      // proceed with the DB delete so the form unblocks; the orphan
      // cleanup cron will sweep stragglers.
      const oldShots = Array.isArray(existing.screenshots)
        ? (existing.screenshots as Array<{ url?: string }>)
        : [];
      const urls = oldShots
        .map((s) => s?.url)
        .filter((u): u is string => typeof u === "string" && u.length > 0);
      try {
        await deleteBlobs(urls);
      } catch (e) {
        console.warn(
          `[submit] blob cleanup for old app ${existing.id} failed:`,
          e,
        );
      }
      await prisma.migrationApplication.delete({
        where: { id: existing.id },
      });
    }

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

    const accountBornAtDate = data.accountBornAt
      ? new Date(`${data.accountBornAt}T00:00:00.000Z`)
      : null;

    // Normalize the autofill snapshot into the same units we store on
    // the actual columns: raw integers for stats, minutes for speedups.
    // Anything outside the watched set is dropped on the floor — keeps
    // the JSON tight + prevents future drift in observed-keys list.
    const autofillNormalized: Record<string, number> = {};
    if (data.ocrAutofill) {
      for (const k of DRIFT_WATCHED_STATS) {
        const raw = data.ocrAutofill[k];
        if (raw == null) continue;
        const n = parseRokNumber(typeof raw === "number" ? String(raw) : raw);
        if (n != null) autofillNormalized[k] = n;
      }
      for (const k of DRIFT_WATCHED_SPEEDUPS) {
        const raw = data.ocrAutofill[k];
        if (raw == null) continue;
        const m = parseRokDuration(
          typeof raw === "number" ? String(raw) : raw,
        );
        if (m != null) autofillNormalized[k] = m;
      }
    }
    const _scoreOut = computeApplicantScore({
      accountBornAt: accountBornAtDate,
      vipLevel: data.vipLevel,
      powerN: normalized.powerN,
      killPointsN: normalized.killPointsN,
      t1KillsN: normalized.t1KillsN,
      t2KillsN: normalized.t2KillsN,
      t3KillsN: normalized.t3KillsN,
      t4KillsN: normalized.t4KillsN,
      t5KillsN: normalized.t5KillsN,
      deathsN: normalized.deathsN,
      maxValorPointsN: normalized.maxValorPointsN,
      prevKvkT4KillsN: normalized.prevKvkT4KillsN,
      prevKvkT5KillsN: normalized.prevKvkT5KillsN,
      prevKvkDeathsN: normalized.prevKvkDeathsN,
      prevKvkRank: data.prevKvkRank ?? null,
      prevKvkScanActiveCount: data.prevKvkScanActiveCount ?? null,
      detectedSeed: data.detectedSeed ?? null,
      spendingTier: data.spendingTier as SpendingTier,
      scoringProfile: (data.scoringProfile as ScoringProfile) ?? null,
    });
    const score = _scoreOut.main.score;
    const tags = _scoreOut.tags;

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

        constructionPower: data.constructionPower ?? null,
        technologyPower: data.technologyPower ?? null,
        troopPower: data.troopPower ?? null,
        commanderPower: data.commanderPower ?? null,
        maxPower: data.maxPower ?? null,
        wins: data.wins ?? null,
        losses: data.losses ?? null,
        arkOsirisWins: data.arkOsirisWins ?? null,
        valorPoints: data.valorPoints ?? null,
        maxValorPoints: data.maxValorPoints ?? null,

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

        accountBornAt: accountBornAtDate,
        scoutVerified: data.scoutVerified ?? false,

        spendingTier: data.spendingTier,
        scoringProfile: data.scoringProfile ?? null,
        overallScore: score,
        tags: tags as unknown as Prisma.InputJsonValue,

        prevKvkKillPoints: data.prevKvkKillPoints ?? null,
        prevKvkT4Kills: data.prevKvkT4Kills ?? null,
        prevKvkT5Kills: data.prevKvkT5Kills ?? null,
        prevKvkDeaths: data.prevKvkDeaths ?? null,
        prevKvkKillPointsN: normalized.prevKvkKillPointsN,
        prevKvkT4KillsN: normalized.prevKvkT4KillsN,
        prevKvkT5KillsN: normalized.prevKvkT5KillsN,
        prevKvkDeathsN: normalized.prevKvkDeathsN,

        prevKvkRank: data.prevKvkRank ?? null,
        prevKvkScanActiveCount: data.prevKvkScanActiveCount ?? null,
      detectedSeed: data.detectedSeed ?? null,

        ocrAutofill:
          Object.keys(autofillNormalized).length > 0
            ? (autofillNormalized as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,

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
        constructionPowerN: normalized.constructionPowerN,
        technologyPowerN: normalized.technologyPowerN,
        troopPowerN: normalized.troopPowerN,
        commanderPowerN: normalized.commanderPowerN,
        maxPowerN: normalized.maxPowerN,
        winsN: normalized.winsN,
        lossesN: normalized.lossesN,
        arkOsirisWinsN: normalized.arkOsirisWinsN,
        valorPointsN: normalized.valorPointsN,
        maxValorPointsN: normalized.maxValorPointsN,

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
