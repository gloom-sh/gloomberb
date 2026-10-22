import type { DataProvider } from "../../../types/data-provider";
import type { GloomPluginContext } from "../../../types/plugin";
import { resolveEntryValue } from "../../../market-data/coordinator";
import { errorMessage } from "../../../utils/errors";
import { daysToExpiryFrom, interpolateTotalVariance, type VolatilityTenorPoint } from "../shared/volatility";
import { createSurfaceDependencies, loadVolatilitySurface, type SurfaceLoaderDependencies } from "../vol-surface/client";
import type { SurfaceExpiry } from "../vol-surface/model";
import { TERM_SLOPE_MIN_DAYS } from "../vol-surface/tables";
import { EVENT_ALERTS_KEY, readEventAlerts, type EventAlertRule, type IvLevelCheck } from "./events";
import { type FiredAlertInput } from "./fired-log";
import { formatIvLevel, IV_LEVEL_NAMES, researchAlertDescription } from "./research-builder";
import { readResearchRule, type IvLevelMetric, type ResearchAlertConfig } from "./research-rules";

/** The constant maturity an IV level rule reads, in calendar days. */
const IV_LEVEL_DAYS = 30;
/**
 * A front expiry this close is left out of the reading, as OVDV leaves it out
 * of its term slope: a few days of IV are mostly noise.
 */
const MIN_EXPIRY_DAYS = TERM_SLOPE_MIN_DAYS;
/** A reading carried flat from the nearest expiry when none is listed on one side of 30 days, if it is this close. */
const MAX_EXTRAPOLATION_DAYS = 10;
/** Option quotes move through the session; readings are taken this often while the app runs. */
const CHECK_INTERVAL_MS = 15 * 60_000;
const FIRST_CHECK_DELAY_MS = 8_000;

/**
 * An IV level rule's symbol's 30-day ATM IV and 25-delta risk reversal, in
 * decimals, read from the listed expiries OVDV fits: its Term view's ATM IV and
 * 25D put and call IVs for the expiries either side of 30 days, interpolated
 * in total variance as OVDV's fixed tenors are. Null with `error` when the
 * chain gives none.
 */
export interface IvLevelReading {
  atm: number | null;
  rr: number | null;
  /** When the newest option quotes behind it were observed. */
  quoteAt: string | null;
  /** How current those quotes are: `real-time`, `15 min delayed`, `delayed`. */
  source: string | null;
  error?: string;
}

/**
 * The listed expiries a 30-day reading needs: the two nearest on each side of
 * 30 days, a week out or more, so one with no clean smile still leaves one.
 */
export function ivLevelExpiries(catalogue: readonly number[], now: number): number[] {
  const listed = [...new Set(catalogue)]
    .map((expiration) => ({ expiration, days: daysToExpiryFrom(expiration, now) }))
    .filter((entry) => entry.days >= MIN_EXPIRY_DAYS)
    .sort((a, b) => a.days - b.days);
  const before = listed.filter((entry) => entry.days <= IV_LEVEL_DAYS).slice(-2);
  const after = listed.filter((entry) => entry.days > IV_LEVEL_DAYS).slice(0, 2);
  return [...before, ...after].map((entry) => entry.expiration);
}

/** How current option quotes are, worded as reports word a feed. */
function feedWords(expiries: readonly Pick<SurfaceExpiry, "dataSource" | "delayMinutes">[]): string | null {
  if (expiries.length === 0) return null;
  if (expiries.every((expiry) => expiry.dataSource === "live")) return "real-time";
  const delay = Math.max(0, ...expiries.map((expiry) => expiry.delayMinutes ?? 0));
  if (expiries.some((expiry) => expiry.dataSource === "delayed")) return delay > 0 ? `${delay} min delayed` : "delayed";
  return null;
}

/** One measure at 30 days: total-variance interpolation between the expiries either side, flat from a near one. */
function at30Days(points: readonly VolatilityTenorPoint[]): number | null {
  const reading = interpolateTotalVariance(points, IV_LEVEL_DAYS / 365);
  if (!reading) return null;
  if (reading.extrapolated && Math.abs(reading.sourceYears[0] * 365 - IV_LEVEL_DAYS) > MAX_EXTRAPOLATION_DAYS) return null;
  return reading.volatility;
}

