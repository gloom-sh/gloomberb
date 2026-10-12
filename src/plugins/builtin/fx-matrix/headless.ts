import type { HeadlessPaneDefinition, HeadlessRowsResult } from "../../../types/plugin";
import { resolveEntryData } from "../../../market-data/selectors";
import { formatPercentRaw } from "../../../utils/format";
import { formatUtcTime } from "../../../utils/utc-time";
import { fxPairObservation, fxRateObservations } from "../shared/fx-rate-freshness";
import { loadFxBoard, type FxLegReading } from "./client";
import { crossMovePercent } from "./direction";
import { formatRate, resolveCurrencies, type FxCurrency } from "./pairs";
import { FX_MATRIX_REPORT_OPTIONS, fxMatrixReportNotices } from "./settings";

const iso = (time: number | null | undefined) => time != null && Number.isFinite(time) ? new Date(time).toISOString() : null;

/** USD per unit, USD itself as 1; null for a leg with no usable rate. */
function usdPerUnit(readings: ReadonlyMap<string, FxLegReading>, currency: string): number | null {
  if (currency === "USD") return 1;
  const rate = resolveEntryData(readings.get(currency)?.entry);
  return rate != null && Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * One row per ordered cross, the row currency first, as the pane's matrix
 * reads: one unit of `base` buys `rate` of `quote`, through the USD legs. Each
 * leg is dated as the pane dates it for `fn` and `shot` (`fxRateObservations`),
 * a cross as `fx <PAIR>` dates one (`fxPairObservation`): as old as its older
 * leg, stale when either leg is. It moves only when both legs carry a previous
 * close, the pane's tint rule. The report itself is dated by the legs, so its
 * closing line is the one the pane's capture ends with.
 */
export function projectFxCrosses(
  currencies: readonly FxCurrency[],
  readings: ReadonlyMap<string, FxLegReading>,
  options: { notices?: string[]; now?: number } = {},
): HeadlessRowsResult {
  const now = options.now ?? Date.now();
  const rates = new Map(currencies.flatMap((currency) => {
    const rate = usdPerUnit(readings, currency);
    return rate == null ? [] : [[currency as string, rate] as const];
  }));
  const observations = fxRateObservations(currencies, rates, (currency) => ({
    entry: readings.get(currency)?.entry,
    legQuote: readings.get(currency)?.quote,
  }), now);
  const observed = new Map(observations.map((observation) => [observation.currency, observation]));
  const reference = (currency: string) => currency === "USD" ? 1 : readings.get(currency)?.reference ?? null;

  const rows = currencies.flatMap((base) => currencies.filter((quote) => quote !== base).map((quote) => {
    const pair = `${base}/${quote}`;
    const baseRate = rates.get(base);
    const quoteRate = rates.get(quote);
    // A missing leg leaves the cross unavailable, never at parity.
    if (baseRate == null || quoteRate == null) return { pair, base, quote, rate: null, movePercent: null, asOf: null };
    const legs = [base, quote].flatMap((currency) => observed.get(currency) ?? []);
    const observation = fxPairObservation(legs);
    const baseReference = reference(base);
    const quoteReference = reference(quote);
    return {
      pair,
      base,
      quote,
      rate: baseRate / quoteRate,
      movePercent: baseReference != null && quoteReference != null
        ? crossMovePercent(baseRate, baseReference, quoteRate, quoteReference)
        : null,
      // Unknown when either leg's observation time is.
      asOf: legs.every((leg) => leg.quoteTime) ? observation?.quoteTime ?? null : null,
      stale: observation?.stale ?? false,
      ...(observation?.dataSource ? { dataSource: observation.dataSource } : {}),
      ...(observation?.delayMinutes ? { delayMinutes: observation.delayMinutes } : {}),
    };
  }));

  const unavailable = currencies.filter((currency) => !rates.has(currency));
  const errors = unavailable.flatMap((currency) => {
    const error = readings.get(currency)?.error;
    return error ? [`${currency}: ${error}`] : [];
  });
  return {
    rows,
    ...(rows.length === 0 ? { empty: "One currency has no crosses. Add another, such as --currencies USD,EUR." } : {}),
    complete: unavailable.length === 0,
    unavailableSymbols: unavailable,
    ...(errors.length ? { errors } : {}),
    freshness: { observations },
    metadata: {
      ...(options.notices?.length ? { notices: options.notices } : {}),
      currencies,
      unit: "quote currency per one unit of the base currency",
      method: "the base currency's USD rate divided by the quote currency's; the two legs' observation times can differ",
      movePercent: "the cross against both legs' previous closes; empty where a leg has no current pair quote",
      legs: currencies.filter((currency) => currency !== "USD").map((currency) => {
        const reading = readings.get(currency);
        const observation = observed.get(currency);
        return {
          currency,
          symbol: reading?.leg.symbol ?? null,
          usdPerUnit: rates.get(currency) ?? null,
          previousCloseUsdPerUnit: reading?.reference ?? null,
          asOf: observation?.quoteTime ?? null,
          fetchedAt: iso(reading?.entry?.fetchedAt),
          stale: observation?.stale ?? null,
          ...(observation?.dataSource ? { dataSource: observation.dataSource } : {}),
          ...(observation?.delayMinutes ? { delayMinutes: observation.delayMinutes } : {}),
        };
      }),
      methodology: "docs/research-data.md#fx-matrix",
    },
  };
}

export const fxMatrixHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  argument: { kind: "none" },
  description: "Cross rates between currencies, one row per ordered pair, each with its move since the previous close, observation time and stale flag.",
  freshness: { source: "Gloom Cloud" },
  describe: (args) => `FX Cross Rates | ${resolveCurrencies(args.options.currencies).join(" ")}`,
  discovery: {
    intents: ["fx", "forex", "currency", "cross rates", "exchange rates"],
    limitations: ["Indicative crosses through USD legs, whose observation times can differ."],
    screenshotReadiness: "live-dom",
  },
  options: [...FX_MATRIX_REPORT_OPTIONS],
  columns: [
    { key: "pair", header: "Pair" },
    { key: "rate", header: "Rate", align: "right", format: (value) => typeof value === "number" ? formatRate(value) : "—" },
    { key: "movePercent", header: "Move", align: "right", format: (value) => typeof value === "number" ? formatPercentRaw(value) : "—" },
    { key: "asOf", header: "As of", shrink: false, format: (value) => typeof value === "string" ? formatUtcTime(value) : "—" },
    { key: "stale", header: "Status", format: (value, row) => (
      row.rate == null ? "unavailable" : value ? "stale" : row.asOf == null ? "time unknown" : "current"
    ) },
  ],
  // Ask Gloom gets every cross of all 45 currencies inside its result limit:
  // the pair names both codes, and each leg's feed and delay are in metadata.
  compact: (result) => ({
    ...result,
    rows: result.rows.map(({ pair, rate, movePercent, asOf, stale }) => ({
      pair,
      rate: typeof rate === "number" ? Number(rate.toPrecision(6)) : null,
      movePercent: typeof movePercent === "number" ? Number(movePercent.toFixed(3)) : null,
      asOf,
      ...(stale === undefined ? {} : { stale }),
    })),
  }),
  async load(args, ctx) {
    const currencies = resolveCurrencies(args.options.currencies);
    const readings = await loadFxBoard(currencies, ctx.marketData, { forceRefresh: ctx.refresh });
    ctx.signal.throwIfAborted();
    const legs = [...readings.values()];
    // Nothing to cross: say why instead of a board of dashes.
    if (legs.length > 0 && legs.every((reading) => reading.entry == null)) {
      throw new Error(`Exchange rates unavailable for ${legs.map(({ leg }) => leg.currency).join(", ")}: ${legs[0]!.error}`);
    }
    return projectFxCrosses(currencies, readings, { notices: fxMatrixReportNotices(args.options) });
  },
};
