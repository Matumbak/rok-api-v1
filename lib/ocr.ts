/**
 * OCR for RoK screenshots — provider cascade.
 *
 *   Groq        — primary. Genuinely free tier (no CC, no deposit),
 *                 ~14 400 req/day, fastest inference (LPU chips). Used
 *                 first when GROQ_API_KEY is set.
 *   OpenRouter  — fallback. :free models require a paid history /
 *                 deposit on new accounts (returns 404 otherwise), but
 *                 once unlocked it offers a wide model catalog.
 *
 * Both APIs are OpenAI-compatible Chat-Completions, so the request
 * payload is identical bar base URL + bearer token + model name.
 * Either provider is individually optional — the cascade just skips a
 * section when its key isn't set.
 */

import { z } from "zod";

const GROQ_KEY = process.env.GROQ_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** Vision-capable models on Groq's free tier (late 2025). */
const DEFAULT_GROQ_MODELS = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
];

/** Free vision models on OpenRouter — used only when Groq is unavailable
 *  or rate-limited. Each entry can hit 404 if OR rotates models out;
 *  cascade keeps marching to the next. */
const DEFAULT_OPENROUTER_MODELS = [
  "meta-llama/llama-3.2-11b-vision-instruct:free",
  "qwen/qwen-2.5-vl-72b-instruct:free",
  "mistralai/mistral-small-3.2-24b-instruct:free",
];

interface ProviderTarget {
  label: string;
  endpoint: string;
  apiKey: string;
  model: string;
  /** OpenRouter wants Referer + Title for analytics + free-tier eligibility. */
  extraHeaders?: Record<string, string>;
}

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function buildTargets(): ProviderTarget[] {
  const targets: ProviderTarget[] = [];
  if (GROQ_KEY) {
    for (const m of envList("GROQ_OCR_MODELS", DEFAULT_GROQ_MODELS)) {
      targets.push({
        label: `groq/${m}`,
        endpoint: GROQ_ENDPOINT,
        apiKey: GROQ_KEY,
        model: m,
      });
    }
  }
  if (OPENROUTER_KEY) {
    for (const m of envList(
      "OPENROUTER_OCR_MODELS",
      DEFAULT_OPENROUTER_MODELS,
    )) {
      targets.push({
        label: `openrouter/${m}`,
        endpoint: OPENROUTER_ENDPOINT,
        apiKey: OPENROUTER_KEY,
        model: m,
        extraHeaders: {
          "HTTP-Referer": "https://huns-4028.vercel.app",
          "X-Title": "RoK 4028 migration form",
        },
      });
    }
  }
  return targets;
}

export interface ParsedRokScreen {
  governorId: string | null;
  nickname: string | null;
  power: string | null;
  killPoints: string | null;
  vipLevel: string | null;
  t1Kills: string | null;
  t2Kills: string | null;
  t3Kills: string | null;
  t4Kills: string | null;
  t5Kills: string | null;
  deaths: string | null;
  maxValorPoints: string | null;
  food: string | null;
  wood: string | null;
  stone: string | null;
  gold: string | null;
  speedupsConstruction: string | null;
  speedupsResearch: string | null;
  speedupsTraining: string | null;
  speedupsHealing: string | null;
  speedupsUniversal: string | null;
  /**
   * True iff the screen is a commander-profile screen for the starter
   * Scout/Skirmisher (the 3-star Advanced archer everyone gets within
   * the first ~2 minutes of an account). Used to derive the account's
   * birth date — any other commander could have been recruited months
   * later, so we explicitly reject them here.
   */
  isScoutCommander: boolean | null;
  /**
   * ISO calendar date (YYYY-MM-DD) of the Scout's recruitment, taken
   * from the "Дата найма" / "Recruit Date" / "Hire Date" line. Always
   * null unless `isScoutCommander` is true.
   */
  accountBornAt: string | null;
}

const PARSED_STRING_KEYS = [
  "governorId",
  "nickname",
  "power",
  "killPoints",
  "vipLevel",
  "t1Kills",
  "t2Kills",
  "t3Kills",
  "t4Kills",
  "t5Kills",
  "deaths",
  "maxValorPoints",
  "food",
  "wood",
  "stone",
  "gold",
  "speedupsConstruction",
  "speedupsResearch",
  "speedupsTraining",
  "speedupsHealing",
  "speedupsUniversal",
  "accountBornAt",
] as const;

/**
 * Per-field shape: any model is allowed to return null OR a primitive
 * we can coerce to string. Llama 4 in particular tends to emit numbers
 * for numeric fields even when prompted for strings — `preprocess`
 * lets us salvage those without bouncing the whole response.
 */
const stringFieldSchema = z.preprocess((v) => {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Anything weird (object / array) → null, model can be re-prompted
  // by the cascade if all providers misbehave.
  return null;
}, z.string().nullable());

/** Boolean-ish coercion — models sometimes emit "true"/"false" strings. */
const boolFieldSchema = z.preprocess((v) => {
  if (v == null) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "yes" || s === "1") return true;
    if (s === "false" || s === "no" || s === "0") return false;
  }
  if (typeof v === "number") return v !== 0;
  return null;
}, z.boolean().nullable());

