// Keep this model identical to the delivery model; the parity fixture checks both copies.
/** Synced separately from price rules so older clients cannot judge a ratio as a price. */
export const METRIC_ALERTS_KEY = "metricAlerts";
/** Relative strength has a list of its own too: a client that reads metricAlerts keeps none of it once it holds a measure it does not know. */
export const RELATIVE_ALERTS_KEY = "relativeAlerts";
export const ROTATION_QUADRANTS = ["leading", "weakening", "lagging", "improving"] as const;
export type RotationQuadrant = typeof ROTATION_QUADRANTS[number];
export type AlertMetric =
  | { kind: "pe" | "ps" }
  | { kind: "rsi"; period: number }
  | { kind: "close_ma"; period: number }
  | { kind: "ma_cross"; period: number; slowPeriod: number; direction: "above" | "below" }
  /** The listing's settled daily close divided by the benchmark's on the same session. */
  | { kind: "rs_ratio"; benchmark: string; benchmarkExchange?: string }
  /** The weekly RRG quadrant against the benchmark, entered on a published weekly close. */
  | { kind: "rrg"; quadrant: RotationQuadrant; benchmark: string; benchmarkExchange?: string };
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
const listing = (value: unknown): value is string => typeof value === "string" && /^[A-Z0-9.^=-]{1,20}$/.test(value);
const venue = (value: unknown) => value === undefined || (typeof value === "string" && /^[A-Z0-9._-]{1,24}$/.test(value));

export function readAlertMetric(raw: unknown): AlertMetric | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.kind === "pe" || m.kind === "ps") return { kind: m.kind };
  if ((m.kind === "rsi" || m.kind === "close_ma") && period(m.period)) return { kind: m.kind, period: m.period };
  if (m.kind === "ma_cross" && period(m.period) && period(m.slowPeriod) && m.period < m.slowPeriod
    && (m.direction === "above" || m.direction === "below")) {
    return { kind: m.kind, period: m.period, slowPeriod: m.slowPeriod, direction: m.direction };
  }
  if ((m.kind === "rs_ratio" || m.kind === "rrg") && listing(m.benchmark) && venue(m.benchmarkExchange)) {
    const benchmark = { benchmark: m.benchmark, ...(m.benchmarkExchange ? { benchmarkExchange: m.benchmarkExchange as string } : {}) };
    if (m.kind === "rs_ratio") return { kind: m.kind, ...benchmark };
    if (ROTATION_QUADRANTS.includes(m.quadrant as RotationQuadrant)) return { kind: m.kind, quadrant: m.quadrant as RotationQuadrant, ...benchmark };
  }
  return null;
}
export function isRelativeMetric(metric: AlertMetric): metric is Extract<AlertMetric, { benchmark: string }> {
  return metric.kind === "rs_ratio" || metric.kind === "rrg";
}
/** The synced list a rule belongs in. */
export function metricAlertsKey(metric: AlertMetric): string {
  return isRelativeMetric(metric) ? RELATIVE_ALERTS_KEY : METRIC_ALERTS_KEY;
}

export function validMetricRule(rule: Pick<MetricRule, "metric" | "condition" | "targetPrice">): boolean {
  const m = readAlertMetric(rule.metric);
  if (!m || !finite(rule.targetPrice)) return false;
  if (m.kind === "ma_cross" || m.kind === "rrg") return rule.condition === "crosses" && rule.targetPrice === 0;
  if (m.kind === "rs_ratio") return ["above", "below", "crosses"].includes(rule.condition) && rule.targetPrice > 0;
  if (rule.condition !== "above" && rule.condition !== "below") return false;
  return m.kind === "close_ma" ? rule.targetPrice === 0
    : m.kind === "rsi" ? rule.targetPrice >= 0 && rule.targetPrice <= 100 : rule.targetPrice > 0;
}

