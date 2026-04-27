import xlsx from "xlsx";

const { read, utils } = xlsx;

export type DkpColumnType = "number" | "percent" | "string";

export type DkpColumn = {
  /** Stable key used by the API (matches `label` for now). */
  key: string;
  /** Original header from the source file. */
  label: string;
  type: DkpColumnType;
  /** Whether sort is allowed on this column. True for native + numeric. */
  sortable: boolean;
  /** Display order (smaller = leftmost). */
  order: number;
  /** Native = stored in its own column on `DkpRow`. */
  native: boolean;
};

export type ParsedRow = {
  rank: number;
  governorId: string;
  nickname: string;
  alliance: string;
  /** All non-native fields keyed by their original label. Numbers become strings. */
  data: Record<string, string | number | null>;
};

export type ParseResult =
  | {
      ok: true;
      columns: DkpColumn[];
      rows: ParsedRow[];
      total: number;
    }
  | { ok: false; error: string };

/* ── header aliases for the four "must-have" native fields ─────────── */
const NATIVE_ALIASES: Record<"governorId" | "nickname" | "alliance", string[]> = {
  governorId: ["Gov ID", "Governor ID", "ID", "Player ID"],
  nickname: ["Name", "Nickname", "Governor", "Player"],
  alliance: ["Alliance", "Tag", "Guild"],
};

/* ── helpers ───────────────────────────────────────────────────────── */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const findHeaderIndex = (
  headers: string[],
  candidates: string[],
): number | null => {
  const map = new Map(headers.map((h, i) => [norm(h), i]));
  for (const c of candidates) {
    const i = map.get(norm(c));
    if (i !== undefined) return i;
  }
  return null;
};

const looksNumeric = (raw: unknown): boolean => {
  if (raw == null || raw === "") return false;
  if (typeof raw === "number") return Number.isFinite(raw);
  if (typeof raw === "bigint") return true;
  if (typeof raw === "string") {
    const cleaned = raw.replace(/[, _%]/g, "").trim();
    if (cleaned === "" || cleaned === "-") return false;
    return /^-?\d+(\.\d+)?$/.test(cleaned);
  }
  return false;
};

const stringifyNumeric = (raw: unknown): string | null => {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return String(Math.trunc(raw));
  if (typeof raw === "bigint") return raw.toString();
  if (typeof raw === "string") {
    const cleaned = raw.replace(/[, _%]/g, "").trim();
    if (cleaned === "" || cleaned === "-") return null;
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    return String(Math.trunc(Number(cleaned)));
  }
  return null;
};

const detectType = (label: string, sample: unknown[]): DkpColumnType => {
  // explicit hint from the header text
  if (/(reached|ratio|percent|%|rate)\b/i.test(label)) return "percent";

  const nonEmpty = sample.filter((v) => v != null && v !== "");
  if (nonEmpty.length === 0) return "string";
  const numericCount = nonEmpty.filter(looksNumeric).length;
  // require ≥80% of sampled values to be numeric for a numeric type
  if (numericCount / nonEmpty.length >= 0.8) return "number";
  return "string";
};

/* ── main parser ───────────────────────────────────────────────────── */

