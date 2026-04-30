import { z } from "zod";

/** Categories the form sends — purely advisory, stored alongside each blob. */
export const SCREENSHOT_CATEGORIES = [
  "account",
  "commander",
  "resource",
  "dkp",
  "other",
] as const;

export const screenshotSchema = z.object({
  url: z.string().url(),
  pathname: z.string().min(1),
  category: z.enum(SCREENSHOT_CATEGORIES).default("other"),
  label: z.string().max(120).optional(),
  size: z.number().int().nonnegative().optional(),
  contentType: z.string().max(80).optional(),
});

export const STATUSES = [
  "pending",
  "approved",
  "rejected",
  "archived",
] as const;
export type ApplicationStatus = (typeof STATUSES)[number];

/**
 * Public submit body. Everything except the screenshots array is free-text;
 * we don't try to validate numbers because RoK players write them in many
 * different formats ("84M", "84,200,000", "84.2M").
 */
export const submitSchema = z.object({
  governorId: z.string().min(1).max(20),
  nickname: z.string().min(1).max(60),
  currentKingdom: z.string().min(1).max(20),
  currentAlliance: z.string().max(40).optional().nullable(),
  power: z.string().max(40),
  killPoints: z.string().max(40),
  vipLevel: z.string().max(10),
  discordHandle: z.string().min(1).max(60),

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

  // Each speedup category accepts either a duration string ("63 дн 12 ч")
  // or a bare minutes integer. The server normalizes both to Int minutes
  // via parseRokDuration().
  speedupsUniversal: z.string().max(40).optional().nullable(),
  speedupsConstruction: z.string().max(40).optional().nullable(),
  speedupsResearch: z.string().max(40).optional().nullable(),
  speedupsTraining: z.string().max(40).optional().nullable(),
  speedupsHealing: z.string().max(40).optional().nullable(),

  speedupsMinutes: z.string().max(20).optional().nullable(),
  speedupsBreakdown: z.record(z.string(), z.string()).optional().nullable(),

  marches: z.number().int().min(0).max(20).optional().nullable(),
  equipmentSummary: z.record(z.string(), z.string()).optional().nullable(),
  previousKvkDkp: z.string().max(40).optional().nullable(),

  activityHours: z.string().max(80).optional().nullable(),
  timezone: z.string().max(40).optional().nullable(),
  hasScrolls: z.boolean().default(false),
  reason: z.string().max(2000).optional().nullable(),

  /// Optional concatenated OCR text from the client-side Tesseract pass.
  /// Stored as-is for debugging / admin re-parse.
  ocrRawText: z.string().max(50_000).optional().nullable(),

  screenshots: z.array(screenshotSchema).max(50),
});

/**
 * Field pairs (raw string → normalized Float column). Used to keep the
 * normalized columns in sync on submit and PATCH.
 */
export const NORMALIZED_FIELD_MAP: Record<string, string> = {
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

/**
 * Speedup raw-input field → normalized Int-minutes column. The grand
 * total `speedupsMinutes` is the sum of the five typed columns and is
 * computed separately on write.
 */
export const SPEEDUP_FIELD_MAP: Record<string, string> = {
  speedupsUniversal: "speedupsUniversalMinutes",
  speedupsConstruction: "speedupsConstructionMinutes",
  speedupsResearch: "speedupsResearchMinutes",
  speedupsTraining: "speedupsTrainingMinutes",
  speedupsHealing: "speedupsHealingMinutes",
};

export type SubmitBody = z.infer<typeof submitSchema>;

/** Days to keep blobs before the cleanup job nukes them. */
export const BLOB_RETENTION_DAYS: Record<ApplicationStatus, number | null> = {
  pending: null, // never auto-clean while pending
  approved: 90,
  rejected: 30,
  archived: 0, // immediate
};
