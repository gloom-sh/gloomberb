import { ema, rsi, sma, type IndexedValue } from "../../../time-series/studies";

/** One daily bar as the rules see it. Open is optional; fills fall back to the close. */
export interface BacktestBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
}

export type Operand =
  | { kind: "number"; value: number }
  | { kind: "field"; field: "close" | "open" | "high" | "low" }
  | { kind: "indicator"; name: IndicatorName; args: number[] };
export type IndicatorName = "sma" | "ema" | "rsi" | "macd" | "macd_signal" | "bb_upper" | "bb_lower" | "highest" | "lowest";
export type Comparator = ">" | "<" | ">=" | "<=" | "crosses above" | "crosses below";
export interface Condition { left: Operand; comparator: Comparator; right: Operand }
/** Conditions are ANDed. */
export type Rule = Condition[];

interface IndicatorSpec { defaults: number[]; bounds: Array<[number, number, boolean]>; usage: string }
const PERIOD: [number, number, boolean] = [1, 500, true];
export const INDICATORS: Record<IndicatorName, IndicatorSpec> = {
  sma: { defaults: [20], bounds: [PERIOD], usage: "sma(n)" },
  ema: { defaults: [20], bounds: [PERIOD], usage: "ema(n)" },
  rsi: { defaults: [14], bounds: [[2, 500, true]], usage: "rsi(n)" },
  macd: { defaults: [12, 26, 9], bounds: [PERIOD, PERIOD, PERIOD], usage: "macd(fast,slow,signal)" },
  macd_signal: { defaults: [12, 26, 9], bounds: [PERIOD, PERIOD, PERIOD], usage: "macd_signal(fast,slow,signal)" },
  bb_upper: { defaults: [20, 2], bounds: [[2, 500, true], [0.5, 5, false]], usage: "bb_upper(n,k)" },
  bb_lower: { defaults: [20, 2], bounds: [[2, 500, true], [0.5, 5, false]], usage: "bb_lower(n,k)" },
  highest: { defaults: [20], bounds: [PERIOD], usage: "highest(n)" },
  lowest: { defaults: [20], bounds: [PERIOD], usage: "lowest(n)" },
};
const FIELDS = new Set(["close", "open", "high", "low"]);
const COMPARATORS: Array<[RegExp, Comparator]> = [
  [/^crosses\s+above$/, "crosses above"],
  [/^crosses\s+below$/, "crosses below"],
  [/^(>|above)$/, ">"],
  [/^(<|below)$/, "<"],
  [/^>=$/, ">="],
  [/^<=$/, "<="],
];

function parseOperand(text: string): Operand {
  const value = text.trim().toLowerCase();
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(value)) return { kind: "number", value: Number(value) };
  if (FIELDS.has(value)) return { kind: "field", field: value as "close" };
  const match = /^([a-z_]+)\s*(?:\(([^)]*)\))?$/.exec(value);
  const name = match?.[1] as IndicatorName | undefined;
  const spec = name ? INDICATORS[name] : undefined;
  if (!match || !name || !spec) throw new Error(`Unknown operand "${text.trim()}". Use close, open, high, low, a number or ${Object.values(INDICATORS).map((entry) => entry.usage).join(", ")}.`);
  const given = match[2]?.trim() ? match[2].split(",").map((part) => part.trim()) : [];
  if (given.length > spec.defaults.length) throw new Error(`${spec.usage} takes at most ${spec.defaults.length} values.`);
  const args = spec.defaults.map((fallback, index) => {
    const raw = given[index];
    const parsed = raw === undefined || raw === "" ? fallback : Number(raw);
    const [min, max, integer] = spec.bounds[index]!;
    if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
      throw new Error(`${spec.usage}: value ${index + 1} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}.`);
    }
    return parsed;
  });
  if ((name === "macd" || name === "macd_signal") && args[0]! >= args[1]!) throw new Error(`${spec.usage}: fast must be shorter than slow.`);
  return { kind: "indicator", name, args };
}

/** `sma(50) crosses above sma(200) and rsi(14) < 70` */
export function parseRule(text: string): Rule {
  const source = text.trim();
  if (!source) throw new Error("Enter a rule, for example: sma(50) crosses above sma(200)");
  return source.split(/\s+and\s+/i).map((part) => {
    const match = /^(.+?)\s+(crosses\s+above|crosses\s+below|>=|<=|>|<|above|below)\s+(.+)$/i.exec(part.trim());
    if (!match) throw new Error(`Cannot read "${part.trim()}". Write <operand> <comparison> <operand>, for example close > sma(200).`);
    const comparator = COMPARATORS.find(([pattern]) => pattern.test(match[2]!.toLowerCase().replace(/\s+/g, " ")))![1];
    const left = parseOperand(match[1]!);
    const right = parseOperand(match[3]!);
    if (left.kind === "number" && right.kind === "number") throw new Error("Compare at least one price or indicator.");
    return { left, comparator, right };
  });
}

