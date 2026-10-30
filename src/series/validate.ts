import type {
  SeriesDefinition,
  SeriesDrawStyle,
  SeriesFrequency,
  SeriesInput,
  SeriesPlacement,
} from "./types";

export const SERIES_FREQUENCIES: readonly SeriesFrequency[] = [
  "intraday", "daily", "weekly", "monthly", "quarterly", "annual", "irregular",
];
const SERIES_INPUTS: readonly SeriesInput[] = ["ticker", "option", "crypto"];
const DRAW_STYLES: readonly SeriesDrawStyle[] = ["line", "area", "step", "columns", "points"];
const PLACEMENTS: readonly SeriesPlacement[] = ["price", "panel"];
const LINE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
/** A chart holds twenty series: the ticker's price and up to sixteen lines, with room for a few more. */
const MAX_SERIES_LINES = 16;

/** Units with no scale: a percentage of something, not a quantity of it. */
const RATE_UNITS = ["%", "bp", "x", "ratio", "index", "score", "points"] as const;
/** Quantities, which may take a scale ("thousand barrels"). */
const QUANTITY_UNITS = [
  "number", "count", "units", "shares", "contracts", "days", "people", "jobs", "posts", "views", "hours",
  "barrels", "barrels/day", "cubic feet", "MW", "MWh", "TWh", "GWh/day", "tons", "ounces",
  // A hash rate: exahashes per second.
  "EH/s",
  // The instrument's own currency, for a field that applies to any ticker.
  "currency", "currency/share",
] as const;
/** What a price is quoted per: `USD/barrel`, `USD/GPU-hour`, a miner's `USD/PH/s/day`. */
const PER_UNITS = ["share", "barrel", "gallon", "MMBtu", "MWh", "ounce", "ton", "tCO2", "hour", "GPU-hour", "PH/s/day"] as const;
const SCALES = ["thousand", "million", "billion", "trillion"] as const;

const RATE_SET: ReadonlySet<string> = new Set(RATE_UNITS);
const QUANTITY_SET: ReadonlySet<string> = new Set(QUANTITY_UNITS);
const PER_SET: ReadonlySet<string> = new Set(PER_UNITS);
const CURRENCY_CODE = /^[A-Z]{3}$/;

const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const TICKER_PLACEHOLDER = "{ticker}";
const MIN_REFRESH_MS = 60_000;

/** The unit forms `unit` accepts, in one line for an error or a doc. */
export function describeSeriesUnits(): string {
  return `${RATE_UNITS.join(", ")}; ${QUANTITY_UNITS.join(", ")} or a currency code (USD), optionally after `
    + `${SCALES.join(", ")}; or a currency per ${PER_UNITS.join(", ")} (USD/barrel).`;
}

function isQuantityBase(value: string): boolean {
  if (QUANTITY_SET.has(value) || CURRENCY_CODE.test(value)) return true;
  const slash = value.indexOf("/");
  return slash > 0 && CURRENCY_CODE.test(value.slice(0, slash)) && PER_SET.has(value.slice(slash + 1));
}

export function isValidSeriesUnit(unit: string): boolean {
  if (RATE_SET.has(unit)) return true;
  const space = unit.indexOf(" ");
  const scale = space > 0 ? unit.slice(0, space) : "";
  if ((SCALES as readonly string[]).includes(scale)) return isQuantityBase(unit.slice(space + 1));
  return isQuantityBase(unit);
}

/** Splits `namespace:name`; null when the id is not one. */
export function splitSeriesId(id: string): { namespace: string; name: string } | null {
  const separator = id.indexOf(":");
  if (separator < 0) return null;
  const namespace = id.slice(0, separator);
  const name = id.slice(separator + 1);
  return NAMESPACE_PATTERN.test(namespace) && NAME_PATTERN.test(name) ? { namespace, name } : null;
}

/**
 * The words a public label must not contain: the services the registering
 * plugin reaches, taken from its declared hosts (`api.example.com` forbids
 * "example"). A catalog says what a series is, not who serves it.
 *
 * A government host (`api.eia.gov`, `www.ons.gov.uk`) is the agency that
 * publishes the statistic, not a vendor between it and the user, and a
 * series may name its official publisher, so it forbids nothing.
 */
export function hostLabelWords(hosts: readonly string[] = []): string[] {
  const words = new Set<string>();
  for (const host of hosts) {
    const labels = host.trim().toLowerCase().split(".").filter(Boolean);
    if (labels.at(-1) === "gov" || (labels.at(-2) === "gov" && labels.at(-1)?.length === 2)) continue;
    const name = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    if (name && name.length >= 3) words.add(name);
  }
  return [...words];
}

interface SeriesValidationContext {
  /** Words no label may contain; see `hostLabelWords`. */
  forbiddenWords?: readonly string[];
}

const DOMAIN = /\b[a-z0-9-]+\.(?:com|net|org|io|co|ai|dev|app|gov|edu|info|biz)\b/i;
const SOURCE_ID = /\b(?:provider|source|feed):[a-z0-9_-]/i;

function fail(id: unknown, message: string): never {
  throw new Error(`Invalid series ${typeof id === "string" && id ? `"${id}"` : "definition"}: ${message}`);
}

function checkLabel(id: string, field: string, value: unknown, max: number, context: SeriesValidationContext, optional = true): void {
  if (value === undefined && optional) return;
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\t]/.test(value)) {
    fail(id, `${field} must be a single line of 1 to ${max} characters.`);
  }
  if (DOMAIN.test(value) || SOURCE_ID.test(value)) {
    fail(id, `${field} "${value}" names a host or an internal source; say what the data is instead.`);
  }
  const lower = value.toLowerCase();
  const named = context.forbiddenWords?.find((word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower));
  if (named) fail(id, `${field} "${value}" names "${named}", a service the plugin fetches from.`);
}

