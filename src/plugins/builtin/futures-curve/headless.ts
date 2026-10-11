import type { FuturesContract, FuturesCurvePayload } from "../../../api-client/futures-curve";
import type { HeadlessPaneColumn, HeadlessPaneDefinition, HeadlessPaneEntry, HeadlessPaneFreshness } from "../../../types/plugin";
import { newestReportTime, oldestReportTime } from "../../../utils/utc-time";
import { fetchFuturesCurve, loadCurveSpot, loadFuturesCurveAsOf } from "./client";
import { basisSpotSymbol, contractBasis, curveAsOfDate, curveBasisPercent, curveChangeText, curveContractCode, curvePrice, curveRoundedPrice, curveSpotLabel, curveSpreadLabel, curveTickText, curveTimestamp, curveUnitLabel, normalizeCurveRoot, thinContractCount, unsupportedCurveRootMessage, type ContractBasis } from "./model";

/** The root a report shows when none is given. */
const DEFAULT_ROOT = "ES";
const EXAMPLE_ROOT = "CL";

/** Percentiles read as the pane shows them, a whole rank. */
const rank = (value: number | null) => value == null ? null : Math.round(value);
/** The basis fields are read to four decimals, finer than any cell shows. */
const basisValue = (value: number | null) => value == null ? null : Number(value.toFixed(4));

/**
 * One contract as the report reads it, the same fields in the same order for
 * every root. Prices and changes are at the root's tick precision. `price` is
 * the latest trade and `settlement` the exchange settlement for the curve's
 * settlement session (a past curve's settled rows have no separate trade).
 */
function contractRow(row: FuturesContract, data: FuturesCurvePayload, root: string, past: boolean, basis?: ContractBasis) {
  const price = (value: number | null | undefined) => curveRoundedPrice(value, root);
  return {
    symbol: row.symbol, label: row.label, expiration: row.expiration, lastTrade: row.lastTrade ?? row.expiration,
    firstNotice: row.firstNotice ?? null, inDelivery: row.inDelivery ?? false,
    settlement: price(row.settlement), settlementDate: row.settlement != null ? data.settlementDate ?? null : null,
    price: past && row.settlement != null ? null : price(row.price), change: price(row.change),
    asOf: row.asOf, stale: row.stale, volume: row.volume, openInterest: row.openInterest, percentile: rank(row.percentile),
    samples: row.samples, historyStart: row.historyStart, historyEnd: row.historyEnd,
    currency: row.currency, quoteUnit: curveUnitLabel(data) ?? row.quoteUnit, delayMinutes: row.delayMinutes,
    ...(basis ? { vsSpotPct: basisValue(basis.vsSpotPct), annualisedBasisPct: basisValue(basis.annualisedBasisPct) } : {}),
  };
}

/** The text table: what a hedge reads, in one order for every root; JSON keeps every field. */
function contractColumns(root: string, settlementDate: string | null, options: { basis: boolean; last: boolean; notice: boolean }): HeadlessPaneColumn[] {
  const price = (value: unknown) => typeof value === "number" ? curvePrice(value, root) : "--";
  const date = (value: unknown) => typeof value === "string" ? value : "--";
  return [
    { key: "symbol", header: "Contract", shrink: false, format: (value) => curveContractCode(String(value)) },
    { key: "lastTrade", header: "Last Trade", shrink: false, format: date },
    // Cash-settled roots have no first notice day.
    ...options.notice ? [{ key: "firstNotice", header: "1st Notice", shrink: false,
      format: (value: unknown, row: Record<string, unknown>) => typeof value === "string" ? `${value}${row.inDelivery ? " passed" : ""}` : "--" }] : [],
    { key: "settlement", header: settlementDate ? `Settle ${settlementDate}` : "Settle", align: "right", format: price },
    // A Cboe price is the settlement itself, with no separate last trade.
    ...options.last ? [{ key: "price", header: "Last", align: "right" as const, format: price }] : [],
    { key: "change", header: "Change", align: "right", format: (value) => typeof value === "number" ? curveChangeText(value, root) : "--" },
    ...options.basis ? [{ key: "vsSpotPct", header: "Vs Spot", align: "right" as const, format: (value: unknown) => curveBasisPercent(typeof value === "number" ? value : null, 2) },
      { key: "annualisedBasisPct", header: "Ann Basis", align: "right" as const, format: (value: unknown) => curveBasisPercent(typeof value === "number" ? value : null, 1) }] : [],
    { key: "asOf", header: "As Of UTC", shrink: false, format: (value) => typeof value === "string" ? curveTimestamp(value) : "--" },
    { key: "openInterest", header: "Open Int", align: "right", format: (value) => typeof value === "number" ? value.toLocaleString("en-US") : "--" },
    { key: "volume", header: "Volume", align: "right", format: (value) => typeof value === "number" ? value.toLocaleString("en-US") : "--" },
    { key: "percentile", header: "Pctl", align: "right", format: (value) => typeof value === "number" ? String(value) : "--" },
  ];
}

