import type { DataProvider } from "../../../types/data-provider";
import type { GloomPluginContext } from "../../../types/plugin";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { withDeadline } from "../../../utils/async-deadline";
import { errorMessage } from "../../../utils/errors";
import { createSurfaceDependencies, loadVolatilitySurface, withReusedYieldCurve, type SurfaceLoaderDependencies } from "../vol-surface/client";
import { buildSurfaceGrid, DEFAULT_SURFACE_SETTINGS, type SurfaceExpiry, type SurfaceSnapshot } from "../vol-surface/model";
import { IV_LEVEL_ALERTS_KEY, readEventAlerts, updateEventAlerts, type EventAlertRule } from "./events";
import { type FiredAlertInput } from "./fired-log";
import { formatIvLevel, IV_LEVEL_NAMES, researchAlertDescription } from "./research-builder";
import { readResearchRule, type IvLevelMetric, type ResearchAlertConfig } from "./research-rules";

/** OVDV's 1M fixed tenor: the constant maturity an IV level rule reads. */
const IV_LEVEL_TENOR = { label: "1M", years: 30 / 365 };
/** OVDV's delta axis at that tenor: the 25-delta put, ATM (the delta-neutral strike) and the 25-delta call. */
const IV_LEVEL_DELTAS = [-0.25, 0, 0.25] as const;
/**
 * A tenor with listed expiries on one side only is carried flat from the
 * nearest (OVDV marks it E); an IV level takes that only from an expiry this
 * close to 30 days.
 */
const MAX_EXTRAPOLATION_DAYS = 10;
/** Option quotes move through the session; readings are taken this often while the app runs. */
const CHECK_INTERVAL_MS = 15 * 60_000;
const FIRST_CHECK_DELAY_MS = 8_000;
/** A symbol's option chains that have not all arrived by then are given up on until the next check. */
const LOAD_TIMEOUT_MS = 60_000;

/**
 * The device's last reading of each IV level rule, by rule id, in plugin
 * resume state: never synced, so a reading every 15 minutes writes nothing
 * another device pulls, and a pull never takes one away.
 */
export const IV_LEVEL_CHECKS_KEY = "ivLevelChecks";

/** One check of an IV level rule: the level in the rule's unit, and the option quotes it was read from. */
export interface IvLevelCheck {
  checkedAt: number;
  /** % IV for an ATM rule, vol points for a risk reversal; null when the check found none. */
  value: number | null;
  /** When the option quotes behind the reading were observed. */
  quoteAt?: string;
  /** How current those quotes are: `real-time`, `15 min delayed`. */
  source?: string;
  /** Why there was no reading. */
  error?: string;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 300;

/** The saved readings that read; anything else is dropped, and the next check writes it again. */
export function readIvLevelChecks(value: unknown): Record<string, IvLevelCheck> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const checks: Record<string, IvLevelCheck> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const check = raw as Record<string, unknown>;
    if (!Number.isFinite(check.checkedAt) || (check.value !== null && !Number.isFinite(check.value))) continue;
    checks[id] = {
      checkedAt: check.checkedAt as number,
      value: check.value as number | null,
      ...(isText(check.quoteAt) ? { quoteAt: check.quoteAt } : {}),
      ...(isText(check.source) ? { source: check.source } : {}),
      ...(isText(check.error) ? { error: check.error } : {}),
    };
  }
  return checks;
}

/**
 * An IV level rule's symbol's 30-day ATM IV and 25-delta risk reversal, in
 * decimals: the 1M row of OVDV's Table on the delta axis with fixed tenors
 * (ATM, 25dP and 25dC), solved at 30 days on the same fits. Null with `error`
 * when the chain gives none.
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

/** How current option quotes are, worded as reports word a feed. */
function feedWords(expiries: readonly Pick<SurfaceExpiry, "dataSource" | "delayMinutes">[]): string | null {
  if (expiries.length === 0) return null;
  if (expiries.every((expiry) => expiry.dataSource === "live")) return "real-time";
  const delay = Math.max(0, ...expiries.map((expiry) => expiry.delayMinutes ?? 0));
  if (expiries.some((expiry) => expiry.dataSource === "delayed")) return delay > 0 ? `${delay} min delayed` : "delayed";
  return null;
}

/**
 * The 30-day reading of a surface as OVDV loads it: its own fixed-tenor solve
 * (`buildSurfaceGrid`), so the figure is the one OVDV shows, with the time and
 * feed of the expiries either side of 30 days that it comes from.
 */