/** The 30-day reading from fitted expiries (`ivLevelExpiries` of a chain), with the quotes it came from. */
export function ivLevelReading(expiries: readonly SurfaceExpiry[]): IvLevelReading {
  const fitted = expiries.filter((expiry) => expiry.fit && !expiry.error);
  const atmPoints = fitted.flatMap((expiry) => expiry.atmIV == null ? [] : [{ years: expiry.years, volatility: expiry.atmIV }]);
  const winged = fitted.filter((expiry) => expiry.skew.put25 != null && expiry.skew.call25 != null);
  const put = at30Days(winged.map((expiry) => ({ years: expiry.years, volatility: expiry.skew.put25! })));
  const call = at30Days(winged.map((expiry) => ({ years: expiry.years, volatility: expiry.skew.call25! })));
  const atm = at30Days(atmPoints);
  const rr = put != null && call != null ? call - put : null;
  const used = fitted.filter((expiry) => expiry.atmIV != null);
  const quoteAt = used.map((expiry) => expiry.asOf).filter((value): value is string => !!value).sort().at(-1) ?? null;
  const error = atm == null && rr == null
    ? expiries.find((expiry) => expiry.error)?.error ?? `No clean option quotes near ${IV_LEVEL_DAYS} days`
    : undefined;
  return { atm, rr, quoteAt, source: feedWords(used), ...(error ? { error } : {}) };
}

/** The symbol's listing as an option chain is requested: a research rule's `US` names no venue. */
const instrumentOf = (config: Pick<ResearchAlertConfig, "symbol" | "exchange">) => ({
  symbol: config.symbol!,
  ...(config.exchange && config.exchange !== "US" ? { exchange: config.exchange } : {}),
});

/** Loads the expiries around 30 days, fits them as OVDV does at the current price, and reads the levels. */
async function loadIvLevelReading(
  config: Pick<ResearchAlertConfig, "symbol" | "exchange">,
  marketData: Pick<DataProvider, "getQuote">,
  dependencies: SurfaceLoaderDependencies,
  now = Date.now(),
): Promise<IvLevelReading> {
  const instrument = instrumentOf(config);
  const quote = await marketData.getQuote(instrument.symbol, instrument.exchange);
  if (!quote || !(quote.price > 0) || !Number.isFinite(quote.price)) throw new Error(`No current price for ${instrument.symbol}`);
  const catalogue = await dependencies.loadOptions({ instrument });
  const chain = resolveEntryValue(catalogue);
  if (!chain) throw new Error(catalogue.error?.message ?? `No option chain for ${instrument.symbol}`);
  const expiries = ivLevelExpiries(chain.expirationDates, now);
  if (expiries.length === 0) throw new Error(`No listed expiry near ${IV_LEVEL_DAYS} days`);
  const snapshot = await loadVolatilitySurface({ instrument, spot: quote.price, spotAsOf: quote.lastUpdated, quote, expiries }, dependencies);
  return ivLevelReading(snapshot.expiries);
}

/** The reading an IV level rule follows, in its unit: % IV for ATM, vol points for a risk reversal. */
function ivLevelValue(reading: IvLevelReading, metric: IvLevelMetric): number | null {
  const value = metric === "atm" ? reading.atm : reading.rr;
  return value == null ? null : Number((value * 100).toFixed(2));
}

/** Whether a reading has reached the rule's level: above it, or below it. */
function ivLevelReached(config: Pick<ResearchAlertConfig, "direction" | "threshold">, value: number | null): boolean {
  if (value == null || config.threshold == null) return false;
  return config.direction === "below" ? value < config.threshold : value > config.threshold;
}

/** A rule's check from a reading, or from the reason there was none. */
function ivLevelCheck(reading: IvLevelReading | Error, metric: IvLevelMetric, checkedAt: number): IvLevelCheck {
  if (reading instanceof Error) return { checkedAt, value: null, error: reading.message };
  const value = ivLevelValue(reading, metric);
  return {
    checkedAt,
    value,
    ...(reading.quoteAt ? { quoteAt: reading.quoteAt } : {}),
    ...(reading.source ? { source: reading.source } : {}),
    ...(value == null ? { error: reading.error ?? (metric === "rr" ? `No 25-delta quotes near ${IV_LEVEL_DAYS} days` : `No ATM quotes near ${IV_LEVEL_DAYS} days`) } : {}),
  };
}

/** "IBIT 30d ATM IV 52.31% is above 50%". */
function ivLevelMessage(config: ResearchAlertConfig, value: number): string {
  const metric = config.metric as IvLevelMetric;
  return `${config.symbol} ${IV_LEVEL_NAMES[metric]} ${formatIvLevel(metric, value)} is ${config.direction} ${formatIvLevel(metric, config.threshold ?? 0)}`;
}

/**
 * An IV level rule's last check, for its row: "52.31% · quotes 20:14 UTC, 15 min delayed", the reason
 * there was no reading, or that the running app has not checked it yet.
 */
