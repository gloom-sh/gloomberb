// Keep this model identical to the delivery model; the parity fixture checks both copies.
/** Synced separately from price rules so older clients cannot judge a ratio as a price. */
export const METRIC_ALERTS_KEY = "metricAlerts";
export type AlertMetric =
  | { kind: "pe" | "ps" }
  | { kind: "rsi"; period: number }
  | { kind: "close_ma"; period: number }
  | { kind: "ma_cross"; period: number; slowPeriod: number; direction: "above" | "below" };
export interface MetricReading {
  value: number;
  target: number;
  previousValue?: number;
  previousTarget?: number;
  day?: string;
  at: number;
}
export interface MetricRule {
  metric?: AlertMetric;
  condition: "above" | "below" | "crosses";
  targetPrice: number;
  armedAt?: number;
  createdAt?: number;
  lastDailyClose?: string;
  status: string;
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const period = (value: unknown): value is number => finite(value) && Number.isInteger(value) && value >= 2 && value <= 200;

export function readAlertMetric(raw: unknown): AlertMetric | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.kind === "pe" || m.kind === "ps") return { kind: m.kind };
  if ((m.kind === "rsi" || m.kind === "close_ma") && period(m.period)) return { kind: m.kind, period: m.period };
  if (m.kind === "ma_cross" && period(m.period) && period(m.slowPeriod) && m.period < m.slowPeriod
    && (m.direction === "above" || m.direction === "below")) {
    return { kind: m.kind, period: m.period, slowPeriod: m.slowPeriod, direction: m.direction };
  }
  return null;
}

export function validMetricRule(rule: Pick<MetricRule, "metric" | "condition" | "targetPrice">): boolean {
  const m = readAlertMetric(rule.metric);
  if (!m || !finite(rule.targetPrice)) return false;
  if (m.kind === "ma_cross") return rule.condition === "crosses" && rule.targetPrice === 0;
  if (rule.condition !== "above" && rule.condition !== "below") return false;
  return m.kind === "close_ma" ? rule.targetPrice === 0
    : m.kind === "rsi" ? rule.targetPrice >= 0 && rule.targetPrice <= 100 : rule.targetPrice > 0;
}

export function metricName(metric: AlertMetric): string {
  if (metric.kind === "pe") return "P/E (TTM)";
  if (metric.kind === "ps") return "P/S (TTM)";
  if (metric.kind === "rsi") return `RSI(${metric.period})`;
  return metric.kind === "ma_cross" ? `${metric.period}-day MA` : "Close";
}
export function metricDescription(rule: MetricRule & { symbol: string }): string {
  const m = rule.metric!;
  const target = m.kind === "ma_cross" ? `${m.slowPeriod}-day MA`
    : m.kind === "close_ma" ? `${m.period}-day MA` : String(rule.targetPrice);
  const condition = m.kind === "ma_cross" ? `crosses ${m.direction}` : rule.condition;
  return `${rule.symbol} ${metricName(m)} ${condition} ${target}${isDailyMetric(m) ? " · on daily close" : ""}`;
}
export function isDailyMetric(metric: AlertMetric): boolean {
  return metric.kind !== "pe" && metric.kind !== "ps";
}

/** Wilder's initial average of N changes, then (previous * (N - 1) + change) / N. */
function rsi(closes: readonly number[], window: number): number[] {
  let gain = 0, loss = 0;
  const values: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const delta = closes[i]! - closes[i - 1]!;
    if (i <= window) { gain += Math.max(0, delta) / window; loss += Math.max(0, -delta) / window; }
    else { gain = (gain * (window - 1) + Math.max(0, delta)) / window; loss = (loss * (window - 1) + Math.max(0, -delta)) / window; }
    if (i >= window) values.push(loss === 0 ? gain === 0 ? 50 : 100 : 100 - 100 / (1 + gain / loss));
  }
  return values;
}
const mean = (closes: readonly number[], n: number, end: number) => closes.slice(end - n, end).reduce((a, b) => a + b, 0) / n;
export type DailySession = { kind: "session"; close: number } | { kind: "closed" };
const DAY = 86_400_000;
/** Same allowance for delayed and live accounts: never judge a still-forming daily bar. */
export const DAILY_CLOSE_SETTLE_MS = 30 * 60_000;

export function latestSettledClose(now: number, session: (day: string) => DailySession | null): { day: string; at: number } {
  // Find the newest completed exchange session, including holidays and early closes.
  let latest: { day: string; at: number } | undefined;
  for (let offset = 0; offset < 15; offset++) {
    const day = new Date(now - offset * DAY).toISOString().slice(0, 10);
    const s = session(day);
    if (!s) throw new Error("Daily close calendar unavailable for this listing or date.");
    if (s.kind === "session" && s.close + DAILY_CLOSE_SETTLE_MS <= now) { latest = { day, at: s.close }; break; }
  }
  if (!latest) throw new Error("No completed daily close available.");
  return latest;
}

