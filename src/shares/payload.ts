import { safeExternalUrl } from "../utils/external-url";

export const MAX_SHARE_BYTES = 128 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 50_000;
const MAX_TABLE_COLUMNS = 20;
const MAX_TABLE_ROWS = 200;
const MAX_CHART_SERIES = 20;
const MAX_CHART_POINTS = 500;
const MAX_PANE_DESCRIPTION_LENGTH = 500;
const MAX_PANE_DATA_DEPTH = 8;
const MAX_PANE_OBJECT_KEYS = 64;
const MAX_PANE_ARRAY_ITEMS = 5_000;
const MAX_PANE_STRING_LENGTH = 4_096;
const PANE_TEMPLATE_ID = /^[a-z0-9][a-z0-9._:-]{0,119}$/;

type CellValue = string | number | boolean | null;
export type ShareJsonValue = CellValue | ShareJsonValue[] | { [key: string]: ShareJsonValue };

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

export interface PaneShareData {
  version: 1;
  templateId: string;
  title: string;
  description?: string;
  data: Record<string, ShareJsonValue>;
}

export type SharePayload =
  | { kind: "table"; data: TableShareData }
  | { kind: "chart"; data: ChartShareData }
  | { kind: "article"; data: ArticleShareData }
  | { kind: "pane"; data: PaneShareData };

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

function boundedJson(value: unknown, depth = 0): value is ShareJsonValue {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= MAX_PANE_STRING_LENGTH;
  if (depth >= MAX_PANE_DATA_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.length <= MAX_PANE_ARRAY_ITEMS && value.every((entry) => boundedJson(entry, depth + 1));
  }
  if (!record(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_PANE_OBJECT_KEYS && entries.every(([, entry]) => boundedJson(entry, depth + 1));
}

function isPaneData(value: unknown): value is PaneShareData {
  return record(value)
    && Object.keys(value).every((key) => ["version", "templateId", "title", "description", "data"].includes(key))
    && value.version === 1
    && typeof value.templateId === "string"
    && PANE_TEMPLATE_ID.test(value.templateId)
    && shortString(value.title)
    && (value.description === undefined || shortString(value.description, MAX_PANE_DESCRIPTION_LENGTH))
    && record(value.data)
    && boundedJson(value.data);
}

export function parseSharePayload(value: unknown): SharePayload | null {
  if (!record(value) || !shortString(value.kind, 20) || !("data" in value)) return null;
  let json: string;
  try { json = JSON.stringify(value); } catch { return null; }
  if (new TextEncoder().encode(json).byteLength > MAX_SHARE_BYTES) return null;
  if (value.kind === "table" && isTableData(value.data)) return value as unknown as SharePayload;
  if (value.kind === "chart" && isChartData(value.data)) return value as unknown as SharePayload;
  if (value.kind === "article" && isArticleData(value.data)) return value as unknown as SharePayload;
  if (value.kind === "pane" && isPaneData(value.data)) return value as unknown as SharePayload;
  return null;
}