export function metricName(metric: AlertMetric): string {
  if (metric.kind === "pe") return "P/E (TTM)";
  if (metric.kind === "ps") return "P/S (TTM)";
  if (metric.kind === "rsi") return `RSI(${metric.period})`;
  if (metric.kind === "rs_ratio") return `Ratio to ${metric.benchmark}`;
  if (metric.kind === "rrg") return `RRG vs ${metric.benchmark}`;
  return metric.kind === "ma_cross" ? `${metric.period}-day MA` : "Close";
}
const quadrantName = (quadrant: RotationQuadrant) => `${quadrant[0]!.toUpperCase()}${quadrant.slice(1)}`;
export function metricDescription(rule: MetricRule & { symbol: string }): string {
  const m = rule.metric!;
  const basis = closeBasis(m);
  const suffix = basis ? ` · on ${basis}` : "";
  if (m.kind === "rs_ratio") return `${rule.symbol} ratio to ${m.benchmark} ${rule.condition} ${rule.targetPrice}${suffix}`;
  if (m.kind === "rrg") return `${rule.symbol} ${metricName(m)} enters ${quadrantName(m.quadrant)}${suffix}`;
  const target = m.kind === "ma_cross" ? `${m.slowPeriod}-day MA`
    : m.kind === "close_ma" ? `${m.period}-day MA` : String(rule.targetPrice);
  const condition = m.kind === "ma_cross" ? `crosses ${m.direction}` : rule.condition;
  return `${rule.symbol} ${metricName(m)} ${condition} ${target}${suffix}`;
}
/** Judged on settled closes only, never a forming session; RRG quadrants on weekly ones. */
export function isDailyMetric(metric: AlertMetric): boolean {
  return metric.kind !== "pe" && metric.kind !== "ps";
}
export function closeBasis(metric: AlertMetric): "daily close" | "weekly close" | null {
  return metric.kind === "rrg" ? "weekly close" : isDailyMetric(metric) ? "daily close" : null;
}
/** The reading as alerts state it: 31.2x, 0.2512, or Leading (strength 101.23, momentum 100.40) as RRG words them. */
export function metricReadingText(metric: AlertMetric, reading: Pick<MetricReading, "value" | "target">): string {
  if (metric.kind === "rrg") {
    return `${rotationQuadrant(reading.value, reading.target) ?? "No quadrant"} (strength ${reading.value.toFixed(2)}, momentum ${reading.target.toFixed(2)})`;
  }
  return `${Number(reading.value.toFixed(4))}${metric.kind === "pe" || metric.kind === "ps" ? "x" : ""}`;
}

export type RotationQuadrantName = "Leading" | "Weakening" | "Lagging" | "Improving" | "Neutral";
export function rotationQuadrant(strength: number | null | undefined, momentum: number | null | undefined): RotationQuadrantName | null {
  if (strength == null || momentum == null || !finite(strength) || !finite(momentum)) return null;
  if (Math.abs(strength - 100) < 1e-9 || Math.abs(momentum - 100) < 1e-9) return "Neutral";
  return strength > 100 ? momentum > 100 ? "Leading" : "Weakening" : momentum > 100 ? "Improving" : "Lagging";
}
/**
 * Weekly strength (RS-Ratio: 100 x the price ratio over its 13-week mean) and momentum (RS-Momentum: 100 x
 * strength over strength four weeks earlier), as RRG plots them. A missing week breaks both until 13 and 17 contiguous weeks.
 */
export function rotationSeries(ratios: readonly (number | null)[]): { strength: number | null; momentum: number | null }[] {
  const strengths = ratios.map((ratio, index) => {
    const window = ratios.slice(Math.max(0, index - 12), index + 1);
    if (ratio == null || window.length !== 13 || window.some((value) => value == null)) return null;
    const average = (window as number[]).reduce((sum, value) => sum + value, 0) / 13;
    return (100 * ratio) / average;
  });
  return strengths.map((strength, index) => {
    const previous = index >= 4 ? (strengths[index - 4] ?? null) : null;
    const contiguous = index >= 4 && strengths.slice(index - 4, index + 1).every((value) => value != null);
    return { strength, momentum: strength != null && previous != null && contiguous ? (100 * strength) / previous : null };
  });
}
/** Weeks a quadrant change needs: 17 for this week's momentum, and the week before it. */
export const ROTATION_ALERT_WEEKS = 18;

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

type DailyBar = { date: string; close: number };
function closesThrough(bars: readonly DailyBar[], through: string): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const bar of bars) {
    const day = bar.date.slice(0, 10);
    if (day > through) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !finite(bar.close) || bar.close <= 0 || byDay.has(day)) {
      throw new Error("Daily history contains an invalid or duplicate bar.");
    }
    byDay.set(day, bar.close);
  }
  return byDay;
}
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);
function sessionBefore(day: string, session: (day: string) => DailySession | null): string {
  for (let offset = 1; offset < 15; offset++) {
    const previous = isoDay(Date.parse(day) - offset * DAY);
    const s = session(previous);
    if (!s) throw new Error("Daily close calendar unavailable for part of the history.");
    if (s.kind === "session") return previous;
  }
  throw new Error(`No session before ${day}.`);
}
/** The last session of each Monday-Friday week, oldest first, ending with the newest week whose close has settled. */
export function settledWeekCloses(now: number, session: (day: string) => DailySession | null, count: number): { day: string; at: number }[] {
  const latest = latestSettledClose(now, session);
  const close = (friday: number) => {
    for (let offset = 0; offset < 5; offset++) {
      const day = isoDay(friday - offset * DAY);
      const s = session(day);
      if (!s) throw new Error("Daily close calendar unavailable for part of the history.");
      if (s.kind === "session") return { day, at: s.close };
    }
    throw new Error(`No session in the week ending ${isoDay(friday)}.`);
  };
  const time = Date.parse(latest.day);
  let friday = time + ((5 - new Date(time).getUTCDay() + 7) % 7) * DAY;
  // A week whose last session is still ahead or forming has no weekly close yet.
  if (close(friday).day !== latest.day) friday -= 7 * DAY;
  return Array.from({ length: count }, (_, index) => close(friday - (count - 1 - index) * 7 * DAY));
}

