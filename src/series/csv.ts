import type { SeriesFrequency, SeriesPoint } from "./types";

/** What a series file says about itself in `# key: value` lines above the data. */
export interface SeriesCsvMetadata {
  name?: string;
  unit?: string;
  frequency?: string;
  group?: string;
  description?: string;
}

export interface SeriesCsvColumn {
  /** The column's header, when the file has a header row. */
  header?: string;
  points: SeriesPoint[];
}

export interface ParsedSeriesCsv {
  metadata: SeriesCsvMetadata;
  /** One per value column, in file order. */
  columns: SeriesCsvColumn[];
}

const METADATA_KEYS = new Set(["name", "unit", "frequency", "group", "description"]);
const DAY_MS = 86_400_000;

function splitRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** Tabs, then semicolons (which leave the comma to decimals), then commas. */
function pickDelimiter(line: string): string {
  if (line.includes("\t")) return "\t";
  return line.includes(";") ? ";" : ",";
}

/** 2024-03-01, 2024-03, 2024, 2024/03/01 and ISO date-times; null for anything else. */
export function parseSeriesCsvDate(value: string): Date | null {
  const text = value.trim();
  let match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (match) return utcDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{4})-(\d{1,2})$/.exec(text);
  if (match) return utcDate(Number(match[1]), Number(match[2]), 1);
  match = /^(\d{4})$/.exec(text);
  if (match) return utcDate(Number(match[1]), 1, 1);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
    const date = new Date(text.replace(" ", "T"));
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

function utcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 ? date : null;
}

/**
 * A number as spreadsheets write one: `1,250.5` with thousands separators,
 * or `1,5` with a decimal comma in a file that is not comma-separated.
 */
function parseNumber(value: string, delimiter: string): number | null {
  let text = value.trim().replace(/^"|"$/g, "").replace(/[\s_]/g, "");
  if (!text || text === "." || /^(?:na|n\/a|null|nan|-)$/i.test(text)) return null;
  if (text.endsWith("%")) text = text.slice(0, -1);
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)) text = text.replaceAll(",", "");
  else if (delimiter !== "," && /^-?\d+,\d+$/.test(text)) text = text.replace(",", ".");
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/**
 * Reads a series file: optional `# name: …`, `# unit: …`, `# frequency: …`,
 * `# group: …` and `# description: …` lines, an optional header row, then one
 * row per date with the date first and one or more value columns. Commas,
 * semicolons and tabs all work as separators, and numbers may use thousands
 * separators or, outside a comma-separated file, a decimal comma. Rows whose
 * date does not parse are skipped; an empty or `.` cell is a missing value.
 */
export function parseSeriesCsv(text: string): ParsedSeriesCsv {
  const metadata: SeriesCsvMetadata = {};
  const rows: string[][] = [];
  let delimiter: string | null = null;
  let headers: string[] | null = null;
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const match = /^#\s*([A-Za-z]+)\s*:\s*(.+)$/.exec(line);
      const key = match?.[1]!.toLowerCase();
      if (key && METADATA_KEYS.has(key)) metadata[key as keyof SeriesCsvMetadata] = match![2]!.trim();
      continue;
    }
    delimiter ??= pickDelimiter(line);
    const cells = splitRow(line, delimiter);
    if (rows.length === 0 && headers === null && !parseSeriesCsvDate(cells[0] ?? "")) {
      headers = cells;
      continue;
    }
    rows.push(cells);
  }
  const width = Math.max(headers?.length ?? 0, ...rows.map((row) => row.length));
  const columns: SeriesCsvColumn[] = [];
  for (let column = 1; column < width; column += 1) {
    const points: SeriesPoint[] = [];
    for (const row of rows) {
      const date = parseSeriesCsvDate(row[0] ?? "");
      if (!date) continue;
      points.push({ date, value: parseNumber(row[column] ?? "", delimiter ?? ",") });
    }
    if (!points.some((point) => point.value !== null)) continue;
    const header = headers?.[column]?.trim();
    columns.push({ ...(header ? { header } : {}), points });
  }
  return { metadata, columns };
}

/** The frequency the spacing of the dates suggests, from their median gap. */
export function inferSeriesFrequency(points: readonly SeriesPoint[]): SeriesFrequency {
  const times = points
    .map((point) => (point.date instanceof Date ? point.date.getTime() : new Date(point.date).getTime()))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index]! - times[index - 1]!;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return "irregular";
  gaps.sort((left, right) => left - right);
  const median = gaps[Math.floor(gaps.length / 2)]! / DAY_MS;
  if (median < 1) return "intraday";
  if (median <= 3.5) return "daily";
  if (median <= 10) return "weekly";
  if (median <= 45) return "monthly";
  if (median <= 120) return "quarterly";
  if (median <= 400) return "annual";
  return "irregular";
}
