import type { AlertMetric, RotationQuadrant } from "./metric-model";
import { ROTATION_QUADRANTS, validMetricRule } from "./metric-model";
import { readAlertPrice } from "./price";
import type { AlertCondition } from "./types";
import type { WizardStep } from "../../../types/plugin";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { DEFAULT_ROTATION_BENCHMARK } from "../relative-rotation/model";

export interface MetricAlertInput { symbol: string; condition: AlertCondition; price: number; metric: AlertMetric }
const direction = (s: string) => /^(above|over|>)$/i.test(s) ? "above" as const : /^(below|under|<)$/i.test(s) ? "below" as const : null;
const USAGE = "Use AAPL pe below 25, AAPL ps above 8, NVDA rsi(14) under 30, SPY ma(50) crosses above ma(200), or TSLA closes below ma(200).";
function checked(input: MetricAlertInput): MetricAlertInput {
  if (!validMetricRule({ ...input, targetPrice: input.price })) throw new Error("Use a positive multiple, RSI from 0 to 100, and whole MA/RSI periods from 2 to 200 (fast MA shorter than slow MA).");
  return input;
}
const RELATIVE_USAGE = "Relative strength alerts take the ratio of two listings or an RRG quadrant: alerts add XLK/SPY above 0.25, or alerts add XLE rrg leading [--benchmark SPY].";
const QUADRANT_USAGE = "An RRG alert names the quadrant it enters: leading, weakening, lagging or improving, such as alerts add XLE rrg leading [--benchmark SPY].";
/** A benchmark typed as SPY or SPY:NYSEARCA; its listing is confirmed when the alert is added. */
function benchmarkListing(text: string): { benchmark: string; benchmarkExchange?: string } {
  const parsed = parsePublicTickerKey(text.toUpperCase());
  if (!/^[A-Z0-9.^=-]{1,20}$/.test(parsed.symbol)) throw new Error(`Not a benchmark listing: ${text}.`);
  return { benchmark: parsed.symbol, ...(parsed.exchange ? { benchmarkExchange: parsed.exchange } : {}) };
}
const sameListing = (symbol: string, metric: { benchmark: string }) => parsePublicTickerKey(symbol).symbol === metric.benchmark;
/**
 * `XLK/SPY ratio above 0.25` and `XLE rrg leading [vs SPY]`; undefined for anything else. `XLK/SPY above 0.25`
 * without the word is first a listing (BRK/B, EUR/USD), so `alerts add` reads it as a ratio only once it quotes nothing.
 */
