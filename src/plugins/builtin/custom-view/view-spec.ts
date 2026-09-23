/**
 * A custom view is a declarative table: where the rows come from, which
 * columns to show, how to filter and sort them, and how to present them.
 * The terminal owns this schema; the server stores specs opaquely, so a new
 * version here never waits on a deploy. Modeled on `chart-composer/chart-spec`.
 */

export const VIEW_SPEC_VERSION = 1;
export const MAX_VIEW_COLUMNS = 24;
export const MAX_VIEW_FILTERS = 12;
export const MAX_VIEW_LIMIT = 2_000;

export type ViewTransform = "raw" | "percent" | "compact" | "abs" | "index100";
export type ViewFilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in" | "exists";
export type ViewPrimitive = string | number | boolean | null;

export interface ViewColumn {
  key: string;
  label?: string;
  align?: "left" | "right" | "center";
  width?: number;
  transform?: ViewTransform;
}

export interface ViewFilter {
  key: string;
  op: ViewFilterOp;
  value?: ViewPrimitive | ViewPrimitive[];
}

export interface ViewSort {
  by: string;
  direction: "asc" | "desc";
}

export type ViewSource =
  | {
    kind: "inline";
    /** A pane template shortcut prefix, template id, or pane id that has a headless loader. */
    pane: string;
    argument?: string;
    options?: Record<string, string | number | boolean>;
  }
  | {
    kind: "ref";
    /** A team view id; the cloud.views capability resolves it to its latest spec. */
    viewId: string;
    teamId?: string;
  };

export interface ViewProjection {
  columns: ViewColumn[];
  filters: ViewFilter[];
  sort?: ViewSort;
  limit?: number;
}

export interface ViewPresentation {
  title?: string;
  density?: "compact" | "regular";
  /** Column key whose value becomes the row's ticker, for follow bindings and open actions. */
  symbolKey?: string;
}

export interface ViewSpec {
  version: typeof VIEW_SPEC_VERSION;
  source: ViewSource;
  projection: ViewProjection;
  presentation: ViewPresentation;
}

export interface ViewSpecIssue {
  path: string;
  code: string;
  message: string;
}

export interface ViewSpecValidationResult {
  valid: boolean;
  errors: ViewSpecIssue[];
  warnings: ViewSpecIssue[];
}

const TRANSFORMS = new Set<ViewTransform>(["raw", "percent", "compact", "abs", "index100"]);
const FILTER_OPS = new Set<ViewFilterOp>(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "exists"]);
const KEY_PATTERN = /^[A-Za-z0-9_.\-:]{1,80}$/;
const PANE_TOKEN_PATTERN = /^[A-Za-z0-9_.\-:]{1,120}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(path: string, code: string, message: string): ViewSpecIssue {
  return { path, code, message };
}

