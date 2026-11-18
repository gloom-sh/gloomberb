import { metricFormInput, metricShortcut, parseMetricAlert } from "./metric-command";
import { isRelativeMetric, type AlertMetric } from "./metric-model";
import type { AlertCondition } from "./types";
import { isPenceLevel, parseAlertPrice, readAlertLevel, readAlertPrice } from "./price";
import { normalizeAlertSymbol } from "./quotes";
import { moveCondition, parseMovePercent } from "./move";
import type { WizardStep } from "../../../types/plugin";

/** Add Alert's kind for a move from the previous close, beside a price level. */
export const MOVE_KIND_CHOICE = { value: "move", label: "Move from previous close" };

/** The move kind's fields: which way, and how far in percent, as `alerts add QQQ moves 5%` names them. */
export const moveWizardFields: WizardStep[] = [
  { key: "move:condition", label: "Direction", type: "select", defaultValue: "crosses", dependsOn: { key: "kind", value: "move" },
    options: [{ label: "Either way", value: "crosses" }, { label: "Up", value: "above" }, { label: "Down", value: "below" }] },
  { key: "move:percent", label: "Move (%)", type: "number", placeholder: "3", dependsOn: { key: "kind", value: "move" } },
];

const MOVE_PERCENT_RULE = "A move is a percent from the previous close, above 0 and up to 100";

export interface AlertCommandInput {
  symbol: string;
  condition: AlertCondition;
  /** The level, or for a move (`move`) the percent from the previous close. */
  price: number;
  /** A move from the previous close (`QQQ moves 5%`): `condition` is either way (crosses), up (above) or down (below). */
  move?: true;
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
  // The price is the rest of the line, as one: `$ 757.75`, `1 000.50` and `757.75 USD` read as `alerts add` reads them quoted.
  const priceText = parts.slice(2).join(" ");
  if (parts.length > 3 && !isPenceLevel(priceText) && parseAlertPrice(priceText).kind === "invalid") {
    throw new Error("Use SA SYMBOL above|below|crosses PRICE.");
  }

  const values: Record<string, string> = {
    symbol: normalizeAlertSymbol(parts[0]),
  };

  if (parts[1]) {
    const condition = parseAlertCondition(parts[1]);
    // A move from the previous close, as `alerts add` takes it: `QQQ moves 5%`, `QQQ up 3`, `QQQ down 2%`.
    const move = condition ? null : moveCondition(parts[1]);
    if (move) {
      const typed = parts.slice(2).join(" ");
      if (typed && parseMovePercent(typed) == null) throw new Error(`${MOVE_PERCENT_RULE}, not "${typed}".`);
      return { ...values, kind: "move", "move:condition": move, ...typed ? { "move:percent": String(parseMovePercent(typed)) } : {} };
    }
    if (!condition) {
      throw new Error("Use above, below, crosses, >, <, or x.");
    }
    values.condition = condition;
  }

  // The price reads as `alerts add` reads it: 81k is 81000, 81,000 asks which was meant ($81,000 does not), and text that is no
  // number says what to type. `70p`, pence on a London line, stays as typed for the add to hold to its line.
  if (priceText) values.price = isPenceLevel(priceText) ? (readAlertLevel(priceText), priceText.trim()) : String(readAlertPrice(priceText));

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

  if (values?.kind === "move") {
    const symbol = values.symbol?.trim().toUpperCase();
    const condition = parseAlertCondition(values["move:condition"]) ?? "crosses";
    const typed = values["move:percent"]?.trim();
    if (!symbol || !typed) return null;
    const percent = parseMovePercent(typed);
    if (percent == null) throw new Error(`${MOVE_PERCENT_RULE}, not "${typed}".`);
    return { symbol, condition, price: percent, move: true };
  }
  const metric = values ? metricFormInput(values) : null;
  if (metric) return metric;
  const symbol = values?.symbol?.trim().toUpperCase();
  const condition = parseAlertCondition(values?.condition);
  const priceStr = values?.price?.trim();
  if (!symbol || !condition || !priceStr) return null;
  return { symbol, condition, ...readAlertLevel(priceStr) };
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
