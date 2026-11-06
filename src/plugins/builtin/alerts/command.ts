import { metricFormInput, metricShortcut, parseMetricAlert } from "./metric-command";
import { isRelativeMetric, type AlertMetric } from "./metric-model";
import type { AlertCondition } from "./types";
import { isPenceLevel, readAlertLevel, readAlertPrice } from "./price";
import { normalizeAlertSymbol } from "./quotes";
import { moveCondition, parseMovePercent } from "./move";

export interface AlertCommandInput {
  symbol: string;
  condition: AlertCondition;
  price: number;
  /** Typed in pence (`70p`): `price` is in pounds, for a London line quoted in pence. */
  pence?: true;
  metric?: AlertMetric;
}

function parseAlertCondition(value: string | undefined): AlertCondition | null {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case ">":
    case "above":
    case "over":
    case "gt":
      return "above";
    case "<":
    case "below":
    case "under":
    case "lt":
      return "below";
    case "x":
    case "cross":
    case "crosses":
      return "crosses";
    default:
      return null;
  }
}

export function parseAlertShortcutValues(
  input: string,
  context?: { activeTicker: string | null },
): Record<string, string> {
  const metric = parseMetricAlert(input);
  if (metric) return metricShortcut(metric);
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    const activeTicker = normalizeAlertSymbol(context?.activeTicker);
    return activeTicker ? { symbol: activeTicker } : {};
  }
  if (parts.length > 3) {
    throw new Error("Use SA SYMBOL above|below|crosses PRICE.");
  }

  const values: Record<string, string> = {
    symbol: normalizeAlertSymbol(parts[0]),
  };

  if (parts[1]) {
    const condition = parseAlertCondition(parts[1]);
    // A move from the previous close is added where its delivery can be said: `alerts add`.
    if (!condition && moveCondition(parts[1])) {
      throw new Error(`Add a move alert with gloom alerts add ${values.symbol} ${parts[1].toLowerCase()} ${parts[2] ?? "0.5%"}.`);
    }
    if (!condition) {
      throw new Error("Use above, below, crosses, >, <, or x.");
    }
    values.condition = condition;
  }

  // The price reads as `alerts add` reads it: 81k is 81000, 81,000 asks which was meant, and text that is no number says what to type.
  // `70p`, pence on a London line, stays as typed for the add to hold to its line.
  if (parts[2]) values.price = isPenceLevel(parts[2]) ? (readAlertLevel(parts[2]), parts[2].trim()) : String(readAlertPrice(parts[2].replace(/^\$/, "")));

  return values;
}

/** The alert a command's values name: null while one is missing, and a price that reads two ways or as no number throws (`readAlertPrice`). */
export function parseAlertCommandValues(
  values?: Record<string, string>,
): AlertCommandInput | null {
  const shortcut = values?.shortcut?.trim();
  if (shortcut) {
    values = {
      ...values,
      ...parseAlertShortcutValues(shortcut),
    };
  }

  const metric = values ? metricFormInput(values) : null;
  if (metric) return metric;
  const symbol = values?.symbol?.trim().toUpperCase();
  const condition = parseAlertCondition(values?.condition);
  const priceStr = values?.price?.trim();
  if (!symbol || !condition || !priceStr) return null;
  return { symbol, condition, ...readAlertLevel(priceStr.replace(/^\$/, "")) };
}

/** A move rule's edit read: `GBPUSD=X moves 0.5%`, `HSBA:LSE down 3`, as `alerts add` takes it. Null for another form. */
function parseMoveEdit(value: string): (AlertCommandInput & { move: true }) | null {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const condition = parts.length === 3 ? moveCondition(parts[1]) : null;
  if (!condition) return null;
  const percent = parseMovePercent(parts[2]);
  if (percent == null) throw new Error(`A move is a percent from the previous close, above 0 and up to 100, not "${parts[2]}".`);
  return { symbol: normalizeAlertSymbol(parts[0]), condition, price: percent, move: true };
}

/**
 * The edit dialog's text read against the alert it changes. An edit keeps the alert in its kind and its synced list:
 * price stays price, a move stays a move, a valuation or technical measure stays one, and a ratio or RRG alert keeps its listings.
 */
export function parseAlertEdit(
  selected: { symbol: string; metric?: AlertMetric; move?: boolean },
  value: string,
): AlertCommandInput & { move?: true } {
  const move = selected.metric ? null : parseMoveEdit(value);
  // A move and a price level are kept in different lists, so one never becomes the other: the other kind is a new alert.
  if (move && !selected.move) throw new Error(`A move is its own alert: gloom alerts add ${move.symbol} ${value.trim().split(/\s+/).slice(1).join(" ")}.`);
  if (move) return move;
  if (selected.move) {
    const level = parseAlertCommandValues({ shortcut: value });
    if (level && !level.metric) throw new Error(`A price level is its own alert: gloom alerts add ${level.symbol} ${value.trim().split(/\s+/).slice(1).join(" ")}.`);
    throw new Error("Use SYMBOL moves|up|down PERCENT, such as GBPUSD=X moves 0.5%.");
  }
  const parsed = parseAlertCommandValues({ shortcut: value });
  if (!parsed) throw new Error("Use SYMBOL above|below|crosses PRICE.");
  if (!!parsed.metric !== !!selected.metric) throw new Error("Add a new alert to change between price and a valuation or technical measure.");
  if (!parsed.metric || !selected.metric) return parsed;
  if (isRelativeMetric(parsed.metric) !== isRelativeMetric(selected.metric)) {
    throw new Error("Add a new alert to change between a relative strength alert and a valuation or technical measure.");
  }
  if (!isRelativeMetric(selected.metric)) return parsed;
  // The benchmark listing was confirmed when the alert was added; a different pair is a new alert.
  if (parsed.metric.kind !== selected.metric.kind || parsed.symbol !== selected.symbol || !isRelativeMetric(parsed.metric)
    || parsed.metric.benchmark !== selected.metric.benchmark) {
    throw new Error("Add a new alert to compare other listings.");
  }
  return { ...parsed, metric: { ...parsed.metric, benchmarkExchange: selected.metric.benchmarkExchange } };
}
