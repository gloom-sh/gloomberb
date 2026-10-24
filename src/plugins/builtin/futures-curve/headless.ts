import type { FuturesContract, FuturesCurvePayload } from "../../../api-client/futures-curve";
import { futuresSpecLines } from "../../../market-data/futures-contract";
import type { HeadlessPaneColumn, HeadlessPaneDefinition, HeadlessPaneEntry, HeadlessPaneFreshness } from "../../../types/plugin";
import { formatPercentRaw } from "../../../utils/format";
import { DATE_OPTION_EXAMPLES } from "../../../utils/calendar-date";
import { newestReportTime, oldestReportTime } from "../../../utils/utc-time";
import { fetchFuturesCurve, loadCurveSpot, loadCurveSpotBars, loadFuturesCurveAsOf } from "./client";
import { basisSpotSymbol, BASIS_CONVENTION, blankBasisNote, catalogueCurveUnit, curveAsOfDate, curveBasisPercent, curveBasisRows, curveChangeText, curveContractCode, curvePrice, curveRoundedPrice, curveSpotSource, curveSpreadLabel, curveTimestamp, curveNoTradeSince, curveUnitLabel, noTradeChangeNote, normalizeCurveRoot, shortDatedBasisNote, unpairedContractCount, unsupportedCurveRootMessage, type ContractBasis } from "./model";
import { COMMODITIES_VIEW_STATE } from "../commodities-energy/view-state";

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
 * `change` is `price` less `settlement`; `noTradeSince` dates the settlement
 * a contract has not traded since, whose change is therefore blank. A crypto
 * root adds the basis: the spot in the minute of `price`'s trade and that
 * minute (`spot`, `spotTime`), the fractional days from the trade to final
 * settlement, and the premium and its yearly rate.
 */
function contractRow(row: FuturesContract, data: FuturesCurvePayload, root: string, past: boolean, basis?: ContractBasis) {
  const price = (value: number | null | undefined) => curveRoundedPrice(value, root);
  return {
    symbol: row.symbol, label: row.label, expiration: row.expiration, lastTrade: row.lastTrade ?? row.expiration,
    firstNotice: row.firstNotice ?? null, inDelivery: row.inDelivery ?? false,
    settlement: price(row.settlement), settlementDate: row.settlement != null ? data.settlementDate ?? null : null,
    price: past && row.settlement != null ? null : price(row.price), change: price(row.change),
    noTradeSince: past ? null : curveNoTradeSince(row, data),
    asOf: row.asOf, stale: row.stale, volume: row.volume, openInterest: row.openInterest, percentile: rank(row.percentile),
    samples: row.samples, historyStart: row.historyStart, historyEnd: row.historyEnd,
    currency: row.currency, quoteUnit: curveUnitLabel(data) ?? row.quoteUnit, delayMinutes: row.delayMinutes,
    ...(basis ? { spot: price(basis.spot), spotTime: basis.spotTime, daysToExpiry: basisValue(basis.daysToExpiry),
      vsSpotPct: basisValue(basis.vsSpotPct), annualisedBasisPct: basisValue(basis.annualisedBasisPct) } : {}),
  };
}

/**
 * The table: what a hedge reads, in one order for every root; JSON keeps every
 * field. A crypto root's spot is the one each trade is read against; the
 * export dates it, where the text leaves its minute to As Of UTC, the trade's.
 */
function contractColumns(root: string, settlementDate: string | null, options: { basis: boolean; last: boolean; notice: boolean; text?: boolean }): HeadlessPaneColumn[] {
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
    ...options.basis ? [{ key: "spot", header: "Spot", align: "right" as const, format: price },
      ...options.text ? [] : [{ key: "spotTime", header: "Spot Time UTC", shrink: false, format: (value: unknown) => typeof value === "string" ? curveTimestamp(value) : "--" }],
      { key: "vsSpotPct", header: "Vs Spot", align: "right" as const, format: (value: unknown) => curveBasisPercent(typeof value === "number" ? value : null, 2) },
      { key: "daysToExpiry", header: "Days to Expiry", textHeader: "Days", align: "right" as const, format: (value: unknown) => typeof value === "number" ? value.toFixed(1) : "--" },
      { key: "annualisedBasisPct", header: "Ann Basis", align: "right" as const, format: (value: unknown) => curveBasisPercent(typeof value === "number" ? value : null, 1) }] : [],
    { key: "asOf", header: "As Of UTC", shrink: false, format: (value) => typeof value === "string" ? curveTimestamp(value) : "--" },
    { key: "openInterest", header: "Open Int", align: "right", format: (value) => typeof value === "number" ? value.toLocaleString("en-US") : "--" },
    { key: "volume", header: "Volume", align: "right", format: (value) => typeof value === "number" ? value.toLocaleString("en-US") : "--" },
    { key: "percentile", header: "Pctl", align: "right", format: (value) => typeof value === "number" ? String(value) : "--" },
  ];
}

