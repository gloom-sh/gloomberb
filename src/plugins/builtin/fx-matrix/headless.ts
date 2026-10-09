import type { HeadlessPaneDefinition, HeadlessRowsResult } from "../../../types/plugin";
import { resolveEntryData } from "../../../market-data/selectors";
import { formatPercentRaw } from "../../../utils/format";
import { isFxRateStale } from "../../../utils/fx-status";
import { formatUtcTime } from "../../../utils/utc-time";
import { loadFxBoard, type FxBoardLoad, type FxLegReading } from "./client";
import { crossMovePercent } from "./direction";
import { CURRENCY_SETS, FX_CURRENCIES, formatRate, resolveCurrencies, type FxCurrency } from "./pairs";

const iso = (time: number | null | undefined) => time != null && Number.isFinite(time) ? new Date(time).toISOString() : null;

/** USD as the base of every leg: rate and previous close 1, never stale, no observation of its own. */
function legRate(reading: FxLegReading | undefined, currency: string): number | null {
  if (currency === "USD") return 1;
  const rate = resolveEntryData(reading?.entry);
  return rate != null && Number.isFinite(rate) && rate > 0 ? rate : null;
}

function legFeed(reading: FxLegReading): "live" | "delayed" | null {
  const source = reading.entry?.source;
  if (source === "live" || source === "delayed") return source;
  return reading.delayMinutes != null ? "delayed" : null;
}

/**
 * One row per ordered cross, the row currency first, as the pane's matrix
 * reads: one unit of `base` buys `rate` of `quote`, through the USD legs. A
 * cross is as old as its older leg, stale when either leg is, and moves only
 * when both legs carry a previous close, the pane's tint rule.
 */
export function projectFxCrosses(currencies: readonly FxCurrency[], load: FxBoardLoad, now = Date.now()): HeadlessRowsResult {
  const rows = currencies.flatMap((base) => currencies.filter((quote) => quote !== base).map((quote) => {
    const legs = [base, quote].flatMap((currency) => {
      const reading = load.legs.get(currency);
      return currency === "USD" || !reading ? [] : [reading];
    });
    const baseRate = legRate(load.legs.get(base), base);
    const quoteRate = legRate(load.legs.get(quote), quote);
    const pair = `${base}/${quote}`;
    if (baseRate == null || quoteRate == null) {
      return { pair, base, quote, rate: null, movePercent: null, asOf: null };
    }
    const reference = (currency: string) => currency === "USD" ? 1 : load.legs.get(currency)?.reference ?? null;
    const baseReference = reference(base);
    const quoteReference = reference(quote);
    const observed = legs.map((reading) => reading.entry?.asOf);
    const feeds = legs.map(legFeed);
    const delays = legs.flatMap((reading) => reading.delayMinutes ?? []);
    return {
      pair, base, quote,
      rate: baseRate / quoteRate,
      movePercent: baseReference != null && quoteReference != null
        ? crossMovePercent(baseRate, baseReference, quoteRate, quoteReference)
        : null,
      // Unknown when either leg's observation time is.
      asOf: observed.every((time) => time != null && Number.isFinite(time)) && observed.length > 0
        ? iso(Math.min(...observed as number[]))
        : null,
      stale: legs.some((reading) => isFxRateStale(reading.entry, now)),
      ...(feeds.length > 0 && feeds.every((feed) => feed != null)
        ? { dataSource: feeds.includes("delayed") ? "delayed" as const : "live" as const }
        : {}),
      ...(delays.length ? { delayMinutes: Math.max(...delays) } : {}),
    };
  }));
  const unavailable = currencies.filter((currency) => legRate(load.legs.get(currency), currency) == null);
  return {
    rows,
    complete: unavailable.length === 0,
    unavailableSymbols: unavailable,
    errors: load.errors,
    metadata: {
      currencies,
      unit: "quote currency per one unit of the base currency",
      method: "base currency's USD leg divided by the quote currency's; the legs' observation times can differ",
      movePercent: "the cross against both legs' previous closes; empty where a leg has no current pair quote",
      legs: currencies.filter((currency) => currency !== "USD").map((currency) => {
        const reading = load.legs.get(currency);
        return {
          currency,
          pair: reading?.leg.symbol ?? null,
          usdPerUnit: legRate(reading, currency),
          previousCloseUsdPerUnit: reading?.reference ?? null,
          asOf: iso(reading?.entry?.asOf),
          fetchedAt: iso(reading?.entry?.fetchedAt),
          stale: reading?.entry ? isFxRateStale(reading.entry, now) : null,
        };
      }),
      methodology: "docs/research-data.md#fx-matrix",
    },
  };
}

const SET_NAMES = CURRENCY_SETS.map((set) => set.id).join(", ");

export const fxMatrixHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  argument: { kind: "none" },
  description: "Cross rates between currencies, each with its move since the previous close, observation time and stale flag.",
  // A feed: each row says whether it is live, delayed or stale; the FX
  // market's own hours decide stale, so no fixed age is declared here.
  freshness: { source: "Gloom Cloud" },
  describe: (args) => `FX Cross Rates | ${resolveCurrencies(args.options.currencies).join(" ")}`,
  discovery: {
    intents: ["fx", "forex", "currency", "cross rates", "exchange rates"],
    limitations: ["Indicative crosses through USD legs, whose observation times can differ."],
    screenshotReadiness: "live-dom",
  },
  options: [{
    key: "currencies",
    type: "string",
    description: `Currency codes and sets in order, comma separated (sets: ${SET_NAMES}); the majors by default.`,
  }],
  columns: [
    { key: "pair", header: "Pair" },
    { key: "rate", header: "Rate", align: "right", format: (value) => typeof value === "number" ? formatRate(value) : "—" },
    { key: "movePercent", header: "Move", align: "right", format: (value) => typeof value === "number" ? formatPercentRaw(value) : "—" },
    { key: "asOf", header: "As of", format: (value) => typeof value === "string" ? formatUtcTime(value) : "—" },
    { key: "stale", header: "Status", format: (value, row) => (
      row.rate == null ? "unavailable" : value ? "stale" : row.asOf == null ? "time unknown" : "current"
    ) },
  ],
  async load(args, ctx) {
    const currencies = resolveCurrencies(args.options.currencies);
    const load = await loadFxBoard(currencies, ctx.marketData, { forceRefresh: ctx.refresh });
    ctx.signal.throwIfAborted();
    const result = projectFxCrosses(currencies, load);
    // The pane drops a code it does not carry; a report says so.
    const unknown = String(args.options.currencies ?? "").split(/[\s,]+/).filter((token) => (
      token && !CURRENCY_SETS.some((set) => set.id === token.toLowerCase())
      && !(FX_CURRENCIES as readonly string[]).includes(token.toUpperCase())
    ));
    return unknown.length
      ? { ...result, errors: [...result.errors ?? [], `Not a currency or set: ${unknown.join(", ")}. Sets: ${SET_NAMES}.`] }
      : result;
  },
};
