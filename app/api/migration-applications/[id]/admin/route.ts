import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { withCors } from "@/lib/cors";
import { deleteBlobs } from "@/lib/blob";
import {
  BLOB_RETENTION_DAYS,
  DRIFT_THRESHOLD,
  DRIFT_WATCHED_SPEEDUPS,
  DRIFT_WATCHED_STATS,
  NORMALIZED_FIELD_MAP,
  SPEEDUP_FIELD_MAP,
  STATUSES,
  screenshotSchema,
  type DriftFlag,
} from "@/lib/migration-application";
import { parseRokNumber } from "@/lib/parse-rok-number";
import { parseRokDuration } from "@/lib/parse-rok-duration";
import {
  computeApplicantScore,
  inferProfile,
  inferStage,
  percentileTag,
  SCORING_PROFILES,
  SPENDING_TIERS,
  type ScoringProfile,
  type SpendingTier,
} from "@/lib/scoring";
import { loadBenchmarkLookup, rebuildAllBenchmarks } from "@/lib/benchmarks";
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
    prevKvkKillPoints: z.string().max(40).optional().nullable(),
    prevKvkT4Kills: z.string().max(40).optional().nullable(),
    prevKvkT5Kills: z.string().max(40).optional().nullable(),
    prevKvkDeaths: z.string().max(40).optional().nullable(),
    accountBornAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
      .optional()
      .nullable(),
    scoutVerified: z.boolean().optional(),
    spendingTier: z
      .enum(SPENDING_TIERS as unknown as [string, ...string[]])
      .optional(),
    scoringProfile: z
      .enum(SCORING_PROFILES as unknown as [string, ...string[]])
      .optional()
      .nullable(),
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

/** Field-key → matching normalized DB column name. */
const STAT_N_COLUMN: Record<(typeof DRIFT_WATCHED_STATS)[number], string> = {
  power: "powerN",
  killPoints: "killPointsN",
  t4Kills: "t4KillsN",
  t5Kills: "t5KillsN",
  deaths: "deathsN",
  food: "foodN",
  wood: "woodN",
  stone: "stoneN",
  gold: "goldN",
};
const SPEEDUP_MIN_COLUMN: Record<
  (typeof DRIFT_WATCHED_SPEEDUPS)[number],
  string
> = {
  speedupsConstruction: "speedupsConstructionMinutes",
  speedupsResearch: "speedupsResearchMinutes",
  speedupsTraining: "speedupsTrainingMinutes",
  speedupsHealing: "speedupsHealingMinutes",
  speedupsUniversal: "speedupsUniversalMinutes",
};

/**
 * Compare what OCR auto-filled at submit time vs what ended up in the
 * DB to decide which fields deserve an "applicant edited the parsed
 * value" badge in admin.
 *
 * Verdicts per watched field:
 *   "auto-edited" — autofill snapshot exists and differs from final
 *                   by >5%, OR the applicant cleared a field that was
 *                   auto-filled (final is null)
 *   "manual"      — applicant typed a value but no autofill snapshot
 *                   was recorded (so admin can't verify against OCR)
 *   null          — within tolerance, or both empty
 */
function computeDriftFlags(
  app: Record<string, unknown>,
): Record<string, DriftFlag> {
  const autofill = (app.ocrAutofill ?? {}) as Record<string, unknown>;
  const flags: Record<string, DriftFlag> = {};

  const verdict = (
    autoVal: number | null,
    finalVal: number | null,
  ): DriftFlag => {
    if (autoVal == null || !Number.isFinite(autoVal) || autoVal === 0) {
      return finalVal != null && finalVal !== 0 ? "manual" : null;
    }
    if (finalVal == null || finalVal === 0) return "auto-edited";
    const drift = Math.abs(finalVal - autoVal) / Math.abs(autoVal);
    return drift > DRIFT_THRESHOLD ? "auto-edited" : null;
  };

  for (const k of DRIFT_WATCHED_STATS) {
    const auto = autofill[k];
    const final = app[STAT_N_COLUMN[k]] as number | null;
    flags[k] = verdict(typeof auto === "number" ? auto : null, final);
  }
  for (const k of DRIFT_WATCHED_SPEEDUPS) {
    const auto = autofill[k];
    const final = app[SPEEDUP_MIN_COLUMN[k]] as number | null;
    flags[k] = verdict(typeof auto === "number" ? auto : null, final);
  }
  return flags;
}

/** Enrich a raw prisma row with the same computed fields the admin UI
 *  expects on every GET / PATCH response: percentiles, drift flags,
 *  recomputed score breakdown, effective profile/cohort. Centralizing
 *  this keeps GET and PATCH responses shape-identical so the admin
 *  client can `setApp(response)` from either without losing fields. */