/**
 * A section's fields in one order, each under its own name as a report
 * titles it, then any field the server added since. Read from the rows, the
 * order would follow the server's JSON, which a cached response reorders.
 */
function fieldColumns(order: readonly string[], fields: object, formats: Record<string, HeadlessPaneColumn["textFormat"]> = {}): HeadlessPaneColumn[] {
  return [...order, ...Object.keys(fields).filter((key) => !order.includes(key))]
    .map((key) => ({ key, header: key, ...formats[key] ? { textFormat: formats[key] } : {} }));
}

const FRONT_SPREAD_FIELDS = ["label", "frontSymbol", "nextSymbol", "value", "annualizedRollYield", "percentile", "rollPercentile",
  "samples", "historyStart", "historyEnd", "asOf", "state"];
const GHOST_FIELDS = ["symbol", "expiration", "price", "asOf"];
/** The annualized roll yield reads as the percent it is (+32.36%); an export keeps the number. */
const ROLL_YIELD_FORMAT = { annualizedRollYield: (value: unknown) => typeof value === "number" ? formatPercentRaw(value) : "--" };

/** What one contract is: the terms a hedge is sized on, once rather than on every row, worded as `ticker` words them. */
function specEntries(data: FuturesCurvePayload): HeadlessPaneEntry[] {
  const spec = data.spec;
  // A root without terms still says what its prices count: Dutch TTF gas is euros per MWh.
  if (!spec) {
    const unit = catalogueCurveUnit(data.root);
    return unit ? [{ key: "unit", label: "Unit", value: unit }] : [];
  }
  return futuresSpecLines(spec).map((line) => {
    const value = spec[line.key as keyof typeof spec];
    return { key: line.key, label: line.label, value, ...line.value === String(value) ? {} : { formatted: line.value } };
  });
}

