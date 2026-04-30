/**
 * Parse Rise-of-Kingdoms-style abbreviated numbers into a plain Number.
 * Handles all the formats RoK players actually paste:
 *
 *   "84M"           →  84_000_000
 *   "84.2M"         →  84_200_000
 *   "1.2B"          →  1_200_000_000
 *   "1,234,567"     →  1_234_567
 *   "1 234 567"     →  1_234_567        (NBSP / regular space)
 *   "84"            →  84
 *   "1.4T"          →  1_400_000_000_000
 *   ""  / null      →  null
 *
 * Suffix table:
 *   K  thousand
 *   M  million
 *   B / G  billion
 *   T  trillion
 *
 * Anything that doesn't match returns null — the raw string is still kept,
 * so admin can edit by hand.
 */

const SUFFIX: Record<string, number> = {
  K: 1e3,
  M: 1e6,
  B: 1e9,
  G: 1e9, // some players write "1G"
  T: 1e12,
};

const ABBREVIATED = /^(-?\d+(?:[.,]\d+)?)\s*([KMBGT])$/i;
const PLAIN = /^-?\d[\d\s,.]*$/;

export function parseRokNumber(input: string | null | undefined): number | null {
  if (input == null) return null;
  const trimmed = input
    .replace(/ /g, " ") // NBSP → space
    .trim();
  if (trimmed.length === 0) return null;

  const abbrev = trimmed.match(ABBREVIATED);
  if (abbrev) {
    const base = Number.parseFloat(abbrev[1].replace(",", "."));
    if (!Number.isFinite(base)) return null;
    return base * SUFFIX[abbrev[2].toUpperCase()];
  }

  if (PLAIN.test(trimmed)) {
    // Strip thousand separators (spaces / commas) and parse.
    // Keep one decimal point if present.
    const stripped = trimmed.replace(/[\s,](?=\d)/g, "");
    const n = Number.parseFloat(stripped);
    if (Number.isFinite(n)) return n;
  }

  return null;
}