export function ivLevelCheckText(rule: Pick<EventAlertRule, "value" | "check">): string {
  const check = rule.check;
  if (!check) return "Not checked yet";
  const metric = readResearchRule("iv_level", rule.value)?.metric as IvLevelMetric | undefined;
  if (check.value == null || !metric) return check.error ?? "No reading";
  const quoted = check.quoteAt ? new Date(check.quoteAt) : null;
  const when = quoted && Number.isFinite(quoted.getTime())
    ? `quotes ${quoted.toISOString().slice(5, 16).replace("T", " ")} UTC` : null;
  return [formatIvLevel(metric, check.value), [when, check.source].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
}

/** A rule that went off arms again; its last reading stays until the next check. */
export function rearmIvLevelAlert(rule: EventAlertRule): EventAlertRule {
  const { triggeredAt: _triggered, ...rest } = rule;
  return rest;
}

let checkNow: (() => void) | null = null;

/** Check at once, after a rule was added or re-armed, rather than at the next interval. */
export function checkIvLevelAlertsNow(): void {
  checkNow?.();
}

/**
 * Takes a reading for every active IV level rule while the app runs, one per
 * symbol, keeps it on the rule so the Events tab can show it, and notifies
 * once when the level is reached. The rule then reads Alerted until it is
 * re-armed. With no such rules it requests nothing.
 */
export function startIvLevelAlerts(
  ctx: Pick<GloomPluginContext, "configState" | "notify" | "showPane" | "log" | "marketData">,
  record: (entry: FiredAlertInput) => void,
  load: (config: ResearchAlertConfig) => Promise<IvLevelReading> = (() => {
    const dependencies = createSurfaceDependencies(ctx.marketData);
    return (config) => loadIvLevelReading(config, ctx.marketData, dependencies);
  })(),
  now: () => number = Date.now,
): () => void {
  let stopped = false;
  let running = false;
  let rerun = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const read = () => readEventAlerts(ctx.configState.get<string>(EVENT_ALERTS_KEY) ?? "[]");
  const watched = (rule: EventAlertRule) => rule.kind === "iv_level" && rule.status === "active" && !rule.triggeredAt;
  const configOf = (rule: EventAlertRule) => readResearchRule("iv_level", rule.value);
  const keyOf = (config: ResearchAlertConfig) => `${config.symbol}:${config.exchange ?? ""}`;

  const check = async () => {
    const { rules, error } = read();
    if (error) return;
    const symbols = new Map<string, ResearchAlertConfig>();
    for (const rule of rules.filter(watched)) {
      const config = configOf(rule);
      if (config) symbols.set(keyOf(config), config);
    }
    if (symbols.size === 0) return;
    const readings = new Map<string, IvLevelReading | Error>();
    // One symbol at a time: each reads a few option chains.
    for (const [key, config] of symbols) {
      if (stopped) return;
      try {
        readings.set(key, await load(config));
      } catch (failure) {
        readings.set(key, new Error(errorMessage(failure)));
        ctx.log.warn("IV level unavailable", { symbol: config.symbol, error: errorMessage(failure) });
      }
    }
    if (stopped) return;
    // Read again: the pane or a sync may have changed the rules while the chains loaded.
    const current = read();
    if (current.error) return;
    const checkedAt = now();
    const next = current.rules.map((rule): EventAlertRule => {
      const config = watched(rule) ? configOf(rule) : null;
      const reading = config ? readings.get(keyOf(config)) : undefined;
      if (!config || !reading) return rule;
      const metric = config.metric as IvLevelMetric;
      const result = ivLevelCheck(reading, metric, checkedAt);
      if (!ivLevelReached(config, result.value)) return { ...rule, check: result };
      const message = ivLevelMessage(config, result.value!);
      ctx.notify({
        body: message,
        type: "success",
        desktop: "always",
        persistent: true,
        sound: "Glass",
        action: { label: "Open", onClick: () => ctx.showPane("alerts") },
      });
      record({
        kind: "iv_level", ruleId: rule.id, rule: researchAlertDescription(rule), firedAt: checkedAt,
        value: result.value, unit: metric === "atm" ? "%" : "vol pts",
        quoteAt: result.quoteAt ?? null, source: result.source ?? null,
        symbol: config.symbol, ...(config.exchange && config.exchange !== "US" ? { exchange: config.exchange } : {}),
      });
      return { ...rule, check: result, triggeredAt: checkedAt };
    });
    if (!stopped) await ctx.configState.set(EVENT_ALERTS_KEY, JSON.stringify(next));
  };

  const run = async () => {
    if (stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      await check();
    } catch (failure) {
      if (!stopped) ctx.log.warn("IV level alerts check failed", { error: errorMessage(failure) });
    } finally {
      running = false;
      if (!stopped) {
        if (rerun) {
          rerun = false;
          void run();
        } else {
          timer = setTimeout(() => void run(), CHECK_INTERVAL_MS);
        }
      }
    }
  };

  timer = setTimeout(() => void run(), FIRST_CHECK_DELAY_MS);
  const trigger = () => void run();
  checkNow = trigger;
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (checkNow === trigger) checkNow = null;
  };
}
