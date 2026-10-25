import type { AlertMetric } from "./metric-model";
import { validMetricRule } from "./metric-model";
import { readAlertPrice } from "./price";
import type { AlertCondition } from "./types";
import type { WizardStep } from "../../../types/plugin";

export interface MetricAlertInput { symbol: string; condition: AlertCondition; price: number; metric: AlertMetric }
const direction = (s: string) => /^(above|over|>)$/i.test(s) ? "above" as const : /^(below|under|<)$/i.test(s) ? "below" as const : null;
const USAGE = "Use AAPL pe below 25, AAPL ps above 8, NVDA rsi(14) under 30, SPY ma(50) crosses above ma(200), or TSLA closes below ma(200).";
function checked(input: MetricAlertInput): MetricAlertInput {
  if (!validMetricRule({ ...input, targetPrice: input.price })) throw new Error("Use a positive multiple, RSI from 0 to 100, and whole MA/RSI periods from 2 to 200 (fast MA shorter than slow MA).");
  return input;
}
/** Parses both compact CLI notation and the words traders type, without swallowing malformed metrics as calendar events. */
export function parseMetricAlert(input: string): MetricAlertInput | null {
  const words = input.trim().replace(/\s+/g, " ");
  const parts = words.split(" ");
  if (!/^(p\/?e|p\/?s|rsi(?:\(|$)|ma(?:\(|$)|\d+-day|closes?$)/i.test(parts[1] ?? "")) return null;
  const ratio = /^(\S+) (p\/?e|p\/?s) (above|below|over|under|>|<) (\S+)$/i.exec(words);
  if (ratio) return checked({ symbol: ratio[1]!.toUpperCase(), metric: { kind: ratio[2]!.toLowerCase().replace("/", "") as "pe" | "ps" }, condition: direction(ratio[3]!)!, price: readAlertPrice(ratio[4]!) });
  const rsi = /^(\S+) rsi(?:\((\d+)\)| (\d+))? (above|below|over|under|>|<) (\S+)$/i.exec(words);
  if (rsi) return checked({ symbol: rsi[1]!.toUpperCase(), metric: { kind: "rsi", period: Number(rsi[2] ?? rsi[3] ?? 14) }, condition: direction(rsi[4]!)!, price: readAlertPrice(rsi[5]!) });
  const ma = words.replace(/(?:its|the) /gi, "").replace(/(\d+)-day(?: (?:ma|moving average))?/gi, "ma($1)").replace(/ma (\d+)/gi, "ma($1)");
  const cross = /^(\S+) ma\((\d+)\) crosses (above|below) ma\((\d+)\)$/i.exec(ma);
  if (cross) return checked({ symbol: cross[1]!.toUpperCase(), metric: { kind: "ma_cross", period: Number(cross[2]), slowPeriod: Number(cross[4]), direction: direction(cross[3]!)! }, condition: "crosses", price: 0 });
  const close = /^(\S+) closes? (above|below|over|under) ma\((\d+)\)$/i.exec(ma);
  if (close) return checked({ symbol: close[1]!.toUpperCase(), metric: { kind: "close_ma", period: Number(close[3]) }, condition: direction(close[2]!)!, price: 0 });
  throw new Error(USAGE);
}
export function metricShortcut(input: MetricAlertInput): Record<string, string> {
  const m = input.metric;
  return { symbol: input.symbol, kind: m.kind, [`${m.kind}:condition`]: m.kind === "ma_cross" ? m.direction : input.condition,
    [`${m.kind}:target`]: String(input.price), ...("period" in m ? { [`${m.kind}:period`]: String(m.period) } : {}),
    ...(m.kind === "ma_cross" ? { "ma_cross:slowPeriod": String(m.slowPeriod) } : {}) };
}
export function metricFormInput(values: Record<string, string>): MetricAlertInput | null {
  const kind = values.kind;
  if (!kind || kind === "price") return null;
  const symbol = values.symbol?.trim().toUpperCase();
  if (!symbol) return null;
  const condition = values[`${kind}:condition`] ?? "below";
  const window = values[`${kind}:period`] ?? (kind === "rsi" ? "14" : kind === "ma_cross" ? "50" : "200");
  const text = kind === "ma_cross" ? `${symbol} ma(${window}) crosses ${condition} ma(${values["ma_cross:slowPeriod"] ?? "200"})`
    : kind === "close_ma" ? `${symbol} closes ${condition} ma(${window})`
    : `${symbol} ${kind === "rsi" ? `rsi(${window})` : kind} ${condition} ${values[`${kind}:target`] ?? ""}`;
  return parseMetricAlert(text);
}
export const METRIC_CHOICES = [
  { value: "price", label: "Price" }, { value: "pe", label: "P/E (TTM)" }, { value: "ps", label: "P/S (TTM)" },
  { value: "rsi", label: "RSI" }, { value: "ma_cross", label: "MA crossover" }, { value: "close_ma", label: "Close vs MA" },
];
export const metricWizardFields: WizardStep[] = METRIC_CHOICES.filter(x => x.value !== "price").flatMap(({ value: kind }) => {
  const dependsOn = { key: "kind", value: kind };
  return [
    ...(["rsi", "ma_cross", "close_ma"].includes(kind) ? [{ key: `${kind}:period`, label: kind === "ma_cross" ? "Fast MA (days)" : kind === "rsi" ? "RSI period" : "MA (days)", type: "number" as const, defaultValue: kind === "rsi" ? "14" : kind === "ma_cross" ? "50" : "200", dependsOn }] : []),
    { key: `${kind}:condition`, label: "Condition", type: "select" as const, defaultValue: "below", dependsOn,
      options: [{ label: kind === "ma_cross" ? "Crosses above" : "Above", value: "above" }, { label: kind === "ma_cross" ? "Crosses below" : "Below", value: "below" }] },
    ...(kind === "ma_cross" ? [{ key: "ma_cross:slowPeriod", label: "Slow MA (days)", type: "number" as const, defaultValue: "200", dependsOn }]
      : kind === "close_ma" ? [] : [{ key: `${kind}:target`, label: kind === "rsi" ? "RSI level" : "Target multiple", type: "number" as const, placeholder: kind === "rsi" ? "30" : kind === "pe" ? "25" : "8", dependsOn }]),
  ];
});