const responseSchema = z.object({
  ...(Object.fromEntries(
    PARSED_STRING_KEYS.map((k) => [k, stringFieldSchema]),
  ) as Record<(typeof PARSED_STRING_KEYS)[number], typeof stringFieldSchema>),
  isScoutCommander: boolFieldSchema,
});

const SYSTEM_PROMPT = `You are an OCR for Rise of Kingdoms (RoK) governor screenshots.
The image shows ONE primary screen. Identify which screen it is, then
extract ONLY the fields owned by that screen. Every other field MUST be
null — even if a value happens to be partially visible behind a popup
overlay.

Screen routing — fill ONLY the listed fields per screen:

  1. PROFILE ("Профиль правителя" / "Governor Profile" header):
       governorId, nickname, power, killPoints, maxValorPoints,
       vipLevel
     Everything else → null.

  2. KILL DATA POPUP ("Данные по убийствам" / "Kill Data" header):
       t1Kills, t2Kills, t3Kills, t4Kills, t5Kills
     Read the LEFT column "Убийства" / "Kills" — the kill COUNTS.
     The right column "Очки убийств" / "Kill Points" is the per-tier
     points contribution; ignore it entirely.

     ⚠ EVERYTHING ELSE on this screen MUST be null — no exceptions.
       - The dimmed profile underneath shows partial values for
         power / killPoints / governorId / nickname / valor; even if
         readable, set them to null.
       - The popup itself shows a "Всего" / "Total" line at the bottom.
         DO NOT report it as killPoints. killPoints stays null.
       - Per-tier "Очки убийств" cells are NOT killPoints. Never copy
         a per-tier points value into killPoints.

  3. DETAILS TAB ("Подробнее" / "Details" header, "Войска" tab):
       deaths
     Other power-breakdown / wins / losses lines → null.

  4. RESOURCES TAB ("Ваши ресурсы и ускорения" header, "Ресурсы" tab):
       food, wood, stone, gold
     Take the FIRST column "От предметов" / "From items" — NOT the
     rightmost "Всего" / "Total" column.

  5. SPEEDUPS TAB ("Ваши ресурсы и ускорения" header, "Ускорения" tab):
       speedupsConstruction, speedupsResearch, speedupsTraining,
       speedupsHealing, speedupsUniversal
     Universal is the row labelled simply "Ускорение" / "Speedup".

  6. COMMANDER PROFILE — A single-commander info card with a portrait,
     a header naming the commander, a star/rarity bar, and rows like
     "Дата найма" / "Recruit Date" / "Hired" plus kills, rarity, etc.
     This is the ONLY screen on which isScoutCommander and
     accountBornAt may be non-null.

     Fill ONLY:
       isScoutCommander (boolean), accountBornAt (ISO date string).

     Set isScoutCommander = true ONLY if BOTH conditions hold:
       (a) The commander NAME matches the Skirmisher/Scout multilingual
           whitelist below (case-insensitive, accent-insensitive,
           tolerate up to 1 OCR slip). Match the commander NAME from
           the header — NOT the unit-type or specialty subtitle.
       (b) The portrait shows the Scout's distinct appearance: a young
           dark-skinned woman with hair tied up, wielding a longbow,
           wearing brown leather light armor with a short skirt and
           leather boots. Standing pose, bow drawn or held at her side.
           If the portrait is anyone else (a man, a different woman,
           an armored knight, anyone holding a sword/spear/staff/etc),
           she is NOT the Scout — return false.

     Star rating and rarity DO NOT matter — players upgrade Scout from
     3-star Advanced up to 6-star Legendary, and the date stays valid
     regardless. Match only on name + portrait appearance.

     Skirmisher/Scout commander name whitelist (any of):
       English        : Scout, Skirmisher
       Russian        : Застрельщица, Застрельщик
       Spanish        : Tirador, Tiradora
       Portuguese     : Atirador, Atiradora
       French         : Tirailleur, Tirailleuse
       Italian        : Tiratore, Tiratrice
       German         : Plänkler, Plänklerin, Schütze
       Dutch          : Schermutselaar
       Polish         : Harcownik, Harcownica
       Turkish        : Avcı, Akıncı
       Vietnamese     : Lính Bắn Tỉa, Trinh Sát
       Indonesian     : Penembak, Pengintai
       Thai           : นักธนู, นักรบประชิด
       Japanese       : 散兵, 斥候, スカウト
       Korean         : 척후병, 산병, 정찰병
       Chinese (CN/TW): 散兵, 侦察兵, 偵察兵
       Arabic         : المناوش, الكشاف

     If the commander on screen is anything else (Sun Tzu, Joan,
     Yi Seong-Gye, Constance, etc), set isScoutCommander = false and
     accountBornAt = null. Do NOT guess. Better to return false than
     to falsely accept a different commander.

     accountBornAt format: convert the recruit-date row from the
     in-game format "YYYY/M/D HH:MM" (or whatever locale order shows)
     to ISO calendar date "YYYY-MM-DD". Drop the time component.
     Examples: "2026/2/7 23:16" → "2026-02-07",
               "07.02.2026 23:16" → "2026-02-07",
               "Feb 7, 2026" → "2026-02-07".

  7. ANY OTHER SCREEN → all fields null.

Field guide (formats):
- governorId: numeric ID following "Правитель" / "Governor" — usually
  shown as "(ID: 187562040)". Return just the digits: "187562040".
- nickname: governor's display name on the profile screen. Strip
  decorative prefix glyphs (⚔ ◇ ✿ etc): "⚔Matumba" → "Matumba".
- power, killPoints, maxValorPoints, t1Kills..t5Kills, deaths,
  food, wood, stone, gold: ALWAYS raw integers as STRINGS, no
  abbreviations: "84M" → "84000000", "1.2B" → "1200000000",
  "330.7K" → "330700".
- Thousand separators: RoK uses ASCII space (0x20), non-breaking
  space (U+00A0), comma, or period between every 3-digit group.
  Read the FULL number end-to-end — every group is part of one
  integer. Never drop the leading group. Examples:
    "77 676 008"     → "77676008"   (NOT "676008")
    "1 796 955 517"  → "1796955517" (NOT "955517" or "796955517")
    "330 700"        → "330700"
    "7 191 564"      → "7191564"
  If you see digit groups separated by spaces, all groups belong
  to the same number; the leftmost group is the most significant.
- Cyrillic suffix letters (К/М/Б/В/Т) and Latin (K/M/B/T) denote
  thousand / million / billion / trillion respectively.
- vipLevel: a small integer as string ("14").
- speedups: duration string in English short form, omit zero units:
  "63d 12h 20m", "5h", "20m". Universal can be "340d 18h 56m".
- isScoutCommander: a JSON boolean (true/false), not a string.
- accountBornAt: ISO calendar date string "YYYY-MM-DD" or null.

Output requirements:
- Respond with EXACTLY ONE JSON object.
- Every field MUST be present as a key. Missing → null, not absent.
- All numeric fields are strings, never JSON numbers.
- isScoutCommander is the ONLY boolean field; everything else is
  string-or-null.
- No commentary, no markdown code fences. Just the raw JSON.`;

