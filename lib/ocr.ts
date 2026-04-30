/**
 * OCR for RoK screenshots via OpenRouter.
 *
 * Why not direct Gemini: Google's free-tier quota is geo-restricted —
 * many regions get `limit: 0` even on a fresh AI Studio key. OpenRouter
 * proxies dozens of models behind one OpenAI-compatible API and ships
 * a few of them as `:free` variants without the same regional gates.
 *
 * Default model is `google/gemini-2.0-flash-exp:free` (same Gemini Flash
 * we'd use direct, just routed). If it fails (quota / 5xx), we cascade
 * to Llama 3.2 Vision and Mistral Pixtral free fallbacks. Any of them
 * is dramatically more accurate than Tesseract on the engraved RoK font.
 */

import { z } from "zod";

const API_KEY = process.env.OPENROUTER_API_KEY;
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Try-list. We march down it on each call until one model returns a
 * usable JSON. Strings ending in `:free` are zero-cost on OpenRouter.
 * Override with OPENROUTER_OCR_MODELS=model1,model2 if needed.
 */
const DEFAULT_MODELS = [
  "google/gemini-2.0-flash-exp:free",
  "meta-llama/llama-3.2-11b-vision-instruct:free",
  "mistralai/mistral-small-3.2-24b-instruct:free",
];

function modelList(): string[] {
  const env = process.env.OPENROUTER_OCR_MODELS?.trim();
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  return DEFAULT_MODELS;
}

export interface ParsedRokScreen {
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
}

const PARSED_KEYS = [
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
] as const;

const responseSchema = z.object(
  Object.fromEntries(
    PARSED_KEYS.map((k) => [k, z.string().nullable()]),
  ) as Record<(typeof PARSED_KEYS)[number], z.ZodNullable<z.ZodString>>,
);

const SYSTEM_PROMPT = `You are an OCR for Rise of Kingdoms (RoK) governor screenshots.
The image shows a single screen from the in-game UI in Russian or English.
Identify which screen this is and extract only the fields visible on it;
every other field MUST be null.

Field guide:
- power: governor's current "Мощь" / "Power" — raw integer, no abbreviations.
- killPoints: total "Очки убийств" / "Kill Points" — raw integer.
- vipLevel: VIP level number if shown.
- t1Kills..t5Kills: counts in the "Данные по убийствам" / "Kill Data" popup
  (LEFT column "Убийства" / "Kills"), per tier.
- deaths: "Мертв" / "Dead" troops count from the "Подробнее → Войска" tab.
- maxValorPoints: "Макс. кол-во очк. доблести" / "Max Valor" lifetime value
  from the profile screen — NOT the current valor.
- food, wood, stone, gold: take the FIRST column "От предметов" / "From items"
  on the resources tab — NOT the rightmost "Всего" / "Total" column. These
  are the resources the governor can carry during migration.
- speedupsConstruction, Research, Training, Healing, Universal: durations
  from the "Ускорения" / "Speedups" tab. Format as "Xd Yh Zm" (English
  abbreviations, omit zero units, e.g. "63d 12h 20m" or "5h"). Universal is
  the row labelled simply "Ускорение" / "Speedup" with no qualifier.

Number rules (apply to every numeric field):
- ALWAYS return raw integers, no abbreviations: "84M" → "84000000",
  "1.2B" → "1200000000", "330.7K" → "330700".
- Strip thousand separators (spaces / commas / dots).
- Cyrillic suffix letters (К/М/Б/В/Т) and Latin (K/M/B/T) both denote
  thousand/million/billion/trillion respectively.

If a field isn't visible on this screen, return null for it. Never invent
values. Never abbreviate.

Respond with ONLY a JSON object that has every one of these keys present:
power, killPoints, vipLevel, t1Kills, t2Kills, t3Kills, t4Kills, t5Kills,
deaths, maxValorPoints, food, wood, stone, gold, speedupsConstruction,
speedupsResearch, speedupsTraining, speedupsHealing, speedupsUniversal.
Use null for any key not visible on the screen. No commentary, no
markdown code fences — just the raw JSON.`;

function emptyResult(): ParsedRokScreen {
  return Object.fromEntries(
    PARSED_KEYS.map((k) => [k, null]),
  ) as unknown as ParsedRokScreen;
}

function stripCodeFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

interface OpenRouterContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

interface OpenRouterChoice {
  message: { content: string };
  finish_reason: string;
}

interface OpenRouterResponse {
  choices: OpenRouterChoice[];
  error?: { message: string; code: number };
}

async function callOpenRouter(args: {
  model: string;
  imageDataUrl: string;
}): Promise<ParsedRokScreen> {
  const userContent: OpenRouterContent[] = [
    { type: "text", text: "Extract the RoK fields from this screenshot." },
    { type: "image_url", image_url: { url: args.imageDataUrl } },
  ];

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      // OpenRouter recommends these for analytics + free-tier eligibility.
      "HTTP-Referer": "https://huns-4028.vercel.app",
      "X-Title": "RoK 4028 migration form",
    },
    body: JSON.stringify({
      model: args.model,
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
    throw new Error(`openrouter_${res.status}: ${text.slice(0, 300)}`);
  }

  const body = (await res.json()) as OpenRouterResponse;
  if (body.error) {
    throw new Error(`openrouter_error: ${body.error.message}`);
  }
  const raw = body.choices?.[0]?.message?.content;
  if (!raw) throw new Error("openrouter_empty_response");

  const cleaned = stripCodeFences(raw);
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    throw new Error(`openrouter_non_json: ${cleaned.slice(0, 200)}`);
  }

  // Coerce: missing keys → null. Validates with zod for type safety.
  const filled = { ...emptyResult(), ...(json as object) };
  return responseSchema.parse(filled);
}

/**
 * Run the universal RoK extractor over a single image. Cascades through
 * the model list — first model that returns valid JSON wins.
 */
export async function extractRokScreen(args: {
  imageData: Buffer;
  mimeType: string;
}): Promise<ParsedRokScreen> {
  if (!API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  const dataUrl = `data:${args.mimeType};base64,${args.imageData.toString(
    "base64",
  )}`;
  const errors: string[] = [];
  for (const model of modelList()) {
    try {
      return await callOpenRouter({ model, imageDataUrl: dataUrl });
    } catch (err) {
      const msg = (err as Error).message ?? "unknown";
      errors.push(`${model}: ${msg}`);
      // Only retry on quota / 5xx — for hard parse / auth errors, fail fast.
      if (
        !/429|503|502|timeout|empty_response|non_json/i.test(msg) &&
        !/quota/i.test(msg)
      ) {
        throw err;
      }
    }
  }
  throw new Error(`all_ocr_models_failed: ${errors.join(" | ")}`);
}
