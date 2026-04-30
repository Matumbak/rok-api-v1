/**
 * Parse Rise-of-Kingdoms-style abbreviated numbers into a plain Number.
 * Handles every format RoK players paste — case-insensitive, mixed
 * separators, Cyrillic suffix letters from the RU client.
 *
 * Suffix table (case-insensitive, Latin or Cyrillic):
 *   K / К       thousand
 *   M / М       million
 *   B / G / Б / В   billion
 *   T / Т       trillion
 *
 * Examples (all parse correctly):
 *
 *   "84M"            → 84_000_000
 *   "84.2M"          → 84_200_000
 *   "84,2M"          → 84_200_000   (Russian decimal comma)
 *   "84,2м"          → 84_200_000   (Cyrillic м)
 *   "1.2B"  / "1.2b" → 1_200_000_000
 *   "1,2В"           → 1_200_000_000 (Cyrillic В looks like Latin B)
 *   "1.4t"           → 1_400_000_000_000
 *   "1,234,567"      → 1_234_567
 *   "1 234 567"      → 1_234_567   (regular space or NBSP)
 *   "1 234 567,89"   → 1_234_567.89 (EU decimal comma)
 *   "1,234,567.89"   → 1_234_567.89 (US dot decimal)
 *   "2000000"        → 2_000_000
 *   "84"             → 84
 *   ""  / null       → null
 *
 * Anything that can't be coerced returns `null` — the raw string is
 * preserved separately so admin can correct by hand.
 */

const SUFFIX: Record<string, number> = {
  K: 1e3,
  M: 1e6,
  B: 1e9,
  G: 1e9,
  T: 1e12,
};

/** Cyrillic letters the RU client uses for K/M/B/T (and the В that looks
 *  identical to Latin B in the engraved game font). */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  К: "K",
  М: "M",
  Б: "B",
  В: "B",
  Т: "T",
};

const SUFFIX_RE = /[KMBGTkmbgtКкМмБбВвТт]$/;

export function parseRokNumber(input: string | null | undefined): number | null {
  if (input == null) return null;
  // NBSP → space, then trim.
  let s = input.replace(/ /g, " ").trim();
  if (s.length === 0) return null;

  // Pull off the optional KMBGT suffix. Accepts Latin and Cyrillic, upper
  // and lower case; both letter cases are upper-cased first, then any
  // Cyrillic equivalent is mapped to its Latin twin so we can look up
  // the multiplier by a single key.
  let multiplier = 1;
  const m = s.match(SUFFIX_RE);
  if (m) {
    const upper = m[0].toUpperCase();
    const latin = CYRILLIC_TO_LATIN[upper] ?? upper;
    if (!(latin in SUFFIX)) return null;
    multiplier = SUFFIX[latin];
    s = s.slice(0, -1).trimEnd();
  }

  if (s.length === 0) return null;

  // Body must contain only digits, spaces and [.,] — anything else is junk.
  if (!/^-?[\d\s.,]+$/.test(s)) return null;

  const base = parseNumberBody(s);
  if (base == null) return null;
  return base * multiplier;
}

/**
 * Parse a number body like "1,234,567.89" / "1.234.567,89" / "1 234 567" /
 * "84,2" / "84200000". Detects the decimal separator from context: the
 * LAST `.` or `,` is treated as a decimal point only when 1–2 digits
 * follow it; otherwise all separators are thousand markers.
 */
function parseNumberBody(body: string): number | null {
  const stripped = body.replace(/\s+/g, "");
  if (stripped.length === 0) return null;

  const lastDot = stripped.lastIndexOf(".");
  const lastComma = stripped.lastIndexOf(",");
  const lastSep = Math.max(lastDot, lastComma);

  if (lastSep === -1) {
    const n = Number.parseFloat(stripped);
    return Number.isFinite(n) ? n : null;
  }

  const trailing = stripped.length - lastSep - 1;
  if (trailing >= 1 && trailing <= 2) {
    // Decimal separator: keep the last [.,] as `.`, drop the rest.
    const before = stripped.slice(0, lastSep).replace(/[.,]/g, "");
    const after = stripped.slice(lastSep + 1);
    const n = Number.parseFloat(`${before}.${after}`);
    return Number.isFinite(n) ? n : null;
  }

  // 3+ digits after last separator → all separators are thousand markers.
  const n = Number.parseFloat(stripped.replace(/[.,]/g, ""));
  return Number.isFinite(n) ? n : null;
}
