import type { FuturesContract, FuturesCurvePayload } from "../../../api-client/futures-curve";
import { futuresSpecLines } from "../../../market-data/futures-contract";
import type { HeadlessPaneColumn, HeadlessPaneDefinition, HeadlessPaneEntry, HeadlessPaneFreshness } from "../../../types/plugin";
import { formatPercentRaw } from "../../../utils/format";
import { DATE_OPTION_EXAMPLES } from "../../../utils/calendar-date";
import { newestReportTime, oldestReportTime } from "../../../utils/utc-time";
import { fetchFuturesCurve, loadCurveSpot, loadCurveSpotBars, loadCurveSpotCloses, loadFuturesCurveAsOf } from "./client";
import { basisSpotSymbol, BASIS_CONVENTION, blankBasisNote, catalogueCurveUnit, curveAsOfDate, curveCache, curveSpotBars, curveBasisPercent, curveBasisRows, curveChangeText, curveContractCode, curvePrice, curveReadsThirtySeconds, curveRoundedPrice, curveSpotSource, curveSpotPremium, curveSpreadLabel, curveTimestamp, curveNoTradeSince, curveSettleShown, curveUnitLabel, noTradeChangeNote, normalizeCurveRoot, shortDatedBasisNote, skippedSpreadNotice, spotIndexSymbol, thinSpreadNotice, unpairedContractCount, unsupportedCurveRootMessage, type ContractBasis, type CurveSpotPremium } from "./model";
import { COMMODITIES_VIEW_STATE } from "../commodities-energy/view-state";
import { knownGapMessage } from "../../../cli/known-gaps";

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
 * a contract has not traded since, whose change is therefore blank, and
 * `settleShown` the one it is shown and plotted at (no trade since, or none
 * at all). A crypto
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
    // The settlement session a live contract is shown at, when it has no trade since (or none at all): its curve point is that settlement.
    settleShown: past ? null : curveSettleShown(row, data),
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
  // An export has every column whatever the root, so CL's and GC's headers are the same; the text drops the ones a root leaves blank.
  const exported = !options.text;
  return [
    { key: "symbol", header: "Contract", shrink: false, format: (value) => curveContractCode(String(value)) },
    { key: "lastTrade", header: "Last Trade", shrink: false, format: date },
    // Cash-settled roots have no first notice day.
    ...options.notice || exported ? [{ key: "firstNotice", header: "1st Notice", shrink: false,
      format: (value: unknown, row: Record<string, unknown>) => typeof value === "string" ? `${value}${row.inDelivery ? " passed" : ""}` : "--" }] : [],
    // One header whatever the session: an export dates each settlement in its own column, the text in the header.
    { key: "settlement", header: "Settle", ...settlementDate ? { textHeader: `Settle ${settlementDate}` } : {}, align: "right", format: price },
    ...options.text ? [] : [{ key: "settlementDate", header: "settle_date", literalHeader: true, shrink: false, format: date }],
    // A Cboe price is the settlement itself, with no separate last trade: an export leaves its Last blank.
    ...options.last || exported ? [{ key: "price", header: "Last", align: "right" as const, format: options.last ? price : () => "--" }] : [],
    { key: "change", header: "Change", align: "right", format: (value) => typeof value === "number" ? curveChangeText(value, root) : "--" },
    ...options.basis || exported ? [{ key: "spot", header: "Spot", align: "right" as const, format: price },
      ...options.text ? [] : [{ key: "spotTime", header: "Spot Time UTC", shrink: false, format: (value: unknown) => typeof value === "string" ? curveTimestamp(value) : "--" }],
      { key: "vsSpotPct", header: "Vs Spot", align: "right" as const, format: (value: unknown) => curveBasisPercent(typeof value === "number" ? value : null, 2) },
      { key: "daysToExpiry", header: "Days to Expiry", textHeader: "Days", align: "right" as const, format: (value: unknown) => typeof value === "number" ? value.toFixed(1) : "--" },
      { key: "annualisedBasisPct", header: "Ann Basis", align: "right" as const, format: (value: unknown) => curveBasisPercent(typeof value === "number" ? value : null, 1) }] : [],
    // A month with no trade since the settlement it shows is dated by that settlement, never read as an old print:
    // the text says so, an export leaves the cell empty (settle_date dates it).
    { key: "asOf", header: "As Of UTC", shrink: false,
      format: (value, row) => typeof row.settleShown === "string" ? "--" : typeof value === "string" ? curveTimestamp(value) : "--",
      textFormat: (value, row) => typeof row.settleShown === "string" ? `settle ${row.settleShown}` : typeof value === "string" ? curveTimestamp(value) : "--" },
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
    .map((key) => ({ key, header: key, ...SYMBOL_FIELDS.has(key) ? { format: contractCodeFormat } : {}, ...formats[key] ? { textFormat: formats[key] } : {} }));
}