export const futuresCurveHeadless: HeadlessPaneDefinition<"bundle"> = {
  discovery: { aliases: ["CTM"], dataRequirements: ["Gloom Cloud futures curve endpoint"],
    limitations: ["Listed-contract catalogues can be incomplete.", "Ghosts and percentiles use the same listed contracts.", "Cboe VIX is daily settlement.",
    "Ann Basis is simple actual/365, each last trade against spot in the same minute, and noisy under 7 days to expiry."],
    intents: ["futures basis trade", "cash and carry", "basis against spot"] },
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "root", description: "FUT root such as CL, ES, ZN or VX, or a CME crypto root (BTC, ETH, SOL, XRP). Defaults to ES." },
  // Only the pane reads the tab; the report always carries both.
  options: [{ key: "tab", description: "Curve or the full contract table.", type: "enum",
    values: [{ value: "curve" }, { value: "contracts", aliases: ["contract", "table"] }], defaultValue: "curve",
    pluginState: { pluginId: COMMODITIES_VIEW_STATE.curve, key: "tab" } },
  { key: "date", type: "string", settingKey: "asOfDate", placeholder: "date", description: `Past date, as ${DATE_OPTION_EXAMPLES}: the curve as the daily settlement archive held it, with the curves a week and a month before.` }],
  describe: (args) => `Futures curve ${args.argument || DEFAULT_ROOT}`,
  async load(args, ctx) {
    const input = args.argument || DEFAULT_ROOT;
    const root = normalizeCurveRoot(input);
    if (!root) throw new Error(unsupportedCurveRootMessage(input));
    const date = curveAsOfDate(args.options.date, new Date(), "--date");
    // The archive keeps no spot history, so a past curve has no basis.
    const spotSymbol = date ? null : basisSpotSymbol(root);
    const now = Date.now();
    // The quote names the spot and its feed; the one-minute bars price each trade's own minute.
    const [data, spot, bars] = await Promise.all([
      date ? loadFuturesCurveAsOf(root, date, ctx.apiClient) : fetchFuturesCurve(root, ctx.apiClient),
      spotSymbol ? loadCurveSpot(spotSymbol, ctx.marketData, now) : null,
      spotSymbol ? loadCurveSpotBars(spotSymbol, ctx.marketData, ctx.refresh === true) : null,
    ]);
    const bases = spot && bars ? curveBasisRows(data.contracts, bars) : null;
    const unit = curveUnitLabel(data);
    const terms = specEntries(data);
    const source = spot ? curveSpotSource(spot) : null;
    const notices = [...args.argument ? [] : [`Showing ${DEFAULT_ROOT}. Try fn CTM ${EXAMPLE_ROOT}.`],
      ...spot ? [`Basis against ${spot.symbol} spot in each last trade's own minute${source ? ` (${source})` : ""}; not the CME reference rate.`] : []];
    // The footnotes under the table: the convention, why a cell is blank, and where a short-dated rate is not to be trusted.
    const basisNotes = bases ? [BASIS_CONVENTION, blankBasisNote(data.contracts, bases), shortDatedBasisNote(data.contracts, bases)]
      .filter((note): note is string => !!note) : [];
    // A blank Change says why, as a blank basis does; a past curve has no session change to blank.
    const changeNote = date ? null : noTradeChangeNote(data.contracts, data);
    const notes = [...changeNote ? [changeNote] : [], ...basisNotes];
    const columnOptions = { basis: !!bases, last: data.source !== "cboe", notice: data.contracts.some((row) => row.firstNotice) };
    // Dated by the contracts' own quotes; the same-contract history rows are a year of context, not observations.
    const quoted = data.contracts.map((row) => row.asOf);
    const freshness: HeadlessPaneFreshness = date
      ? { status: "not-a-feed", basis: "settlement archive", asOf: date }
      : { ...(data.source === "cboe" ? { source: "Cboe", status: "not-a-feed", basis: "daily settlement", cadence: "daily" } as const : {}),
        asOf: newestReportTime(quoted), oldest: oldestReportTime(quoted) };
    return {
      freshness,
      sections: [
        { title: "Contracts", columns: contractColumns(root, data.settlementDate ?? null, columnOptions),
          ...bases ? { textColumns: contractColumns(root, data.settlementDate ?? null, { ...columnOptions, text: true }) } : {},
          rows: data.contracts.map((row) => contractRow(row, data, root, !!date, bases?.get(row.symbol))) },
        { title: "Front spread", columns: fieldColumns(FRONT_SPREAD_FIELDS, data.slope, ROLL_YIELD_FORMAT), rows: [{ label: curveSpreadLabel(data.slope), ...data.slope, value: curveRoundedPrice(data.slope.value, root),
          annualizedRollYield: data.slope.annualizedRollYield == null ? null : Number(data.slope.annualizedRollYield.toFixed(2)),
          percentile: rank(data.slope.percentile), rollPercentile: rank(data.slope.rollPercentile) }] },
        ...terms.length ? [{ title: "Contract terms", entries: terms }] : [],
        ...data.ghosts.map((ghost) => ({ title: `${ghost.label} same-contract history`, columns: fieldColumns(GHOST_FIELDS, ghost.points[0] ?? {}),
          rows: ghost.points.map((point) => ({ ...point })) })),
      ],
      errors: data.gaps,
      ...(notes.length ? { notes } : {}),
      metadata: { ...data, quoteUnit: unit, ...(spot && bases ? { spot, basisBlankedUnpaired: unpairedContractCount(bases.values()) } : {}), ...(args.argument ? {} : { defaultArgument: DEFAULT_ROOT }),
        ...(notices.length ? { notices } : {}),
        complete: data.status === "available", percentileBasis: "Same-contract observations within one year; actual sample start/end retained" },
    };
  },
};