async function enrichApplicationDetail(
  item: Awaited<ReturnType<typeof prisma.migrationApplication.findUnique>>,
) {
  if (!item) return null;
  const percentiles = await getPercentilesForApp(item.id);
  const driftFlags = computeDriftFlags(
    item as unknown as Record<string, unknown>,
  );
  // Per-KvK benchmark lookup. Falls back to KVK_PRIORS for kvkIds that
  // have no upload yet — same effect as if this feature didn't exist.
  const benchmarkLookup = await loadBenchmarkLookup();

  // detectedSeed back-fill: if the applicant didn't supply it via DKP
  // scan upload (older apps, or apps where the form didn't capture it),
  // try to infer from `currentKingdom` (their typed KD number → lookup
  // in KingdomSeed). Lets the seed-aware scoring + popover hint kick in
  // for legacy apps without requiring a manual backfill pass.
  let detectedSeed = item.detectedSeed;
  if (!detectedSeed && item.currentKingdom) {
    const kdNum = Number.parseInt(
      item.currentKingdom.replace(/\D/g, ""),
      10,
    );
    if (Number.isFinite(kdNum) && kdNum > 0) {
      const ks = await prisma.kingdomSeed.findUnique({
        where: { kingdomId: kdNum },
        select: { seed: true },
      });
      if (ks) detectedSeed = ks.seed;
    }
  }
  // Recompute the canonical DKP for the last KvK using the active
  // profile's weights (LK 10/20/50 vs SoC 10/30/80). Lets admin
  // compare against the applicant-reported `previousKvkDkp` to
  // surface fudged numbers.
  const profile = (item.scoringProfile ?? "lost-kingdom") as ScoringProfile;
  const dkpWeights =
    profile === "season-of-conquest"
      ? { t4: 10, t5: 30, deaths: 80 }
      : { t4: 10, t5: 20, deaths: 50 };
  const prevKvkDkpComputed =
    item.prevKvkT4KillsN != null ||
    item.prevKvkT5KillsN != null ||
    item.prevKvkDeathsN != null
      ? (item.prevKvkT4KillsN ?? 0) * dkpWeights.t4 +
        (item.prevKvkT5KillsN ?? 0) * dkpWeights.t5 +
        (item.prevKvkDeathsN ?? 0) * dkpWeights.deaths
      : null;
  // Recompute the score breakdown on-the-fly so admin can render a
  // per-component "10/18" tooltip on hover. We don't persist the
  // breakdown JSON because it's deterministic from the inputs and
  // changing the formula in code would invalidate stored values.
  const recomputed = computeApplicantScore(
    {
      accountBornAt: item.accountBornAt,
      vipLevel: item.vipLevel,
      powerN: item.powerN,
      killPointsN: item.killPointsN,
      t1KillsN: item.t1KillsN,
      t2KillsN: item.t2KillsN,
      t3KillsN: item.t3KillsN,
      t4KillsN: item.t4KillsN,
      t5KillsN: item.t5KillsN,
      deathsN: item.deathsN,
      maxValorPointsN: item.maxValorPointsN,
      prevKvkT4KillsN: item.prevKvkT4KillsN,
      prevKvkT5KillsN: item.prevKvkT5KillsN,
      prevKvkDeathsN: item.prevKvkDeathsN,
      prevKvkRank: item.prevKvkRank ?? null,
      prevKvkScanActiveCount: item.prevKvkScanActiveCount ?? null,
      detectedSeed: detectedSeed ?? null,
      spendingTier: item.spendingTier as SpendingTier | null,
      scoringProfile: item.scoringProfile as ScoringProfile | null,
    },
    benchmarkLookup,
  );
  // The PROFILE the score was actually computed on. When `scoringProfile`
  // is null in DB we fall back to age-based inference.
  const effectiveProfile: ScoringProfile =
    (item.scoringProfile as ScoringProfile | null) ??
    inferProfile(item.accountBornAt);
  const profileAutoInferred = item.scoringProfile == null;
  // 4-stage cohort always derived from accountBornAt — not overridable.
  const effectiveCohort = recomputed.main.stage;

  return {
    ...item,
    detectedSeed: detectedSeed ?? null,
    percentiles,
    driftFlags,
    prevKvkDkpComputed,
    scoreBreakdown: recomputed.main.breakdown,
    effectiveProfile,
    profileAutoInferred,
    effectiveCohort,
    playedKvks: recomputed.main.playedKvks,
    /** Per-seed scoring scenarios. Null when applicant hasn't played
     *  any SoC seasons. Lets admin see "if scored against X-seed
     *  benchmark, applicant gets Y/100" for all 5 seeds. */
    perSeedScores: recomputed.perSeedScores,
    /** Effective overall score (tier-blind main). Persisted in DB as
     *  overallScore on next PATCH; exposed here so admin always reads
     *  the canonical post-recompute number. */
    overallScore: recomputed.main.score,
    /** Tier-blind main + seed-band tag (when applicable). Same shape
     *  as item.tags but freshly recomputed with current benchmarks. */
    tags: recomputed.tags,
  };
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
    const enriched = await enrichApplicationDetail(item);
    return withCors(request, NextResponse.json(enriched));
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
      "prevKvkKillPoints",
      "prevKvkT4Kills",
      "prevKvkT5Kills",
      "prevKvkDeaths",
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
    if ("scoringProfile" in patch) data.scoringProfile = patch.scoringProfile;
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
      "t1Kills",
      "t2Kills",
      "t3Kills",
      "t4Kills",
      "t5Kills",
      "deaths",
      "maxValorPoints",
      "prevKvkT4Kills",
      "prevKvkT5Kills",
      "prevKvkDeaths",
      "accountBornAt",
      "spendingTier",
      "scoringProfile",
    ] as const;
    const scoringDirty = SCORE_INPUT_FIELDS.some((f) => f in patch);
    if (scoringDirty) {
      const current = await prisma.migrationApplication.findUnique({
        where: { id },
        select: {
          vipLevel: true,
          accountBornAt: true,
          spendingTier: true,
          scoringProfile: true,
          powerN: true,
          killPointsN: true,
          t1KillsN: true,
          t2KillsN: true,
          t3KillsN: true,
          t4KillsN: true,
          t5KillsN: true,
          deathsN: true,
          maxValorPointsN: true,
          prevKvkT4KillsN: true,
          prevKvkT5KillsN: true,
          prevKvkDeathsN: true,
          prevKvkRank: true,
          prevKvkScanActiveCount: true,
          detectedSeed: true,
        },
      });
      const dataRec = data as Record<string, unknown>;
      const currentRec = (current ?? {}) as Record<string, unknown>;
      const pickN = (key: string): number | null => {
        const fromData = dataRec[key];
        if (typeof fromData === "number") return fromData;
        if (fromData === null) return null;
        const fromCurrent = currentRec[key];
        return typeof fromCurrent === "number" ? fromCurrent : null;
      };
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
        scoringProfile:
          (data.scoringProfile as string | null | undefined) ??
          current?.scoringProfile ??
          null,
        powerN: pickN("powerN"),
        killPointsN: pickN("killPointsN"),
        t1KillsN: pickN("t1KillsN"),
        t2KillsN: pickN("t2KillsN"),
        t3KillsN: pickN("t3KillsN"),
        t4KillsN: pickN("t4KillsN"),
        t5KillsN: pickN("t5KillsN"),
        deathsN: pickN("deathsN"),
        maxValorPointsN: pickN("maxValorPointsN"),
        prevKvkT4KillsN: pickN("prevKvkT4KillsN"),
        prevKvkT5KillsN: pickN("prevKvkT5KillsN"),
        prevKvkDeathsN: pickN("prevKvkDeathsN"),
        prevKvkRank: pickN("prevKvkRank"),
        prevKvkScanActiveCount: pickN("prevKvkScanActiveCount"),
        detectedSeed:
          (data.detectedSeed as string | null | undefined) ??
          (current?.detectedSeed as string | null | undefined) ??
          null,
      };
      const patchBenchmarkLookup = await loadBenchmarkLookup();
      const out = computeApplicantScore(
        {
          accountBornAt: merged.accountBornAt,
          vipLevel: merged.vipLevel ?? "",
          powerN: merged.powerN,
          killPointsN: merged.killPointsN,
          t1KillsN: merged.t1KillsN,
          t2KillsN: merged.t2KillsN,
          t3KillsN: merged.t3KillsN,
          t4KillsN: merged.t4KillsN,
          t5KillsN: merged.t5KillsN,
          deathsN: merged.deathsN,
          maxValorPointsN: merged.maxValorPointsN,
          prevKvkT4KillsN: merged.prevKvkT4KillsN,
          prevKvkT5KillsN: merged.prevKvkT5KillsN,
          prevKvkDeathsN: merged.prevKvkDeathsN,
          prevKvkRank: merged.prevKvkRank,
          prevKvkScanActiveCount: merged.prevKvkScanActiveCount,
          detectedSeed: merged.detectedSeed,
          spendingTier: merged.spendingTier as SpendingTier | null,
          scoringProfile: merged.scoringProfile as ScoringProfile | null,
        },
        patchBenchmarkLookup,
      );
      data.overallScore = out.main.score;
      data.tags = out.tags as unknown as Prisma.InputJsonValue;
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

    // After approval, rebuild benchmarks so any score popovers refresh
    // their ratios. Under the new ratio-based scoring, approved
    // applicants don't FEED benchmarks directly (DKP-scan uploads do),
    // but rebuilding is cheap and keeps everything consistent. Fire-
    // and-forget — the user's PATCH response shouldn't block on it.
    if (updated.status === "approved" && existing.status !== "approved") {
      void rebuildAllBenchmarks().catch((err) => {
        console.error("[benchmarks] rebuildAllBenchmarks failed", err);
      });
    }

    const enriched = await enrichApplicationDetail(updated);
    return withCors(request, NextResponse.json(enriched));
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