function emptyResult(): ParsedRokScreen {
  const stringFields = Object.fromEntries(
    PARSED_STRING_KEYS.map((k) => [k, null]),
  );
  return {
    ...stringFields,
    isScoutCommander: null,
  } as unknown as ParsedRokScreen;
}

function stripCodeFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

interface ChatContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

interface ChatChoice {
  message: { content: string };
  finish_reason: string;
}

interface ChatResponse {
  choices: ChatChoice[];
  error?: { message: string; code?: number };
}

async function callTarget(
  target: ProviderTarget,
  imageDataUrl: string,
): Promise<ParsedRokScreen> {
  const userContent: ChatContent[] = [
    { type: "text", text: "Extract the RoK fields from this screenshot." },
    { type: "image_url", image_url: { url: imageDataUrl } },
  ];

  const res = await fetch(target.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${target.apiKey}`,
      ...(target.extraHeaders ?? {}),
    },
    body: JSON.stringify({
      model: target.model,
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`upstream_${res.status}: ${text.slice(0, 300)}`);
  }

  const body = (await res.json()) as ChatResponse;
  if (body.error) {
    throw new Error(`upstream_error: ${body.error.message}`);
  }
  const raw = body.choices?.[0]?.message?.content;
  if (!raw) throw new Error("empty_response");

  const cleaned = stripCodeFences(raw);
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    throw new Error(`non_json: ${cleaned.slice(0, 200)}`);
  }

  const filled = { ...emptyResult(), ...(json as object) };
  return responseSchema.parse(filled);
}

/**
 * Run the universal RoK extractor over a single image. Cascades through
 * the configured providers (Groq → OpenRouter) — first one that returns
 * a usable JSON wins. Retries on 4xx (model rotation), 5xx, quota and
 * transient JSON-parse hiccups; fails fast on auth / our own bugs.
 */
export async function extractRokScreen(args: {
  imageData: Buffer;
  mimeType: string;
}): Promise<ParsedRokScreen> {
  const targets = buildTargets();
  if (targets.length === 0) {
    throw new Error("no_ocr_provider_configured");
  }
  const dataUrl = `data:${args.mimeType};base64,${args.imageData.toString(
    "base64",
  )}`;
  const errors: string[] = [];
  for (const target of targets) {
    try {
      return await callTarget(target, dataUrl);
    } catch (err) {
      const msg = (err as Error).message ?? "unknown";
      errors.push(`${target.label}: ${msg.slice(0, 200)}`);
      // Zod errors mean the model returned an unexpected shape — try
      // the next provider rather than bouncing the whole request.
      const isZodError = err instanceof z.ZodError;
      const retryable =
        isZodError ||
        /upstream_4\d\d|upstream_5\d\d|no\s*endpoints|quota|timeout|empty_response|non_json|rate.?limit|invalid.?input/i.test(
          msg,
        );
      if (!retryable) throw err;
    }
  }
  throw new Error(`all_ocr_models_failed: ${errors.join(" | ")}`);
}
