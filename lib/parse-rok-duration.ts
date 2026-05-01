/**
 * Parse the RoK speedup-duration strings users paste into the form
 * (mirroring the format the in-game "Ваши ресурсы и ускорения" modal
 * shows in the right column).
 *
 * Supported shapes (Russian and English, in any order, separators
 * tolerated):
 *
 *   "63 дн. 12 ч 20 м"   → 63 * 1440 + 12 * 60 + 20  =  91 460
 *   "3 дн 20 ч 49 м"     → 5 689
 *   "340 дн 18 ч 56 м"   → 491 156
 *   "63d 12h 20m"        → 91 460
 *   "12 h"               → 720
 *   "20 m"               → 20
 *   ""  / null           → null (no clue, leave for admin to fill)
 *
 * The result is total minutes (Int). Anything we can't parse returns null
 * — the raw string is kept on the side so an admin can correct it.
 */

// `\b` is ASCII-only in JS regex — `\w` doesn't include Cyrillic, so a
// boundary between "ч" and " " never fires, and "63 ч 20 м" silently
// fails. We use a negative-lookahead instead: the unit must NOT be
// followed by another letter (which would mean we're matching a prefix
// of a longer word). Trailing dot, digits, whitespace, or end-of-string
// are all fine.
const NOT_LETTER = /(?![\p{L}])/u;
const DAYS_RE = new RegExp(
  String.raw`(\d+)\s*(?:дней|дня|дн\.?|days?|d)` + NOT_LETTER.source,
  "iu",
);
const HOURS_RE = new RegExp(
  String.raw`(\d+)\s*(?:часов|часа|час|ч\.?|hours?|hrs?|hr|h)` +
    NOT_LETTER.source,
  "iu",
);
const MINUTES_RE = new RegExp(
  String.raw`(\d+)\s*(?:минут[ыа]?|мин\.?|м\.?|minutes?|mins?|m)` +
    NOT_LETTER.source,
  "iu",
);

export function parseRokDuration(
  input: string | null | undefined,
): number | null {
  if (input == null) return null;
  const trimmed = input.replace(/ /g, " ").trim();
  if (trimmed.length === 0) return null;

  // If the input is a bare number, treat it as minutes — that's what the
  // existing v1 form sent for `speedupsMinutes`.
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);

  let total = 0;
  let matched = false;

  const d = trimmed.match(DAYS_RE);
  if (d) {
    total += Number.parseInt(d[1], 10) * 24 * 60;
    matched = true;
  }
  const h = trimmed.match(HOURS_RE);
  if (h) {
    total += Number.parseInt(h[1], 10) * 60;
    matched = true;
  }
  const m = trimmed.match(MINUTES_RE);
  if (m) {
    total += Number.parseInt(m[1], 10);
    matched = true;
  }

  return matched ? total : null;
}