function parseRelativeAlert(parts: readonly string[]): MetricAlertInput | undefined {
  const [first = "", second = "", ...rest] = parts;
  const kind = second.toLowerCase();
  if (kind === "rrg") {
    const [quadrant = "", vs, benchmark, ...extra] = rest;
    if (first.includes("/")) throw new Error(`Name the benchmark of an RRG alert after it: alerts add ${first.split("/")[0]!.toUpperCase()} rrg ${quadrant.toLowerCase() || "leading"} --benchmark ${first.split("/")[1]!.toUpperCase()}.`);
    if (!(ROTATION_QUADRANTS as readonly string[]).includes(quadrant.toLowerCase())) throw new Error(QUADRANT_USAGE);
    if (vs !== undefined && (!/^(vs\.?|versus|against)$/i.test(vs) || !benchmark || extra.length > 0)) throw new Error(QUADRANT_USAGE);
    const metric = { kind: "rrg" as const, quadrant: quadrant.toLowerCase() as RotationQuadrant, ...benchmarkListing(benchmark ?? DEFAULT_ROTATION_BENCHMARK) };
    if (sameListing(first, metric)) throw new Error(`An RRG alert compares ${first.toUpperCase()} with another listing: alerts add ${first.toUpperCase()} rrg ${metric.quadrant} --benchmark SPY.`);
    return checked({ symbol: first.toUpperCase(), condition: "crosses", price: 0, metric });
  }
  const pair = /^([^/]+)\/([^/]+)$/.exec(first);
  if (pair && kind === "ratio") {
    const [typed = "", level, ...extra] = rest;
    const condition = direction(typed) ?? (/^(crosses|cross|x)$/i.test(typed) ? "crosses" as const : null);
    const example = `alerts add ${first.toUpperCase()} above 0.25`;
    if (!condition || level === undefined || extra.length > 0) throw new Error(`A ratio alert takes above, below or crosses and a ratio: ${example}.`);
    const metric = { kind: "rs_ratio" as const, ...benchmarkListing(pair[2]!) };
    if (sameListing(pair[1]!, metric)) throw new Error(`A ratio alert divides one listing by another: ${example}.`);
    const price = readAlertPrice(level);
    if (!(price > 0)) throw new Error(`A ratio alert takes a positive ratio: ${example}.`);
    return checked({ symbol: pair[1]!.toUpperCase(), condition, price, metric });
  }
  // `XLE rs above 100`, `XLE vs SPY above 1`, `XLE relative strength leading`: a relative alert typed another way.
  if (/^(rs|rsr|rs-?ratio|rs_ratio|rs-?momentum|rel|relative|rotation|quadrant|ratio|vs\.?|versus)$/i.test(kind)
    && rest.some((word) => /^(above|below|over|under|crosses|cross|>|<|leading|weakening|lagging|improving|rrg)$/i.test(word))) {
    throw new Error(RELATIVE_USAGE);
  }
  return undefined;
}
/** Parses both compact CLI notation and the words traders type, without swallowing malformed metrics as calendar events. */
export function parseMetricAlert(input: string): MetricAlertInput | null {
  const words = input.trim().replace(/\s+/g, " ");
  const parts = words.split(" ");
  const relative = parseRelativeAlert(parts);
  if (relative) return relative;
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
export const benchmarkKey = (metric: { benchmark: string; benchmarkExchange?: string }) => `${metric.benchmark}${metric.benchmarkExchange ? `:${metric.benchmarkExchange}` : ""}`;
/** A relative alert as `alerts add` takes it, for editing: `XLK/SPY ratio above 0.25`, `XLE rrg leading vs SPY`. */
export function relativeAlertText(input: { symbol: string; condition: AlertCondition; targetPrice: number; metric?: AlertMetric }): string | null {
  const m = input.metric;
  if (m?.kind === "rs_ratio") return `${input.symbol}/${m.benchmark} ratio ${input.condition} ${input.targetPrice}`;
  return m?.kind === "rrg" ? `${input.symbol} rrg ${m.quadrant} vs ${m.benchmark}` : null;
}
export function metricShortcut(input: MetricAlertInput): Record<string, string> {
  const m = input.metric;
  if (m.kind === "rs_ratio") return { symbol: input.symbol, kind: m.kind, "rs_ratio:benchmark": benchmarkKey(m), "rs_ratio:condition": input.condition, "rs_ratio:target": String(input.price) };
  if (m.kind === "rrg") return { symbol: input.symbol, kind: m.kind, "rrg:quadrant": m.quadrant, "rrg:benchmark": benchmarkKey(m) };
  return { symbol: input.symbol, kind: m.kind, [`${m.kind}:condition`]: m.kind === "ma_cross" ? m.direction : input.condition,
    [`${m.kind}:target`]: String(input.price), ...("period" in m ? { [`${m.kind}:period`]: String(m.period) } : {}),
    ...(m.kind === "ma_cross" ? { "ma_cross:slowPeriod": String(m.slowPeriod) } : {}) };
}
export function metricFormInput(values: Record<string, string>): MetricAlertInput | null {
  const kind = values.kind;
  if (!kind || kind === "price") return null;
  const symbol = values.symbol?.trim().toUpperCase();
  if (!symbol) return null;
  if (kind === "rs_ratio") {
    const benchmark = values["rs_ratio:benchmark"]?.trim();
    return benchmark ? parseMetricAlert(`${symbol}/${benchmark} ratio ${values["rs_ratio:condition"] ?? "above"} ${values["rs_ratio:target"] ?? ""}`) : null;
  }
  if (kind === "rrg") return parseMetricAlert(`${symbol} rrg ${values["rrg:quadrant"] ?? "leading"} vs ${values["rrg:benchmark"]?.trim() || DEFAULT_ROTATION_BENCHMARK}`);
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
  { value: "rs_ratio", label: "Ratio to benchmark" }, { value: "rrg", label: "RRG quadrant" },
];
const RELATIVE_FIELDS: WizardStep[] = [
  { key: "rs_ratio:benchmark", label: "Divided by", type: "text", placeholder: "SPY", dependsOn: { key: "kind", value: "rs_ratio" } },
  { key: "rs_ratio:condition", label: "Condition", type: "select", defaultValue: "above", dependsOn: { key: "kind", value: "rs_ratio" },
    options: [{ label: "Above", value: "above" }, { label: "Below", value: "below" }, { label: "Crosses", value: "crosses" }] },
  { key: "rs_ratio:target", label: "Ratio", type: "number", placeholder: "0.25", dependsOn: { key: "kind", value: "rs_ratio" } },
  { key: "rrg:quadrant", label: "Enters", type: "select", defaultValue: "leading", dependsOn: { key: "kind", value: "rrg" },
    options: ROTATION_QUADRANTS.map((value) => ({ label: `${value[0]!.toUpperCase()}${value.slice(1)}`, value })) },
  { key: "rrg:benchmark", label: "Benchmark", type: "text", defaultValue: "SPY", placeholder: "SPY", dependsOn: { key: "kind", value: "rrg" } },
];
export const metricWizardFields: WizardStep[] = [...METRIC_CHOICES.filter(x => x.value !== "price" && x.value !== "rs_ratio" && x.value !== "rrg").flatMap(({ value: kind }) => {
  const dependsOn = { key: "kind", value: kind };
  return [
    ...(["rsi", "ma_cross", "close_ma"].includes(kind) ? [{ key: `${kind}:period`, label: kind === "ma_cross" ? "Fast MA (days)" : kind === "rsi" ? "RSI period" : "MA (days)", type: "number" as const, defaultValue: kind === "rsi" ? "14" : kind === "ma_cross" ? "50" : "200", dependsOn }] : []),
    { key: `${kind}:condition`, label: "Condition", type: "select" as const, defaultValue: "below", dependsOn,
      options: [{ label: kind === "ma_cross" ? "Crosses above" : "Above", value: "above" }, { label: kind === "ma_cross" ? "Crosses below" : "Below", value: "below" }] },
    ...(kind === "ma_cross" ? [{ key: "ma_cross:slowPeriod", label: "Slow MA (days)", type: "number" as const, defaultValue: "200", dependsOn }]
      : kind === "close_ma" ? [] : [{ key: `${kind}:target`, label: kind === "rsi" ? "RSI level" : "Target multiple", type: "number" as const, placeholder: kind === "rsi" ? "30" : kind === "pe" ? "25" : "8", dependsOn }]),
  ];
}), ...RELATIVE_FIELDS];