/** What one contract is: the terms a hedge is sized on, once rather than on every row. */
function specEntries(data: FuturesCurvePayload): HeadlessPaneEntry[] {
  const spec = data.spec;
  if (!spec) return [];
  return [
    { key: "unit", label: "Unit", value: spec.unit },
    { key: "size", label: "Contract size", value: spec.size },
    { key: "tick", label: "Tick", value: spec.tick, formatted: curveTickText(spec) },
    { key: "pointValue", label: "Point value", value: spec.pointValue, formatted: `$${spec.pointValue.toLocaleString("en-US")}` },
    { key: "settlement", label: "Settlement", value: spec.settlement, formatted: spec.settlement === "cash" ? "cash settled" : "physical delivery" },
  ];
}

export const futuresCurveHeadless: HeadlessPaneDefinition<"bundle"> = {
  discovery: { aliases: ["CTM"], dataRequirements: ["Gloom Cloud futures curve endpoint"],
    limitations: ["Listed-contract catalogues can be incomplete", "Ghosts and percentiles use the same listed contracts", "Cboe VIX is daily settlement"] },
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "root", description: "FUT root such as CL, ES, ZN or VX, or a CME crypto root (BTC, ETH, SOL, XRP). Defaults to ES." },
  // Only the pane reads the tab; the report always carries both.
  options: [{ key: "tab", description: "Curve or the full contract table.", type: "enum",
    values: [{ value: "curve" }, { value: "contracts", aliases: ["contract", "table"] }], defaultValue: "curve",
    pluginState: { pluginId: "market-overview", key: "tab" } },
  { key: "date", type: "string", settingKey: "asOfDate", description: "Past date (YYYY-MM-DD): the curve as the daily settlement archive held it, with the curves a week and a month before." }],
  describe: (args) => `Futures curve ${args.argument || DEFAULT_ROOT}`,
  async load(args, ctx) {
    const input = args.argument || DEFAULT_ROOT;
    const root = normalizeCurveRoot(input);
    if (!root) throw new Error(unsupportedCurveRootMessage(input));
    const date = curveAsOfDate(args.options.date);
    // The archive keeps no spot history, so a past curve has no basis.
    const spotSymbol = date ? null : basisSpotSymbol(root);
    const now = Date.now();
    const [data, spot] = await Promise.all([
      date ? loadFuturesCurveAsOf(root, date, ctx.apiClient) : fetchFuturesCurve(root, ctx.apiClient),
      spotSymbol ? loadCurveSpot(spotSymbol, ctx.marketData, now) : null,
    ]);
    const bases = spot ? data.contracts.map((row) => contractBasis(row, spot)) : [];
    const unit = curveUnitLabel(data);
    const notices = [...args.argument ? [] : [`Showing ${DEFAULT_ROOT}. Try fn CTM ${EXAMPLE_ROOT}.`],
      ...spot ? [spot.status === "ok" ? `Basis against ${curveSpotLabel(spot, root, now)}.` : `Basis blank: ${spot.reason}.`] : []];
    // Dated by the contracts' own quotes; the same-contract history rows are a year of context, not observations.
    const quoted = data.contracts.map((row) => row.asOf);
    const freshness: HeadlessPaneFreshness = date
      ? { status: "not-a-feed", basis: "settlement archive", asOf: date }
      : { ...(data.source === "cboe" ? { source: "Cboe", status: "not-a-feed", basis: "daily settlement", cadence: "daily" } as const : {}),
        asOf: newestReportTime(quoted), oldest: oldestReportTime(quoted) };
    return {
      freshness,
      sections: [
        { title: "Contracts", columns: contractColumns(root, data.settlementDate ?? null,
          { basis: !!spot, last: data.source !== "cboe", notice: data.contracts.some((row) => row.firstNotice) }),
          rows: data.contracts.map((row, index) => contractRow(row, data, root, !!date, bases[index])) },
        { title: "Front spread", rows: [{ label: curveSpreadLabel(data.slope), ...data.slope, value: curveRoundedPrice(data.slope.value, root),
          annualizedRollYield: data.slope.annualizedRollYield == null ? null : Number(data.slope.annualizedRollYield.toFixed(2)),
          percentile: rank(data.slope.percentile), rollPercentile: rank(data.slope.rollPercentile) }] },
        ...data.spec ? [{ title: "Contract terms", entries: specEntries(data) }] : [],
        ...data.ghosts.map((ghost) => ({ title: `${ghost.label} same-contract history`, rows: ghost.points.map((point) => ({ ...point })) })),
      ],
      errors: data.gaps,
      metadata: { ...data, quoteUnit: unit, ...(spot ? { spot, basisBlankedThin: thinContractCount(bases) } : {}), ...(args.argument ? {} : { defaultArgument: DEFAULT_ROOT }),
        ...(notices.length ? { notices } : {}),
        complete: data.status === "available", percentileBasis: "Same-contract observations within one year; actual sample start/end retained" },
    };
  },
};