/** Cache only completed calculations; failed reads retry after five minutes, never on every poll. */
export class DailyMetricCache {
  private entries = new Map<string, { day: string; retryAt: number; result: Promise<MetricReading> }>();
  read(key: string, day: string, now: number, load: () => Promise<MetricReading>): Promise<MetricReading> {
    const cached = this.entries.get(key);
    if (cached?.day === day && now < cached.retryAt) return cached.result;
    const entry = { day, retryAt: Infinity, result: Promise.resolve().then(load) };
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > 5000) this.entries.delete(this.entries.keys().next().value!);
    void entry.result.catch(() => { entry.retryAt = now + 5 * 60_000; });
    return entry.result;
  }
}

export function dailyMetricReading(
  rule: MetricRule,
  bars: readonly { date: string; close: number }[],
  now: number,
  session: (day: string) => DailySession | null,
): MetricReading {
  const m = rule.metric!;
  if (!isDailyMetric(m) || !("period" in m)) throw new Error("Expected a daily technical alert.");
  const latest = latestSettledClose(now, session);
  const byDay = new Map<string, number>();
  for (const bar of bars) {
    const day = bar.date.slice(0, 10);
    if (day > latest.day) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !finite(bar.close) || bar.close <= 0 || byDay.has(day)) {
      throw new Error("Daily history contains an invalid or duplicate bar.");
    }
    byDay.set(day, bar.close);
  }
  const days = [...byDay.keys()].sort();
  if (days.at(-1) !== latest.day) throw new Error(`Waiting for the ${latest.day} daily close.`);
  const needed = m.kind === "close_ma" ? m.period : (m.kind === "ma_cross" ? m.slowPeriod : m.period) + 1;
  if (days.length < needed) throw new Error(`Need ${needed} completed daily bars; only ${days.length} available.`);
  // Never bridge a missing session. Weekends and published holidays are not missing bars.
  const start = m.kind === "rsi" ? days[0]! : days[days.length - needed]!;
  for (let time = Date.parse(start); time <= Date.parse(latest.day); time += DAY) {
    const day = new Date(time).toISOString().slice(0, 10);
    const s = session(day);
    if (!s) throw new Error("Daily close calendar unavailable for part of the history.");
    if (s.kind === "session" && !byDay.has(day)) throw new Error(`Daily history is missing ${day}.`);
    if (s.kind === "closed" && byDay.has(day)) throw new Error(`Unexpected daily bar on ${day}.`);
  }
  const closes = days.map(day => byDay.get(day)!);
  const end = closes.length;
  let value: number, target = rule.targetPrice, previousValue: number | undefined, previousTarget: number | undefined = target;
  if (m.kind === "rsi") {
    const values = rsi(closes, m.period);
    value = values.at(-1)!; previousValue = values.at(-2);
  } else if (m.kind === "close_ma") {
    value = closes[end - 1]!;
    target = mean(closes, m.period, end);
    previousTarget = undefined;
  } else {
    value = mean(closes, m.period, end);
    previousValue = mean(closes, m.period, end - 1);
    target = mean(closes, m.slowPeriod, end);
    previousTarget = mean(closes, m.slowPeriod, end - 1);
  }
  return { value, target, previousValue, previousTarget, day: latest.day, at: latest.at };
}

export function metricTrigger(rule: MetricRule, reading: MetricReading): "above" | "below" | "up" | "down" | null {
  if (rule.status !== "active" || !validMetricRule(rule) || !finite(reading.value) || !finite(reading.target)) return null;
  if (isDailyMetric(rule.metric!)) {
    if (!reading.day || reading.day <= (rule.lastDailyClose ?? "") || reading.at <= (rule.armedAt ?? rule.createdAt ?? Infinity)) return null;
  }
  if (rule.condition === "above") return reading.value > reading.target ? "above" : null;
  if (rule.condition === "below") return reading.value < reading.target ? "below" : null;
  const m = rule.metric!;
  if (m.kind !== "ma_cross" || !finite(reading.previousValue) || !finite(reading.previousTarget)) return null;
  if (m.direction === "above" && reading.previousValue <= reading.previousTarget && reading.value > reading.target) return "up";
  if (m.direction === "below" && reading.previousValue >= reading.previousTarget && reading.value < reading.target) return "down";
  return null;
}