/** Both listings' own closes on the same sessions; a session either lacks is never bridged from another day. */
function relativeMetricReading(
  rule: MetricRule,
  m: Extract<AlertMetric, { benchmark: string }>,
  bars: readonly DailyBar[],
  benchmarkBars: readonly DailyBar[],
  now: number,
  session: (day: string) => DailySession | null,
): MetricReading {
  const latest = latestSettledClose(now, session);
  const own = closesThrough(bars, latest.day), reference = closesThrough(benchmarkBars, latest.day);
  const ratio = (day: string) => {
    const close = own.get(day), base = reference.get(day);
    if (close == null || base == null) {
      if (day === latest.day) throw new Error(`Waiting for the ${latest.day} ${m.kind === "rrg" ? "weekly" : "daily"} close${close == null ? "" : ` of ${m.benchmark}`}.`);
      throw new Error(`Daily history is missing ${day}${close == null ? "" : ` for ${m.benchmark}`}.`);
    }
    return close / base;
  };
  if (m.kind === "rs_ratio") {
    const value = ratio(latest.day), previousValue = ratio(sessionBefore(latest.day, session));
    return { value, target: rule.targetPrice, previousValue, previousTarget: rule.targetPrice, day: latest.day, at: latest.at };
  }
  const weeks = settledWeekCloses(now, session, ROTATION_ALERT_WEEKS);
  const [before, last] = rotationSeries(weeks.map((week) => ratio(week.day))).slice(-2);
  if (before?.strength == null || before.momentum == null || last?.strength == null || last.momentum == null) {
    throw new Error(`Need ${ROTATION_ALERT_WEEKS} contiguous weekly closes.`);
  }
  const week = weeks.at(-1)!;
  return { value: last.strength, target: last.momentum, previousValue: before.strength, previousTarget: before.momentum, day: week.day, at: week.at };
}

/** RS ratios and RRG quadrants take the benchmark's completed daily bars as well. */
export function dailyMetricReading(
  rule: MetricRule,
  bars: readonly DailyBar[],
  now: number,
  session: (day: string) => DailySession | null,
  benchmarkBars?: readonly DailyBar[],
): MetricReading {
  const m = rule.metric!;
  if (m.kind === "rs_ratio" || m.kind === "rrg") {
    if (!benchmarkBars) throw new Error(`Completed daily history for ${m.benchmark} is required.`);
    return relativeMetricReading(rule, m, bars, benchmarkBars, now, session);
  }
  if (!isDailyMetric(m) || !("period" in m)) throw new Error("Expected a daily technical alert.");
  const latest = latestSettledClose(now, session);
  const byDay = closesThrough(bars, latest.day);
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
  const m = rule.metric!;
  if (m.kind === "rrg") {
    // Fires on entering the quadrant, not on a week already inside it.
    const before = rotationQuadrant(reading.previousValue, reading.previousTarget)?.toLowerCase();
    return before && before !== m.quadrant && rotationQuadrant(reading.value, reading.target)?.toLowerCase() === m.quadrant ? "up" : null;
  }
  if (rule.condition === "above") return reading.value > reading.target ? "above" : null;
  if (rule.condition === "below") return reading.value < reading.target ? "below" : null;
  if (m.kind === "rs_ratio") {
    if (!finite(reading.previousValue)) return null;
    if (reading.previousValue <= reading.target && reading.value > reading.target) return "up";
    return reading.previousValue >= reading.target && reading.value < reading.target ? "down" : null;
  }
  if (m.kind !== "ma_cross" || !finite(reading.previousValue) || !finite(reading.previousTarget)) return null;
  if (m.direction === "above" && reading.previousValue <= reading.previousTarget && reading.value > reading.target) return "up";
  if (m.direction === "below" && reading.previousValue >= reading.previousTarget && reading.value < reading.target) return "down";
  return null;
}