function primitive(value: unknown): value is ViewPrimitive {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function cleanString(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function normalizeColumn(value: unknown): ViewColumn | null {
  if (typeof value === "string") return KEY_PATTERN.test(value) ? { key: value } : null;
  if (!record(value) || typeof value.key !== "string") return null;
  const column: ViewColumn = { key: value.key };
  const label = cleanString(value.label, 80);
  if (label) column.label = label;
  if (value.align === "left" || value.align === "right" || value.align === "center") column.align = value.align;
  if (typeof value.width === "number" && Number.isFinite(value.width)) column.width = Math.round(value.width);
  if (typeof value.transform === "string" && TRANSFORMS.has(value.transform as ViewTransform)) {
    column.transform = value.transform as ViewTransform;
  }
  return column;
}

function normalizeFilter(value: unknown): ViewFilter | null {
  if (!record(value) || typeof value.key !== "string" || typeof value.op !== "string") return null;
  const filter: ViewFilter = { key: value.key, op: value.op as ViewFilterOp };
  if (Array.isArray(value.value)) filter.value = value.value.filter(primitive);
  else if (primitive(value.value)) filter.value = value.value;
  return filter;
}

function normalizeSource(value: unknown): ViewSource | null {
  if (!record(value)) return null;
  if (value.kind === "ref") {
    if (typeof value.viewId !== "string") return null;
    return {
      kind: "ref",
      viewId: value.viewId,
      ...(typeof value.teamId === "string" && value.teamId ? { teamId: value.teamId } : {}),
    };
  }
  if (value.kind !== "inline" && value.kind !== undefined) return null;
  if (typeof value.pane !== "string") return null;
  const source: ViewSource = { kind: "inline", pane: value.pane.trim() };
  const argument = cleanString(value.argument, 500);
  if (argument) source.argument = argument;
  if (record(value.options)) {
    const options: Record<string, string | number | boolean> = {};
    for (const [key, entry] of Object.entries(value.options)) {
      if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") options[key] = entry;
    }
    if (Object.keys(options).length > 0) source.options = options;
  }
  return source;
}

/** Fills defaults and drops junk without judging; `validateViewSpec` judges. */
export function normalizeViewSpec(value: unknown): ViewSpec {
  const raw = record(value) ? value : {};
  const projectionRaw = record(raw.projection) ? raw.projection : {};
  const presentationRaw = record(raw.presentation) ? raw.presentation : {};
  const columns = Array.isArray(projectionRaw.columns)
    ? projectionRaw.columns.map(normalizeColumn).filter((column): column is ViewColumn => column !== null)
    : [];
  const filters = Array.isArray(projectionRaw.filters)
    ? projectionRaw.filters.map(normalizeFilter).filter((filter): filter is ViewFilter => filter !== null)
    : Array.isArray(projectionRaw.filter)
      ? projectionRaw.filter.map(normalizeFilter).filter((filter): filter is ViewFilter => filter !== null)
      : [];
  const sortRaw = record(projectionRaw.sort) ? projectionRaw.sort : null;
  const sort: ViewSort | undefined = sortRaw && typeof sortRaw.by === "string"
    ? { by: sortRaw.by, direction: sortRaw.direction === "asc" ? "asc" : "desc" }
    : undefined;
  const limit = typeof projectionRaw.limit === "number" && Number.isFinite(projectionRaw.limit)
    ? Math.round(projectionRaw.limit)
    : undefined;
  const presentation: ViewPresentation = {};
  const title = cleanString(presentationRaw.title, 80);
  if (title) presentation.title = title;
  if (presentationRaw.density === "compact" || presentationRaw.density === "regular") presentation.density = presentationRaw.density;
  const symbolKey = cleanString(presentationRaw.symbolKey, 80);
  if (symbolKey) presentation.symbolKey = symbolKey;
  return {
    version: typeof raw.version === "number" ? (raw.version as typeof VIEW_SPEC_VERSION) : VIEW_SPEC_VERSION,
    source: normalizeSource(raw.source) ?? { kind: "inline", pane: "" },
    projection: { columns, filters, ...(sort ? { sort } : {}), ...(limit !== undefined ? { limit } : {}) },
    presentation,
  };
}

export function validateViewSpec(spec: ViewSpec): ViewSpecValidationResult {
  const errors: ViewSpecIssue[] = [];
  const warnings: ViewSpecIssue[] = [];
  if (spec.version !== VIEW_SPEC_VERSION) {
    errors.push(issue("version", "unsupported-version", `Unsupported view spec version ${String(spec.version)}.`));
  }
  if (spec.source.kind === "inline") {
    if (!spec.source.pane || !PANE_TOKEN_PATTERN.test(spec.source.pane)) {
      errors.push(issue("source.pane", "missing-pane", "A source pane token is required."));
    }
  } else if (!spec.source.viewId) {
    errors.push(issue("source.viewId", "missing-view", "A referenced view needs an id."));
  }
  if (spec.projection.columns.length > MAX_VIEW_COLUMNS) {
    errors.push(issue("projection.columns", "too-many-columns", `A view shows at most ${MAX_VIEW_COLUMNS} columns.`));
  }
  const seen = new Set<string>();
  spec.projection.columns.forEach((column, index) => {
    if (!KEY_PATTERN.test(column.key)) errors.push(issue(`projection.columns.${index}.key`, "invalid-key", `Invalid column key ${column.key}.`));
    if (seen.has(column.key)) warnings.push(issue(`projection.columns.${index}.key`, "duplicate-key", `Column ${column.key} appears twice.`));
    seen.add(column.key);
    if (column.width !== undefined && (column.width < 2 || column.width > 80)) {
      errors.push(issue(`projection.columns.${index}.width`, "invalid-width", "Column width must be between 2 and 80."));
    }
  });
  if (spec.projection.filters.length > MAX_VIEW_FILTERS) {
    errors.push(issue("projection.filters", "too-many-filters", `A view applies at most ${MAX_VIEW_FILTERS} filters.`));
  }
  spec.projection.filters.forEach((filter, index) => {
    const path = `projection.filters.${index}`;
    if (!KEY_PATTERN.test(filter.key)) errors.push(issue(`${path}.key`, "invalid-key", `Invalid filter key ${filter.key}.`));
    if (!FILTER_OPS.has(filter.op)) errors.push(issue(`${path}.op`, "invalid-op", `Unknown filter operator ${String(filter.op)}.`));
    if (filter.op === "in" && !Array.isArray(filter.value)) errors.push(issue(`${path}.value`, "invalid-value", "The in operator needs a list."));
    if (filter.op !== "exists" && filter.op !== "in" && (filter.value === undefined || Array.isArray(filter.value))) {
      errors.push(issue(`${path}.value`, "invalid-value", `The ${filter.op} operator needs one value.`));
    }
  });
  if (spec.projection.sort && !KEY_PATTERN.test(spec.projection.sort.by)) {
    errors.push(issue("projection.sort.by", "invalid-key", "Invalid sort key."));
  }
  if (spec.projection.limit !== undefined && (spec.projection.limit < 1 || spec.projection.limit > MAX_VIEW_LIMIT)) {
    errors.push(issue("projection.limit", "invalid-limit", `Limit must be between 1 and ${MAX_VIEW_LIMIT}.`));
  }
  return { valid: errors.length === 0, errors, warnings };
}

/** Parses JSON or an object into a valid spec, or null. */
export function parseViewSpec(value: unknown): ViewSpec | null {
  let decoded: unknown = value;
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const spec = normalizeViewSpec(decoded);
  return validateViewSpec(spec).valid ? spec : null;
}

/** Same as parseViewSpec but reports why it failed. */
export function parseViewSpecOr(value: unknown): { spec: ViewSpec; result: ViewSpecValidationResult } | { error: string } {
  let decoded: unknown = value;
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value);
    } catch (error) {
      return { error: `Spec is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const spec = normalizeViewSpec(decoded);
  const result = validateViewSpec(spec);
  if (!result.valid) return { error: result.errors.map((entry) => `${entry.path}: ${entry.message}`).join(" ") };
  return { spec, result };
}

export function serializeViewSpec(spec: ViewSpec): string {
  const result = validateViewSpec(spec);
  if (!result.valid) throw new Error(result.errors.map((entry) => entry.message).join(" "));
  return JSON.stringify(spec);
}

// Projection

export type ViewRow = Record<string, unknown>;

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function matches(row: ViewRow, filter: ViewFilter): boolean {
  const value = row[filter.key];
  switch (filter.op) {
    case "exists":
      return value !== null && value !== undefined && value !== "";
    case "eq":
      return compare(value, filter.value) === 0;
    case "neq":
      return compare(value, filter.value) !== 0;
    case "gt":
      return typeof value === "number" && typeof filter.value === "number" && value > filter.value;
    case "gte":
      return typeof value === "number" && typeof filter.value === "number" && value >= filter.value;
    case "lt":
      return typeof value === "number" && typeof filter.value === "number" && value < filter.value;
    case "lte":
      return typeof value === "number" && typeof filter.value === "number" && value <= filter.value;
    case "contains":
      return typeof value === "string" && typeof filter.value === "string"
        && value.toLowerCase().includes(filter.value.toLowerCase());
    case "in":
      return Array.isArray(filter.value) && filter.value.some((entry) => compare(value, entry) === 0);
    default:
      return true;
  }
}

/** Filters, sorts, and limits rows the way the spec asks. Pure. */
export function applyViewProjection(rows: readonly ViewRow[], projection: ViewProjection, sortOverride?: ViewSort | null): ViewRow[] {
  let result = rows.filter((row) => projection.filters.every((filter) => matches(row, filter)));
  const sort = sortOverride === undefined ? projection.sort : sortOverride ?? undefined;
  if (sort) {
    const direction = sort.direction === "asc" ? 1 : -1;
    result = [...result].sort((a, b) => compare(a[sort.by], b[sort.by]) * direction);
  }
  if (projection.limit !== undefined) result = result.slice(0, projection.limit);
  return result;
}

const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Headless sources hand dates over as ISO timestamps. A midnight stamp is a
 * date, so it reads as YYYY-MM-DD; a real time keeps hours and minutes.
 */
function formatViewString(value: string): string {
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return value;
  const [, date, hours, minutes, seconds = "00", fraction = "", zone] = match;
  const utcOrLocal = !zone || zone === "Z" || /^[+-]00:?00$/.test(zone);
  if (utcOrLocal && hours === "00" && minutes === "00" && seconds === "00" && !/[1-9]/.test(fraction)) return date!;
  return `${date} ${hours}:${minutes}${zone === "Z" ? " UTC" : zone ? ` ${zone}` : ""}`;
}

function naturalDecimals(value: number): number {
  return Number.isInteger(value) ? 0 : Math.abs(value) >= 100 ? 1 : 2;
}

/**
 * One decimal count for a plain numeric column, so a column never mixes
 * "236" with "232.1": the most any of its values would show on its own.
 */
export function viewColumnDecimals(rows: readonly ViewRow[], key: string): number | undefined {
  let decimals: number | undefined;
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    decimals = Math.max(decimals ?? 0, naturalDecimals(value));
    if (decimals === 2) break;
  }
  return decimals;
}

/**
 * A transform's display text, given the raw value, (for index100) the column's
 * first value, and (for plain numbers) the column's decimal count.
 */
export function formatViewValue(value: unknown, transform: ViewTransform | undefined, base?: number, decimals?: number): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "number") return typeof value === "string" ? formatViewString(value) : JSON.stringify(value);
  if (!Number.isFinite(value)) return "";
  switch (transform) {
    case "percent":
      return `${(value * 100).toFixed(2)}%`;
    case "compact":
      return compactNumber(value);
    case "abs":
      return String(Math.abs(value));
    case "index100":
      return base && Number.isFinite(base) && base !== 0 ? (value / base * 100).toFixed(1) : "";
    default:
      return value.toFixed(decimals ?? naturalDecimals(value));
  }
}

function compactNumber(value: number): string {
  const abs = Math.abs(value);
  const units: Array<[number, string]> = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [threshold, suffix] of units) {
    if (abs >= threshold) return `${(value / threshold).toFixed(abs / threshold >= 100 ? 0 : 1)}${suffix}`;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