/** Sessions of history an operand needs before its first value. */
export function operandWarmup(operand: Operand): number {
  if (operand.kind !== "indicator") return 0;
  const [a = 0, b = 0, c = 0] = operand.args;
  if (operand.name === "macd") return b;
  if (operand.name === "macd_signal") return b + c;
  if (operand.name === "rsi") return a + 1;
  return a;
}
export const ruleWarmup = (rule: Rule) =>
  Math.max(0, ...rule.flatMap((condition) => [operandWarmup(condition.left), operandWarmup(condition.right)]));

function indexed(length: number, values: readonly IndexedValue[]): Float64Array {
  const result = new Float64Array(length).fill(Number.NaN);
  for (const { index, value } of values) result[index] = value;
  return result;
}

/** Aligned per-bar values; NaN wherever the operand is not yet defined. Same formulas as chart studies. */
export function evaluateOperand(operand: Operand, bars: readonly BacktestBar[]): Float64Array {
  const length = bars.length;
  if (operand.kind === "number") return new Float64Array(length).fill(operand.value);
  if (operand.kind === "field") return Float64Array.from(bars, (bar) => bar[operand.field] ?? Number.NaN);
  const closes = bars.map((bar) => bar.close);
  const [a = 0, b = 0, c = 0] = operand.args;
  switch (operand.name) {
    case "sma": return indexed(length, sma(closes, a));
    case "ema": return indexed(length, ema(closes, a));
    case "rsi": return indexed(length, rsi(closes, a));
    case "macd":
    case "macd_signal": {
      const fast = indexed(length, ema(closes, a));
      const slow = ema(closes, b);
      const macd = slow.flatMap(({ index, value }) => Number.isNaN(fast[index]!) ? [] : [{ index, value: fast[index]! - value }]);
      if (operand.name === "macd") return indexed(length, macd);
      const signal = ema(macd.map(({ value }) => value), c);
      return indexed(length, signal.map(({ index, value }) => ({ index: macd[index]!.index, value })));
    }
    case "bb_upper":
    case "bb_lower": {
      const direction = operand.name === "bb_upper" ? 1 : -1;
      return indexed(length, sma(closes, a).map(({ index, value }) => {
        let variance = 0;
        for (let offset = index - a + 1; offset <= index; offset += 1) variance += (closes[offset]! - value) ** 2;
        return { index, value: value + direction * b * Math.sqrt(variance / a) };
      }));
    }
    case "highest":
    case "lowest": {
      // Prior sessions only, so a close can break out above its own range.
      const result = new Float64Array(length).fill(Number.NaN);
      for (let index = a; index < length; index += 1) {
        let extreme = operand.name === "highest" ? -Infinity : Infinity;
        for (let offset = index - a; offset < index; offset += 1) {
          const bar = bars[offset]!;
          const value = operand.name === "highest" ? bar.high ?? bar.close : bar.low ?? bar.close;
          extreme = operand.name === "highest" ? Math.max(extreme, value) : Math.min(extreme, value);
        }
        result[index] = extreme;
      }
      return result;
    }
  }
}

/** True on bars where every condition holds. Undefined inputs are never true. */
export function evaluateRule(rule: Rule, bars: readonly BacktestBar[]): boolean[] {
  const result = new Array<boolean>(bars.length).fill(true);
  for (const condition of rule) {
    const left = evaluateOperand(condition.left, bars);
    const right = evaluateOperand(condition.right, bars);
    for (let index = 0; index < bars.length; index += 1) {
      const l = left[index]!, r = right[index]!;
      let met: boolean;
      if (Number.isNaN(l) || Number.isNaN(r)) met = false;
      else if (condition.comparator === ">") met = l > r;
      else if (condition.comparator === "<") met = l < r;
      else if (condition.comparator === ">=") met = l >= r;
      else if (condition.comparator === "<=") met = l <= r;
      else {
        const pl = left[index - 1], pr = right[index - 1];
        met = pl !== undefined && pr !== undefined && !Number.isNaN(pl) && !Number.isNaN(pr)
          && (condition.comparator === "crosses above" ? l > r && pl <= pr : l < r && pl >= pr);
      }
      if (!met) result[index] = false;
    }
  }
  return result;
}