export function ivLevelReading(snapshot: Pick<SurfaceSnapshot, "spot" | "expiries" | "failures">): IvLevelReading {
  const grid = buildSurfaceGrid(snapshot as SurfaceSnapshot, {
    axis: "delta", tenors: "fixed", fixedTenors: [IV_LEVEL_TENOR], coordinates: IV_LEVEL_DELTAS,
  });
  const row = grid.rows[0];
  // The expiries the solve stands on: the ones either side of 30 days, or the nearest when there is one side only.
  const available = snapshot.expiries
    .filter((expiry) => expiry.fit && expiry.forward != null && expiry.rate != null && expiry.dividendYield != null)
    .sort((a, b) => a.years - b.years);
  const right = available.findIndex((expiry) => expiry.years >= IV_LEVEL_TENOR.years);
  const used = right < 0 ? available.slice(-1) : right === 0 ? available.slice(0, 1) : available.slice(right - 1, right + 1);
  const tooFar = !!row?.extrapolated && used.every((expiry) => Math.abs(expiry.years - IV_LEVEL_TENOR.years) * 365 > MAX_EXTRAPOLATION_DAYS);
  const [put, atm, call] = tooFar || !row ? [null, null, null] : row.cells.map((cell) => cell.volatility);
  const rr = put != null && call != null ? call - put : null;
  const quoteAt = used.map((expiry) => expiry.asOf).filter((value): value is string => !!value).sort().at(-1) ?? null;
  const error = atm == null && rr == null
    ? snapshot.failures.find((failure) => failure.message)?.message ?? snapshot.expiries.find((expiry) => expiry.error)?.error
      ?? "No clean option quotes near 30 days"
    : undefined;
  return { atm: atm ?? null, rr, quoteAt, source: feedWords(used), ...(error ? { error } : {}) };
}

/** The symbol's listing as an option chain is requested: a research rule's `US` names no venue. */
const instrumentOf = (config: Pick<ResearchAlertConfig, "symbol" | "exchange">) => ({
  symbol: config.symbol!,
  ...(config.exchange && config.exchange !== "US" ? { exchange: config.exchange } : {}),
});

/** The symbol's surface as OVDV loads it by default: the same expiries, settings and spot. */
async function loadIvLevelReading(
  config: Pick<ResearchAlertConfig, "symbol" | "exchange">,
  marketData: Pick<DataProvider, "getQuote">,
  dependencies: SurfaceLoaderDependencies,
  signal: AbortSignal,
): Promise<IvLevelReading> {
  const instrument = instrumentOf(config);
  const quote = await marketData.getQuote(instrument.symbol, instrument.exchange);
  if (!quote || !(quote.price > 0) || !Number.isFinite(quote.price) || quote.stale) throw new Error(`No current price for ${instrument.symbol}`);
  const snapshot = await loadVolatilitySurface({
    instrument, spot: quote.price, spotAsOf: quote.lastUpdated, quote, settings: DEFAULT_SURFACE_SETTINGS, signal,
  }, dependencies);
  return ivLevelReading(snapshot);
}

/** The reading an IV level rule follows, in its unit: % IV for ATM, vol points for a risk reversal. */
function ivLevelValue(reading: IvLevelReading, metric: IvLevelMetric): number | null {
  const value = metric === "atm" ? reading.atm : reading.rr;
  return value == null ? null : Number((value * 100).toFixed(2));
}

/** Whether a reading is past the rule's level, above it or below it, as a price alert's `above` and `below` are. */
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
    ...(value == null ? { error: reading.error ?? (metric === "rr" ? "No 25-delta quotes near 30 days" : "No ATM quotes near 30 days") } : {}),
  };
}

/** "IBIT 30d ATM IV 52.31% is above 50%". */
function ivLevelMessage(config: ResearchAlertConfig, value: number): string {
  const metric = config.metric as IvLevelMetric;
  return `${config.symbol} ${IV_LEVEL_NAMES[metric]} ${formatIvLevel(metric, value)} is ${config.direction} ${formatIvLevel(metric, config.threshold ?? 0)}`;
}

/**
 * An IV level rule's last check, for its row: "52.31% · quotes 10-22 20:14 UTC, 15 min delayed", the reason
 * there was no reading, or that the running app has not checked it yet.
 */
