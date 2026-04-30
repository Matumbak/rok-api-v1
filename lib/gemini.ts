import {
  GoogleGenerativeAI,
  SchemaType,
  type Schema,
} from "@google/generative-ai";

/**
 * Universal RoK screenshot OCR via Gemini 2.0 Flash. Replaces the v2
 * Tesseract.js + regex pipeline — Gemini reads the screenshot directly,
 * understands which screen it is (profile / kill-data / details /
 * resources / speedups), and returns a typed JSON object with the
 * fields we care about (others null).
 *
 * Why Flash: free tier covers ≥1500 req/day; vision quality on stylized
 * RoK fonts is dramatically better than Tesseract; structured-output
 * mode returns valid JSON without post-processing.
 */

const API_KEY = process.env.GEMINI_API_KEY;

/** Fields the form / admin care about. Everything is a string so we can
 *  pipe through the same parseRokNumber → normalized Float pipeline as
 *  before. */
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

const NULLABLE_STRING: Schema = {
  type: SchemaType.STRING,
  nullable: true,
};

/** JSON schema enforced by Gemini structured output. */
const RESPONSE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    power: NULLABLE_STRING,
    killPoints: NULLABLE_STRING,
    vipLevel: NULLABLE_STRING,
    t1Kills: NULLABLE_STRING,
    t2Kills: NULLABLE_STRING,
    t3Kills: NULLABLE_STRING,
    t4Kills: NULLABLE_STRING,
    t5Kills: NULLABLE_STRING,
    deaths: NULLABLE_STRING,
    maxValorPoints: NULLABLE_STRING,
    food: NULLABLE_STRING,
    wood: NULLABLE_STRING,
    stone: NULLABLE_STRING,
    gold: NULLABLE_STRING,
    speedupsConstruction: NULLABLE_STRING,
    speedupsResearch: NULLABLE_STRING,
    speedupsTraining: NULLABLE_STRING,
    speedupsHealing: NULLABLE_STRING,
    speedupsUniversal: NULLABLE_STRING,
  },
  required: [
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
  ],
};

/**
 * The instruction prompt is shared across all screen types — Gemini is
 * smart enough to figure out what screen it sees and only fill the
 * relevant fields. The other fields stay null. Calibrated against the
 * five reference screenshots from the Russian client:
 *
 *   1. Профиль правителя       — power, killPoints, maxValorPoints
 *   2. Данные по убийствам     — t1Kills..t5Kills
 *   3. Подробнее → Войска      — deaths
 *   4. Ваши ресурсы (resources) — food, wood, stone, gold from FIRST col
 *   5. Ваши ресурсы (speedups)  — speedupsConstruction..Universal
 */
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
values. Never abbreviate. Output ONLY the JSON object — no commentary.`;

/**
 * Run the universal RoK extractor over a single image. Throws on
 * configuration / network / quota errors — caller wraps in try/catch.
 */
export async function extractRokScreen(args: {
  imageData: Buffer;
  mimeType: string;
}): Promise<ParsedRokScreen> {
  if (!API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
    },
  });

  const result = await model.generateContent([
    SYSTEM_PROMPT,
    {
      inlineData: {
        data: args.imageData.toString("base64"),
        mimeType: args.mimeType,
      },
    },
  ]);

  const text = result.response.text();
  let parsed: ParsedRokScreen;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`gemini_returned_non_json: ${text.slice(0, 200)}`);
  }
  return parsed;
}
