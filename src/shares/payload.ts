import {
  parseMarketplaceLayoutPayload,
  type LayoutMarketplacePayload,
} from "../layout-marketplace/payload";
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
    unit?: string;
    style?: "line" | "step" | "points";
    points: Array<{ x: string | number; y: number | null }>;
  }>;
  viewport?: { start: string; end: string };
  warnings?: string[];
  sourceUrl?: string;
}

export interface ArticleShareData {
  title: string;
  text: string;
  sourceUrl?: string;
}

export interface LegacyPaneShareData {
  version: 1;
  templateId: string;
  title: string;
  description?: string;
  data: Record<string, ShareJsonValue>;
}

export interface PortablePaneShareData {
  version: 2;
  title: string;
  description?: string;
  layout: LayoutMarketplacePayload;
}

export type PaneShareData = LegacyPaneShareData | PortablePaneShareData;

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

function viewportDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) return false;
  if (match[4] !== undefined) {
    if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59) return false;
    const zone = match[7]!;
    if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return false;
  }
  return Number.isFinite(Date.parse(value));
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
  if (Object.keys(value).some((key) => !["title", "series", "sourceUrl", "viewport", "warnings"].includes(key))) return false;
  if (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.length > 20
    || !value.warnings.every((warning) => shortString(warning, 500)))) return false;
  if (value.viewport !== undefined && (!record(value.viewport)
    || Object.keys(value.viewport).some((key) => !["start", "end"].includes(key))
    || !viewportDate(value.viewport.start) || !viewportDate(value.viewport.end)
    || Date.parse(value.viewport.start) > Date.parse(value.viewport.end))) return false;
  return Array.isArray(value.series)
    && value.series.length > 0
    && value.series.length <= MAX_CHART_SERIES
    && value.series.every((series) => record(series)
      && Object.keys(series).every((key) => ["name", "points", "unit", "style"].includes(key))
      && shortString(series.name, 120)
      && (series.unit === undefined || shortString(series.unit, 80))
      && (series.style === undefined || ["line", "step", "points"].includes(series.style as string))
      && Array.isArray(series.points)
      && series.points.length > 0
      && series.points.length <= MAX_CHART_POINTS
      && series.points.every((point) => record(point)
        && Object.keys(point).every((key) => ["x", "y"].includes(key))
        && ((typeof point.x === "string" && point.x.length <= 100) || (typeof point.x === "number" && Number.isFinite(point.x)))
        && (point.y === null || (typeof point.y === "number" && Number.isFinite(point.y)))));
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

function parsePaneData(value: unknown): PaneShareData | null {
  if (!record(value) || !shortString(value.title)) return null;
  if (
    value.version === 1
    && Object.keys(value).every((key) => ["version", "templateId", "title", "description", "data"].includes(key))
    && typeof value.templateId === "string"
    && PANE_TEMPLATE_ID.test(value.templateId)
    && (value.description === undefined || shortString(value.description, MAX_PANE_DESCRIPTION_LENGTH))
    && record(value.data)
    && boundedJson(value.data)
  ) return value as unknown as LegacyPaneShareData;
  if (
    value.version !== 2
    || !Object.keys(value).every((key) => ["version", "title", "description", "layout"].includes(key))
    || (value.description !== undefined && !shortString(value.description, MAX_PANE_DESCRIPTION_LENGTH))
  ) return null;
  const layout = parseMarketplaceLayoutPayload(value.layout);
  return layout?.schemaVersion === 2 && layout.layout.instances.length === 1
    ? {
        version: 2,
        title: value.title,
        ...(value.description === undefined ? {} : { description: value.description }),
        layout,
      }
    : null;
}

export function parseSharePayload(value: unknown): SharePayload | null {
  if (!record(value) || !shortString(value.kind, 20) || !("data" in value)) return null;
  let json: string;
  try { json = JSON.stringify(value); } catch { return null; }
  if (new TextEncoder().encode(json).byteLength > MAX_SHARE_BYTES) return null;
  if (value.kind === "table" && isTableData(value.data)) return value as unknown as SharePayload;
  if (value.kind === "chart" && isChartData(value.data)) return value as unknown as SharePayload;
  if (value.kind === "article" && isArticleData(value.data)) return value as unknown as SharePayload;
  if (value.kind === "pane") {
    const data = parsePaneData(value.data);
    if (data) return { kind: "pane", data };
  }
  return null;
}