export function ivLevelCheckText(rule: Pick<EventAlertRule, "value">, check: IvLevelCheck | undefined): string {
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

export interface IvLevelAlertOptions {
  /** One symbol's reading; it is given up on when `signal` aborts. */
  load?: (config: ResearchAlertConfig, signal: AbortSignal) => Promise<IvLevelReading>;
  now?: () => number;
  /** How long one symbol's reading may take; about a minute. */
  timeoutMs?: number;
}

/**
 * Takes a reading for every active IV level rule while the app runs, one per
 * symbol, and keeps it on the device for the Events tab. A rule whose reading
 * is past its level, above or below it as a price alert's is (so one added or
 * re-armed already past it goes off at that check), is saved as Alerted first
 * and then notified, once: a save that fails tells no one, so the next check
 * cannot tell twice. The rule then reads Alerted until it is re-armed. Synced
 * config changes only then. With no such rules it requests nothing.
 */
export function startIvLevelAlerts(
  ctx: Pick<GloomPluginContext, "configState" | "resume" | "notify" | "showPane" | "log" | "marketData">,
  record: (entry: FiredAlertInput) => void,
  options: IvLevelAlertOptions = {},
): () => void {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? LOAD_TIMEOUT_MS;
  let dependencies: SurfaceLoaderDependencies | null = null;
  // OVDV's chains, through the coordinator the panes share, so a symbol open in OVDV is read once.
  const load = options.load ?? ((config: ResearchAlertConfig, signal: AbortSignal) => {
    dependencies ??= withReusedYieldCurve(createSurfaceDependencies(getSharedMarketDataCoordinator() ? undefined : ctx.marketData));
    return loadIvLevelReading(config, ctx.marketData, dependencies, signal);
  });
  let stopped = false;
  let running = false;
  let rerun = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const read = () => readEventAlerts(ctx.configState.get<string>(IV_LEVEL_ALERTS_KEY) ?? "[]");
  const watched = (rule: EventAlertRule) => rule.kind === "iv_level" && rule.status === "active" && !rule.triggeredAt;
  const configOf = (rule: EventAlertRule) => readResearchRule("iv_level", rule.value);
  const keyOf = (config: ResearchAlertConfig) => `${config.symbol}:${config.exchange ?? ""}`;

  /** One symbol's reading, or why there was none: a failure, or no answer within `timeoutMs`. */
  const readingFor = async (config: ResearchAlertConfig): Promise<IvLevelReading | Error> => {
    const abort = new AbortController();
    try {
      return await withDeadline(load(config, abort.signal), timeoutMs,
        `Option quotes for ${config.symbol} did not arrive within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`,
        () => abort.abort());
    } catch (failure) {
      ctx.log.warn("IV level unavailable", { symbol: config.symbol, error: errorMessage(failure) });
      return new Error(errorMessage(failure));
    }
  };

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
    // One symbol at a time: each reads OVDV's option chains.
    for (const [key, config] of symbols) {
      if (stopped) return;
      readings.set(key, await readingFor(config));
    }
    if (stopped) return;
    // Read again: the pane or a sync may have changed the rules while the chains loaded.
    const current = read();
    if (current.error) return;
    const checkedAt = now();
    const saved = readIvLevelChecks(ctx.resume.getState(IV_LEVEL_CHECKS_KEY));
    const checks: Record<string, IvLevelCheck> = {};
    const reached = new Map<string, { config: ResearchAlertConfig; check: IvLevelCheck }>();
    for (const rule of current.rules) {
      const config = watched(rule) ? configOf(rule) : null;
      const reading = config ? readings.get(keyOf(config)) : undefined;
      if (!config || !reading) {
        // A rule not read this time keeps its last reading; a deleted one's goes.
        if (saved[rule.id]) checks[rule.id] = saved[rule.id]!;
        continue;
      }
      const result = ivLevelCheck(reading, config.metric as IvLevelMetric, checkedAt);
      checks[rule.id] = result;
      if (ivLevelReached(config, result.value)) reached.set(rule.id, { config, check: result });
    }
    try {
      ctx.resume.setState(IV_LEVEL_CHECKS_KEY, checks);
    } catch (failure) {
      ctx.log.warn("IV level readings not kept", { error: errorMessage(failure) });
    }
    if (reached.size === 0 || stopped) return;

    // Alerted on every device before anyone is told; only rules still watching when it is saved go off.
    const fired: EventAlertRule[] = [];
    const next = updateEventAlerts(ctx.configState.get<string>(IV_LEVEL_ALERTS_KEY), (latest) => latest.map((rule) => {
      if (!reached.has(rule.id) || !watched(rule)) return rule;
      fired.push(rule);
      return { ...rule, triggeredAt: checkedAt };
    }));
    if (fired.length === 0) return;
    try {
      await ctx.configState.set(IV_LEVEL_ALERTS_KEY, next);
    } catch (failure) {
      ctx.log.warn("IV level alert not saved, so not sent", { error: errorMessage(failure) });
      return;
    }
    for (const rule of fired) {
      const { config, check: result } = reached.get(rule.id)!;
      const metric = config.metric as IvLevelMetric;
      ctx.notify({
        body: ivLevelMessage(config, result.value!),
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
    }
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