/**
 * The front spread's columns: every field in one order, the skipped months
 * last as one cell (`GCF27`), which the text names in a note instead.
 */
function spreadColumns(row: Record<string, unknown>, formats: Record<string, HeadlessPaneColumn["textFormat"]>, text: boolean): HeadlessPaneColumn[] {
  const fields = Object.fromEntries(Object.entries(row).filter(([key]) => key !== SKIPPED_FIELD));
  return [...fieldColumns(FRONT_SPREAD_FIELDS, fields, formats),
    ...text ? [] : [{ key: SKIPPED_FIELD, header: SKIPPED_FIELD, format: (value: unknown) => Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string").map(curveContractCode).join(" ") : "" }]];
}

/** The fields naming a contract, written in every section as the Contracts table writes it: CLZ26, never CLZ26.NYM. */
const SYMBOL_FIELDS: ReadonlySet<string> = new Set(["symbol", "frontSymbol", "nextSymbol", "thinSymbol"]);
const contractCodeFormat = (value: unknown) => typeof value === "string" && value ? curveContractCode(value) : "-";

// `basis` says which prices the value subtracts: two last trades made together, or the settlements of the session in `asOf`.
const FRONT_SPREAD_FIELDS = ["label", "frontSymbol", "nextSymbol", "value", "annualizedRollYield", "percentile", "rollPercentile",
  "samples", "historyStart", "historyEnd", "asOf", "basis", "state", "thinSymbol"];
/** The months the spread passed over for their thin open interest: an export keeps them, the text names them in a note. */
const SKIPPED_FIELD = "skippedSymbols";
const GHOST_FIELDS = ["symbol", "expiration", "price", "asOf"];
/** The annualized roll yield reads as the percent it is (+32.36%); an export keeps the number. */
const ROLL_YIELD_FORMAT = { annualizedRollYield: (value: unknown) => typeof value === "number" ? formatPercentRaw(value) : "--" };
/** A Treasury root's prices read in 32nds in every section, as its contracts do; an export keeps the number. */
const thirtySecondsFormat = (root: string, key: string): Record<string, HeadlessPaneColumn["textFormat"]> => curveReadsThirtySeconds(root)
  ? { [key]: (value: unknown) => typeof value === "number" ? curvePrice(value, root) : "--" } : {};

/**
 * Spot against the front contract, both marks of the curve's settlement
 * session: the index close and the front settlement's premium to it.
 */
function spotPremiumEntries(premium: CurveSpotPremium, root: string): HeadlessPaneEntry[] {
  return [
    { key: "spot", label: premium.label, value: premium.close,
      formatted: premium.close == null ? "--" : `${premium.close.toFixed(2)}${premium.date ? `, ${premium.date} close` : ""}` },
    { key: "frontPremium", label: "Front premium", value: premium.premium,
      formatted: premium.premium == null ? "--"
        : `${curveChangeText(premium.premium, root)}${premium.frontSymbol ? `, ${curveContractCode(premium.frontSymbol)} settle less spot` : ""}` },
  ];
}

/** What one contract is: the terms a hedge is sized on, once rather than on every row, worded as `ticker` words them. */
function specEntries(data: FuturesCurvePayload): HeadlessPaneEntry[] {
  const spec = data.spec;
  // A root without terms still says what its prices count: Dutch TTF gas is euros per MWh.
  if (!spec) {
    const unit = catalogueCurveUnit(data.root);
    return unit ? [{ key: "unit", label: "Unit", value: unit }] : [];
  }
  return [
    ...futuresSpecLines(spec).map((line) => {
      const value = spec[line.key as keyof typeof spec];
      return { key: line.key, label: line.label, value, ...line.value === String(value) ? {} : { formatted: line.value } };
    }),
    ...curveReadsThirtySeconds(data.root) ? [TREASURY_DV01_ENTRY] : [],
  ];
}

/**
 * A Treasury contract's DV01 is its cheapest-to-deliver note's divided by
 * that note's conversion factor. CME publishes the factors, but not where they
 * can be read, so the terms say how to size it rather than print a figure.
 */
const TREASURY_DV01_ENTRY: HeadlessPaneEntry = {
  key: "dv01", label: "DV01", value: null,
  formatted: "not published here; price the cheapest-to-deliver in fn YAS and divide its DV01 by its CME conversion factor",
};

export const futuresCurveHeadless: HeadlessPaneDefinition<"bundle"> = {
  discovery: { aliases: ["CTM"], dataRequirements: ["Gloom Cloud futures curve endpoint"],
    limitations: ["Listed-contract catalogues can be incomplete.", "Ghosts and percentiles use the same listed contracts.", "Cboe VIX is daily settlement.",
    "Ann Basis is simple actual/365, each last trade against spot in the same minute, and noisy under 7 days to expiry."],
    intents: ["futures basis trade", "cash and carry", "basis against spot"],
    opens: [{ words: ["VX", "vix futures", "vix futures curve"], argument: "VIX" }] },
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "root", description: "FUT root such as CL, ES, ZN or VX, or a CME crypto root (BTC, ETH, SOL, XRP). Defaults to ES.",
    examples: ["VIX", "CL", "BTC"] },
  // Only the pane reads the tab; the report always carries both.
  options: [{ key: "tab", description: "Curve or the full contract table.", type: "enum",
    values: [{ value: "curve" }, { value: "contracts", aliases: ["contract", "table"] }], defaultValue: "curve",
    pluginState: { pluginId: COMMODITIES_VIEW_STATE.curve, key: "tab" } },
  { key: "date", type: "string", settingKey: "asOfDate", placeholder: "date", description: `Past date, as ${DATE_OPTION_EXAMPLES}: the curve as the daily settlement archive held it, with the curves a week and a month before.` }],
  describe: (args) => `Futures curve ${args.argument || DEFAULT_ROOT}`,
  async load(args, ctx) {
    const input = args.argument || DEFAULT_ROOT;
    const root = normalizeCurveRoot(input);
    if (!root) {
      // A subject no source carries (`fn CTM BDI`, the Baltic Dry Index) is said with its proxies, as search says it.
      const gap = typeof input === "string" ? knownGapMessage(input) : null;
      throw Object.assign(new Error(unsupportedCurveRootMessage(input)), gap ? { details: gap } : {});
    }
    const date = curveAsOfDate(args.options.date, new Date(), "--date");
    // The archive keeps no spot history, so a past curve has no basis.
    const spotSymbol = date ? null : basisSpotSymbol(root);
    // VX reads against spot VIX's daily closes instead.
    const indexSymbol = date ? null : spotIndexSymbol(root);
    const now = Date.now();
    // The quote names the spot and its feed; the one-minute bars price each trade's own minute.
    const [data, spot, bars, closes] = await Promise.all([
      date ? loadFuturesCurveAsOf(root, date, ctx.apiClient) : fetchFuturesCurve(root, ctx.apiClient),
      spotSymbol ? loadCurveSpot(spotSymbol, ctx.marketData, now) : null,
      spotSymbol ? loadCurveSpotBars(spotSymbol, ctx.marketData, ctx.refresh === true) : null,
      indexSymbol ? loadCurveSpotCloses(indexSymbol, ctx.marketData, ctx.refresh === true) : null,
    ]);
    const spotPremium = closes ? curveSpotPremium(data, closes) : null;
    // The server's spot in each print's own minute fills what the reader's bars do not reach yet.
    const spotBars = curveSpotBars(bars, data.contracts);
    const bases = spot && spotBars ? curveBasisRows(data.contracts, spotBars) : null;
    const unit = curveUnitLabel(data);
    const terms = specEntries(data);
    const source = spot ? curveSpotSource(spot) : null;
    const notices = [...args.argument ? [] : [`Showing ${DEFAULT_ROOT}. Try fn CTM ${EXAMPLE_ROOT}.`],
      ...spot ? [`Basis against ${spot.symbol} spot in each last trade's own minute${source ? ` (${source})` : ""}; not the CME reference rate.`] : []];
    // The footnotes under the table: the convention, why a cell is blank, and where a short-dated rate is not to be trusted.
    const basisNotes = bases ? [BASIS_CONVENTION, blankBasisNote(data.contracts, bases, curveCache(data, now)), shortDatedBasisNote(data.contracts, bases)]
      .filter((note): note is string => !!note) : [];
    // A blank Change says why, as a blank basis does; a past curve has no session change to blank.
    const changeNote = date ? null : noTradeChangeNote(data.contracts, data);
    const thinSpread = thinSpreadNotice(data);
    const skipped = skippedSpreadNotice(data);
    const notes = [...thinSpread ? [`${thinSpread}.`] : [], ...skipped ? [`${skipped}.`] : [], ...changeNote ? [changeNote] : [], ...basisNotes,
      ...spotPremium?.reason ? [`Front premium blank: ${spotPremium.reason}.`] : []];
    const columnOptions = { basis: !!bases, last: data.source !== "cboe", notice: data.contracts.some((row) => row.firstNotice) };
    // Dated by the contracts' own quotes; the same-contract history rows are a year of context, not observations.
    const quoted = data.contracts.map((row) => row.asOf);
    const freshness: HeadlessPaneFreshness = date
      ? { status: "not-a-feed", basis: "settlement archive", asOf: date }
      : { ...(data.source === "cboe" ? { source: "Cboe", status: "not-a-feed", basis: "daily settlement", cadence: "daily" } as const : {}),
        asOf: newestReportTime(quoted), oldest: oldestReportTime(quoted) };
    // No contract to list is no curve: the report says why once and fails, as `help fn` says an empty one does.
    if (!data.contracts.length) {
      return { freshness, sections: [], empty: `No ${root} contracts from the source.`, errors: data.gaps,
        metadata: { ...data, quoteUnit: unit, complete: false, ...(args.argument ? {} : { defaultArgument: DEFAULT_ROOT }) } };
    }
    const spreadRow = { label: curveSpreadLabel(data.slope), ...data.slope, value: curveRoundedPrice(data.slope.value, root),
      annualizedRollYield: data.slope.annualizedRollYield == null ? null : Number(data.slope.annualizedRollYield.toFixed(2)),
      percentile: rank(data.slope.percentile), rollPercentile: rank(data.slope.rollPercentile), [SKIPPED_FIELD]: data.slope.skippedSymbols ?? [] };
    const spreadFormats = { ...ROLL_YIELD_FORMAT, ...thirtySecondsFormat(root, "value") };
    return {
      freshness,
      sections: [
        { title: "Contracts", columns: contractColumns(root, data.settlementDate ?? null, columnOptions),
          textColumns: contractColumns(root, data.settlementDate ?? null, { ...columnOptions, text: true }),
          ...unit ? { unit } : {},
          rows: data.contracts.map((row) => contractRow(row, data, root, !!date, bases?.get(row.symbol))) },
        { title: "Front spread", columns: spreadColumns(spreadRow, spreadFormats, false), textColumns: spreadColumns(spreadRow, spreadFormats, true),
          rows: [spreadRow] },
        ...spotPremium ? [{ title: "Front vs spot", entries: spotPremiumEntries(spotPremium, root) }] : [],
        ...terms.length ? [{ title: "Contract terms", entries: terms }] : [],
        ...data.ghosts.map((ghost) => ({ title: `${ghost.label} same-contract history`, columns: fieldColumns(GHOST_FIELDS, ghost.points[0] ?? {}, thirtySecondsFormat(root, "price")),
          ...unit ? { unit } : {}, rows: ghost.points.map((point) => ({ ...point })) })),
      ],
      errors: data.gaps,
      ...(notes.length ? { notes } : {}),
      metadata: { ...data, quoteUnit: unit, ...(spot && bases ? { spot, basisBlankedUnpaired: unpairedContractCount(bases.values()) } : {}),
        ...(spotPremium ? { spotPremium } : {}), ...(args.argument ? {} : { defaultArgument: DEFAULT_ROOT }),
        ...(notices.length ? { notices } : {}),
        complete: data.status === "available", percentileBasis: "Same-contract observations within one year; actual sample start/end retained" },
    };
  },
};
