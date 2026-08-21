import { safeExternalUrl } from "../utils/external-url";

export const MAX_SHARE_BYTES = 128 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 50_000;
const MAX_TABLE_COLUMNS = 20;
const MAX_TABLE_ROWS = 200;
const MAX_CHART_SERIES = 20;
const MAX_CHART_POINTS = 500;

type CellValue = string | number | boolean | null;

export interface TableShareData {
  title: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, CellValue>>;
  sourceUrl?: string;
}

export interface ChartShareData {
  title: string;
  series: Array<{
    name: string;
    points: Array<{ x: string | number; y: number }>;
  }>;
  sourceUrl?: string;
}

export interface ArticleShareData {
  title: string;
  text: string;
  sourceUrl?: string;
}

export type SharePayload =
  | { kind: "table"; data: TableShareData }
  | { kind: "chart"; data: ChartShareData }
  | { kind: "article"; data: ArticleShareData };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function shortString(value: unknown, max = MAX_TITLE_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function safeOptionalUrl(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && safeExternalUrl(value) !== null);
}

function isCell(value: unknown): value is CellValue {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isTableData(value: unknown): value is TableShareData {
  if (!record(value) || !shortString(value.title) || !safeOptionalUrl(value.sourceUrl)) return false;
  if (!Array.isArray(value.columns) || value.columns.length === 0 || value.columns.length > MAX_TABLE_COLUMNS) return false;
  const keys = new Set<string>();
  for (const column of value.columns) {
    if (!record(column) || !shortString(column.key, 80) || !shortString(column.label, 120) || keys.has(column.key)) return false;
    keys.add(column.key);
  }
  return Array.isArray(value.rows)
    && value.rows.length <= MAX_TABLE_ROWS
    && value.rows.every((row) => record(row)
      && Object.keys(row).every((key) => keys.has(key))
      && Object.values(row).every(isCell));
}

function isChartData(value: unknown): value is ChartShareData {
  if (!record(value) || !shortString(value.title) || !safeOptionalUrl(value.sourceUrl)) return false;
  return Array.isArray(value.series)
    && value.series.length > 0
    && value.series.length <= MAX_CHART_SERIES
    && value.series.every((series) => record(series)
      && shortString(series.name, 120)
      && Array.isArray(series.points)
      && series.points.length > 0
      && series.points.length <= MAX_CHART_POINTS
      && series.points.every((point) => record(point)
        && ((typeof point.x === "string" && point.x.length <= 100) || (typeof point.x === "number" && Number.isFinite(point.x)))
        && typeof point.y === "number"
        && Number.isFinite(point.y)));
}

function isArticleData(value: unknown): value is ArticleShareData {
  return record(value)
    && shortString(value.title)
    && typeof value.text === "string"
    && value.text.length <= MAX_TEXT_LENGTH
    && safeOptionalUrl(value.sourceUrl);
}

export function parseSharePayload(value: unknown): SharePayload | null {
  if (!record(value) || !shortString(value.kind, 20) || !("data" in value)) return null;
  let json: string;
  try { json = JSON.stringify(value); } catch { return null; }
  if (new TextEncoder().encode(json).byteLength > MAX_SHARE_BYTES) return null;
  if (value.kind === "table" && isTableData(value.data)) return value as unknown as SharePayload;
  if (value.kind === "chart" && isChartData(value.data)) return value as unknown as SharePayload;
  if (value.kind === "article" && isArticleData(value.data)) return value as unknown as SharePayload;
  return null;
}