/**
 * Throws a message naming the series and the problem when a definition
 * cannot be registered: a malformed id, an unknown unit or frequency, a label
 * that names a host or a fetched-from service, or both or neither of `load`
 * and `expression`. Ids are checked for uniqueness by the registry.
 */
export function validateSeriesDefinition(definition: SeriesDefinition, context: SeriesValidationContext = {}): void {
  if (!definition || typeof definition !== "object") fail(undefined, "expected an object.");
  const { id } = definition;
  if (typeof id !== "string" || !splitSeriesId(id)) {
    fail(id, "id must be namespace:name, with a lower-case namespace and letters, digits, \".\", \"_\" or \"-\".");
  }
  checkLabel(id, "name", definition.name, 120, context, false);
  if (typeof definition.unit !== "string" || !isValidSeriesUnit(definition.unit)) {
    fail(id, `unit "${String(definition.unit)}" is not one of: ${describeSeriesUnits()}`);
  }
  if (!SERIES_FREQUENCIES.includes(definition.frequency)) {
    fail(id, `frequency must be one of ${SERIES_FREQUENCIES.join(", ")}.`);
  }
  checkLabel(id, "group", definition.group, 32, context);
  checkLabel(id, "description", definition.description, 300, context);
  checkLabel(id, "publisher", definition.publisher, 60, context);
  checkLabel(id, "limitation", definition.limitation, 160, context);
  if (definition.tags !== undefined) {
    if (!Array.isArray(definition.tags) || definition.tags.length > 16) fail(id, "tags must be a list of at most 16 words.");
    for (const tag of definition.tags) checkLabel(id, "tag", tag, 40, context, false);
  }
  if (definition.url !== undefined && (typeof definition.url !== "string" || !/^https?:\/\/\S+$/.test(definition.url))) {
    fail(id, "url must be an http or https address.");
  }
  if (definition.input !== undefined && !SERIES_INPUTS.includes(definition.input)) {
    fail(id, `input must be one of ${SERIES_INPUTS.join(", ")}.`);
  }
  if (definition.placement !== undefined) {
    if (!PLACEMENTS.includes(definition.placement)) fail(id, `placement must be one of ${PLACEMENTS.join(", ")}.`);
    if (definition.placement === "price" && definition.input !== "ticker") {
      fail(id, "placement price needs a ticker input: the series is drawn over that ticker's price.");
    }
  }
  const hasLoad = typeof definition.load === "function";
  const hasExpression = definition.expression !== undefined;
  if (hasLoad === hasExpression) fail(id, "give exactly one of load or expression.");
  if (hasExpression) {
    const expression = definition.expression;
    if (typeof expression !== "string" || !expression.trim() || expression.length > 200 || /[;,\n]/.test(expression)) {
      fail(id, "expression must be one chart series, such as FRED:UNRATE or {ticker}:close.");
    }
    if (expression.includes(TICKER_PLACEHOLDER) !== (definition.input !== undefined)) {
      fail(id, definition.input
        ? `an expression with an input must contain ${TICKER_PLACEHOLDER}.`
        : `${TICKER_PLACEHOLDER} needs an input.`);
    }
    return;
  }
  const loaded = definition as Extract<SeriesDefinition, { load: unknown }>;
  if (loaded.refreshMs !== undefined && (!Number.isFinite(loaded.refreshMs) || loaded.refreshMs < MIN_REFRESH_MS)) {
    fail(id, `refreshMs must be at least ${MIN_REFRESH_MS}.`);
  }
  if (loaded.style !== undefined && !DRAW_STYLES.includes(loaded.style)) {
    fail(id, `style must be one of ${DRAW_STYLES.join(", ")}.`);
  }
  if (loaded.color !== undefined && (typeof loaded.color !== "string" || !COLOR_PATTERN.test(loaded.color))) {
    fail(id, "color must be #rrggbb.");
  }
  if (loaded.lines !== undefined) {
    if (!Array.isArray(loaded.lines) || loaded.lines.length === 0 || loaded.lines.length > MAX_SERIES_LINES) {
      fail(id, `lines must be a list of 1 to ${MAX_SERIES_LINES} lines.`);
    }
    const ids = new Set<string>();
    for (const line of loaded.lines) {
      if (!line || typeof line.id !== "string" || !LINE_ID_PATTERN.test(line.id) || ids.has(line.id)) {
        fail(id, "each line needs its own id of letters, digits, \".\", \"_\" or \"-\".");
      }
      ids.add(line.id);
      checkLabel(id, "line name", line.name, 60, context, false);
      if (line.style !== undefined && !DRAW_STYLES.includes(line.style)) {
        fail(id, `line style must be one of ${DRAW_STYLES.join(", ")}.`);
      }
      if (line.color !== undefined && (typeof line.color !== "string" || !COLOR_PATTERN.test(line.color))) {
        fail(id, "line color must be #rrggbb.");
      }
    }
    for (const line of loaded.lines) {
      if (line.fill !== undefined && (line.fill === line.id || !ids.has(line.fill))) {
        fail(id, `line ${line.id} fills to ${String(line.fill)}, which is not another of its lines.`);
      }
    }
  }
}

/**
 * Checks a definition and returns it, so a plugin's static list fails where it
 * is written: `series: [defineSeries({ ... })]`.
 */
export function defineSeries<T extends SeriesDefinition>(definition: T): T {
  validateSeriesDefinition(definition);
  return definition;
}

export { TICKER_PLACEHOLDER };
