import { metricFormInput, metricShortcut, parseMetricAlert } from "./metric-command";
import type { AlertMetric } from "./metric-model";
import type { AlertCondition } from "./types";
import { readAlertPrice } from "./price";
import { normalizeAlertSymbol } from "./quotes";

export interface AlertCommandInput {
  symbol: string;
  condition: AlertCondition;
  price: number;
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
    if (!condition) {
      throw new Error("Use above, below, crosses, >, <, or x.");
    }
    values.condition = condition;
  }

  // The price reads as `alerts add` reads it: 81k is 81000, 81,000 asks which was meant, and text that is no number says what to type.
  if (parts[2]) values.price = String(readAlertPrice(parts[2].replace(/^\$/, "")));

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
  return { symbol, condition, price: readAlertPrice(priceStr.replace(/^\$/, "")) };
}