export function parseDkpXlsx(buffer: Buffer): ParseResult {
  let wb;
  try {
    wb = read(buffer, { type: "buffer" });
  } catch {
    return { ok: false, error: "could_not_read_xlsx" };
  }

  const sheetName =
    wb.SheetNames.find((n) => /performance|player|dkp/i.test(n)) ??
    wb.SheetNames[0];
  if (!sheetName) return { ok: false, error: "no_sheets" };

  const ws = wb.Sheets[sheetName];
  const aoa = utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
  if (aoa.length < 2) return { ok: false, error: "empty_sheet" };

  // header row = first row with ≥5 non-empty string cells
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(10, aoa.length); i++) {
    const row = aoa[i];
    const stringCells = row.filter(
      (c) => typeof c === "string" && c.trim().length > 0,
    ).length;
    if (stringCells >= 5) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) return { ok: false, error: "no_header_row" };

  const headerRow = aoa[headerRowIdx].map((c) =>
    c == null ? "" : String(c).trim(),
  );

  const govIdIdx = findHeaderIndex(headerRow, NATIVE_ALIASES.governorId);
  const nicknameIdx = findHeaderIndex(headerRow, NATIVE_ALIASES.nickname);
  const allianceIdx = findHeaderIndex(headerRow, NATIVE_ALIASES.alliance);

  if (govIdIdx == null || nicknameIdx == null) {
    return {
      ok: false,
      error: `missing_required_columns: ${[
        govIdIdx == null && "Gov ID",
        nicknameIdx == null && "Name",
      ]
        .filter(Boolean)
        .join(", ")}`,
    };
  }

  // sample non-native columns to detect types
  const dataRows = aoa.slice(headerRowIdx + 1);
  const sampleSize = Math.min(30, dataRows.length);
  const samples: unknown[][] = headerRow.map(() => []);
  for (let i = 0; i < sampleSize; i++) {
    const r = dataRows[i] ?? [];
    headerRow.forEach((_, c) => {
      samples[c].push(r[c]);
    });
  }

  // build column metadata
  const columns: DkpColumn[] = [];

  // native four (always present + always at the front)
  columns.push({
    key: "rank",
    label: "Rank",
    type: "number",
    sortable: true,
    order: 0,
    native: true,
  });
  columns.push({
    key: "nickname",
    label: "Governor",
    type: "string",
    sortable: true,
    order: 1,
    native: true,
  });
  if (allianceIdx != null) {
    columns.push({
      key: "alliance",
      label: "Alliance",
      type: "string",
      sortable: true,
      order: 2,
      native: true,
    });
  }

  // every other column from the file, in original order
  let nextOrder = 3;
  const skipIdxs = new Set<number>([govIdIdx, nicknameIdx]);
  if (allianceIdx != null) skipIdxs.add(allianceIdx);

  for (let i = 0; i < headerRow.length; i++) {
    if (skipIdxs.has(i)) continue;
    const label = headerRow[i];
    if (!label) continue;
    const type = detectType(label, samples[i]);
    columns.push({
      key: label, // use label as-is; admin types this once on upload
      label,
      type,
      sortable: type !== "string", // numeric/percent sortable; string off by default
      order: nextOrder++,
      native: false,
    });
  }

  // build rows
  const rows: ParsedRow[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    if (!r || r.every((c) => c == null || c === "")) continue;

    const governorId =
      r[govIdIdx] == null ? null : String(r[govIdIdx]).trim();
    const nickname =
      r[nicknameIdx] == null ? null : String(r[nicknameIdx]).trim();
    if (!governorId || !nickname) continue;

    const alliance =
      allianceIdx != null && r[allianceIdx] != null
        ? String(r[allianceIdx]).trim()
        : "";

    const data: Record<string, string | number | null> = {};
    for (let c = 0; c < headerRow.length; c++) {
      if (skipIdxs.has(c)) continue;
      const label = headerRow[c];
      if (!label) continue;
      const raw = r[c];
      const col = columns.find((x) => x.label === label);
      if (col?.type === "number" || col?.type === "percent") {
        data[label] = stringifyNumeric(raw); // store as string; ::REAL on sort
      } else {
        data[label] = raw == null ? null : String(raw);
      }
    }

    rows.push({
      rank: 0,
      governorId,
      nickname,
      alliance,
      data,
    });
  }

  // re-rank by DKP-like column desc, fallback to first numeric column
  const dkpCol =
    columns.find((c) => /^dkp(\s*score)?$/i.test(c.label)) ??
    columns.find((c) => c.type === "number" && !c.native);

  if (dkpCol) {
    rows.sort((a, b) => {
      const av = Number(a.data[dkpCol.label] ?? 0);
      const bv = Number(b.data[dkpCol.label] ?? 0);
      return bv - av;
    });
  }
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  return {
    ok: true,
    columns,
    rows,
    total: rows.length,
  };
}
