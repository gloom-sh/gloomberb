import { formatPriceEarnings, NOT_MEANINGFUL, PRICE_EARNINGS_NOTICE } from "../../../utils/price-earnings";
import type { HeadlessPaneColumn, HeadlessPaneContext, HeadlessPaneDefinition } from "../../../types/headless";
import { EXTENDED_SESSION_LABELS, type ExtendedSession } from "../../../market-data/market/status";
import { formatCompact, formatCurrency, formatLevelPercent, formatNumber, formatPercent, formatPercentRaw } from "../../../utils/format";
import { loadHeadlessFinancials, loadHeadlessSymbols } from "../shared/headless-market-data";
import { quoteFreshnessFields } from "../shared/report-freshness";
import {
  RELATIVE_VALUATION_STALE_FUNDAMENTALS_NOTICE, RELATIVE_VALUATION_STALE_QUOTE_NOTICE, relativeValuationValues, type RelativeValuationGapKey,
} from "./relative-valuation-model";
import { paneSchemas } from "./headless-schema";
import { isRecord } from "../../../utils/guards";
import { errorMessage } from "../../../utils/errors";
import { notATickerSymbol } from "../../../sources/provider-errors";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { pickPeers, peerMethodTitle, type PeerSelection } from "./relative-valuation-peers";
import { extraColumns, extraColumnsBasis, loadExtraColumns, parseExtraColumns } from "./relative-valuation-columns";
import { fundamentalsBasisParts } from "./relative-valuation-basis";
import { conversionNote, convertMarketCaps, loadFxLegs } from "./relative-valuation-currency";

const price = (value: unknown, row: Record<string, unknown>) => (
  value == null || !row.currency ? "-" : formatCurrency(Number(value), String(row.currency))
);
const percent = (value: unknown) => value == null ? "-" : formatPercentRaw(Number(value));

/** The reason a row lacks the figure under `key` ("no TTM FCF"), which exports move to their status column. */
function gapText(row: Record<string, unknown>, key: RelativeValuationGapKey): string {
  const gaps = row.gaps as Partial<Record<RelativeValuationGapKey, string>> | undefined;
  return gaps?.[key] ?? "-";
}

/**
 * The pre-market, after-hours or overnight print and its move from the regular close in Last, for the peers that have
 * one; "mid" when it is a bid and ask midpoint.
 */
function extendedColumn(session: ExtendedSession): HeadlessPaneColumn {
  return {
    key: "extendedPrice",
    header: EXTENDED_SESSION_LABELS[session],
    align: "right",
    format: (value, row) => row.extendedSession === session && typeof value === "number"
      ? `${price(value, row)}${row.extendedMark ? " mid" : ""} ${percent(row.extendedChangePercent)}`
      : "-",
  };
}

/**
 * An export's extended print: the price alone, in the row's currency, then its move from the close in a
 * `<session> Chg%` column, blank for a peer whose print is from another session or that has none.
 */
function extendedExportColumns(session: ExtendedSession): HeadlessPaneColumn[] {
  const label = EXTENDED_SESSION_LABELS[session];
  return [
    { key: "extendedPrice", header: label, align: "right", unitKey: "currency",
      format: (value, row) => row.extendedSession === session && typeof value === "number" ? price(value, row) : "-" },
    { key: "extendedChangePercent", header: `${label} Chg%`, align: "right",
      format: (value, row) => row.extendedSession === session && typeof value === "number" ? percent(value) : "-" },
  ];
}

const EXTENDED_SESSIONS = ["PRE", "POST", "OVERNIGHT"] as const;

/** Every session's columns, whichever peers have a print, so the header is the same before the open and after the close. */
const EXTENDED_EXPORT_COLUMNS = EXTENDED_SESSIONS.flatMap(extendedExportColumns);

// Last is in each peer's own currency: an export writes the number, and the row's `currency_or_unit` names its currency.
const QUOTE_COLUMNS: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Ticker" },
  { key: "price", header: "Last", align: "right", unitKey: "currency",
    format: (value, row) => value == null ? gapText(row, "price") : price(value, row) },
  { key: "changePercent", header: "Chg%", align: "right", format: (value, row) => value == null ? gapText(row, "changePercent") : percent(value) },
];

/** The latest quarter's revenue against the same quarter a year earlier; the footer names the quarter. */
const REVENUE_GROWTH_HEADER = "Quarter Revenue YoY";

const VALUATION_COLUMNS: HeadlessPaneColumn[] = [
  // In the currency each peer's cap is in, which exports write in the header or beside the figure.
  { key: "marketCap", header: "Mkt Cap", align: "right", unitKey: "marketCapCurrency", unitColumn: true,
    format: (value, row) => value == null ? gapText(row, "marketCap") : `${formatCompact(Number(value), { fixedDecimals: true })}${row.marketCapCurrency ? ` ${row.marketCapCurrency}` : ""}` },
  ...([ ["trailingPE", "P/E"], ["forwardPE", "Fwd P/E"] ] as const).map(([key, header]) => ({
    key, header, align: "right" as const,
    // The multiple as reported, else the comparable value itself, so an export reads the column as one of figures.
    format: (value: unknown, row: Record<string, unknown>) => {
      const values = row as Partial<ReturnType<typeof relativeValuationValues>>;
      const multiple = values.notMeaningful?.[key] ? NOT_MEANINGFUL : values.reportedMultiples?.[key] ?? (typeof value === "number" ? value : null);
      return multiple == null ? gapText(row, key) : formatPriceEarnings(multiple);
    },
  })),
  ...([["evSales", "EV/S"]] as const).map(([key, header]) => ({
    key, header, align: "right" as const,
    // A withdrawn EV says so rather than leaving a bare dash; the note under the table says why.
    format: (value: unknown, row: Record<string, unknown>) => value != null ? formatNumber(Number(value), 1) : gapText(row, key),
  })),
  ...([["fcfYield", "FCF Yield"], ["revenueGrowth", REVENUE_GROWTH_HEADER], ["operatingMargin", "TTM Op Margin"]] as const).map(([key, header]) => ({
    key, header, align: "right" as const,
    format: (value: unknown, row: Record<string, unknown>) => value == null ? gapText(row, key)
      : key === "revenueGrowth" ? formatPercent(Number(value)) : formatLevelPercent(Number(value)),
  })),
];

/** Peers `--peers` chose, as the expansion left them in the settings or the load picked them. */
function peerSelectionOf(value: unknown, symbols: readonly string[]): PeerSelection | null {
  if (!isRecord(value) || typeof value.subject !== "string" || !Array.isArray(value.peers)) return null;
  const selection = value as unknown as PeerSelection;
  const expected = [selection.subject, ...selection.peers];
  return expected.length === symbols.length && expected.every((symbol, index) => symbol.toUpperCase() === symbols[index]?.toUpperCase())
    ? selection : null;
}

/** The peers of the one symbol `--peers` was given; several symbols are already a peer list. */
async function choosePeers(symbols: readonly string[], ctx: HeadlessPaneContext): Promise<PeerSelection> {
  if (symbols.length !== 1) {
    throw new Error(`--peers picks the peers of one symbol, such as RV ${symbols[0] ?? "DUOL"} --peers; with several symbols, leave it out.`);
  }
  const subject = symbols[0]!;
  const financials = await loadHeadlessFinancials(ctx, subject).catch((error: unknown) => {
    ctx.signal.throwIfAborted();
    // A word that is no ticker is said as `fn RV duolingo lrn` says it, which the CLI follows with the search to run.
    if (notATickerSymbol(errorMessage(error))) throw error;
    // Any other failure leaves the peers to what the symbol alone places (a curated core's member).
    return null;
  });
  return pickPeers(subject, financials, ctx);
}

const PEER_SELECTION_SETTING = "peerSelection";

export const relativeValuationHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["relative-valuation-pane"],
  // What Ask Gloom reads. The template's "across peers" never said this is where a list of holdings' P/E is.
  description: "P/E, forward P/E, market cap, EV/sales, FCF yield, growth and margin for each ticker, one row each.",
  freshness: { datesEachVenue: true },
  shape: "rows",
  describe: ({ symbols }, result) => {
    const selection = peerSelectionOf(result?.metadata?.peerSelection, result?.symbols ?? symbols);
    return selection
      ? `Relative Valuation | ${selection.subject} and ${peerMethodTitle(selection)}`
      : `Relative Valuation | ${(result?.symbols ?? symbols).join(", ")}`;
  },
  columns: [...QUOTE_COLUMNS, ...EXTENDED_EXPORT_COLUMNS, ...VALUATION_COLUMNS],
  async expandArgument(args, ctx) {
    if (args.options.peers !== true) return null;
    const selection = await choosePeers(args.symbols, ctx);
    return {
      argument: [selection.subject, ...selection.peers].join(", "),
      settings: { [PEER_SELECTION_SETTING]: selection },
      title: `RV ${selection.subject} + ${peerMethodTitle(selection, { automatic: true })}`,
    };
  },
  async load(args, ctx) {
    // --peers picked in advance (fn and shot) reads the same peers; any other caller picks them here.
    const preset = args.options.peers === true ? peerSelectionOf(ctx.settings?.[PEER_SELECTION_SETTING], args.symbols) : null;
    const selection = args.options.peers === true ? preset ?? await choosePeers(args.symbols, ctx) : null;
    const symbols = selection ? [selection.subject, ...selection.peers] : args.symbols;
    const loaded = await loadHeadlessSymbols(symbols, ctx, (symbol) => loadHeadlessFinancials(ctx, symbol));
    const baseRows = loaded.entries.map(({ symbol, data }) => ({ symbol, ...relativeValuationValues(data), ...quoteFreshnessFields(data?.quote) }));
    const unavailableSymbols = [...loaded.unavailableSymbols, ...baseRows.filter((row) => ![
      row.marketCap, row.trailingPE, row.forwardPE, row.evSales, row.fcfYield, row.revenueGrowth, row.operatingMargin,
    ].some((value) => value != null)).map(({ symbol }) => symbol)];
    const staleSymbols = baseRows.filter((row) => row.quoteStale).map((row) => row.symbol);
    const staleFundamentalsSymbols = baseRows.filter((row) => row.fundamentalsProvenance?.stale).map((row) => row.symbol);

    // --currency: every cap in one currency, at the rates the app converts with.
    const capCurrency = typeof args.options.currency === "string" ? args.options.currency : null;
    const fx = capCurrency ? await loadFxLegs([capCurrency, ...baseRows.flatMap((row) => row.marketCapCurrency ?? [])], ctx) : null;
    const converted = capCurrency && fx ? convertMarketCaps(baseRows, capCurrency, fx.legs) : null;
    const capRows = converted?.rows ?? baseRows;

    // --columns: each added column read from the path its own function uses.
    const extraIds = parseExtraColumns(args.options.columns);
    const financials = new Map(loaded.entries.map(({ symbol, data }) => [symbol, data] as const));
    const extra = await loadExtraColumns(extraIds, capRows.map((row) => row.symbol), financials, ctx);
    const rows = capRows.map((row) => ({ ...row, ...extra.fields.get(row.symbol) }));

    const errors = [...loaded.errors,
      ...staleSymbols.map((symbol) => `${symbol}: ${RELATIVE_VALUATION_STALE_QUOTE_NOTICE}`),
      ...staleFundamentalsSymbols.map((symbol) => `${symbol}: ${RELATIVE_VALUATION_STALE_FUNDAMENTALS_NOTICE}`),
      ...extra.errors,
    ];
    const warnings = converted?.unconverted.map(({ currency, symbols: left }) => {
      const reason = fx?.failed.find((failure) => failure.currency === resolveCurrencyUnit(currency).currency)?.reason;
      return `No ${currency} rate${reason ? ` (${reason})` : ""}: ${left.join(", ")} ${left.length === 1 ? "keeps its" : "keep their"} market cap in ${currency}.`;
    }) ?? [];
    // The footer: the rates the caps were converted at, the statement period the figures run through, and the
    // basis of each column that is not trailing twelve months.
    const footnote = [
      ...capCurrency && converted ? [conversionNote(capCurrency, converted.conversions)] : [],
      ...fundamentalsBasisParts(rows, REVENUE_GROWTH_HEADER),
      ...extraColumnsBasis(extraIds, rows),
    ].filter(Boolean).join(" · ");
    const notes = [
      ...selection ? [`Peers chosen automatically: ${selection.basis}. To choose your own: gloomberb fn RV ${selection.subject} <tickers>.`] : [],
      ...extra.notes,
    ];
    // Last and Chg% are the regular session; an extended print gets a column only when a peer has one.
    // Exports keep every session's price and move, so their header is the same in every market state.
    const extendedSessions = EXTENDED_SESSIONS.filter((session) => rows.some((row) => row.extendedSession === session));
    const textColumns = [...QUOTE_COLUMNS, ...extendedSessions.map(extendedColumn), ...VALUATION_COLUMNS];
    const added = extraIds.length > 0 ? extraColumns(extraIds) : null;
    return {
      rows, unavailableSymbols, errors, complete: unavailableSymbols.length === 0 && errors.length === 0,
      ...(selection ? { symbols } : {}),
      columns: [...QUOTE_COLUMNS, ...EXTENDED_EXPORT_COLUMNS, ...VALUATION_COLUMNS, ...added?.export ?? []],
      textColumns: [...textColumns, ...added?.text ?? []],
      // Each peer's row names its ticker and the currency its prices are in.
      rowSymbolKey: "symbol",
      rowUnitKey: "currency",
      ...(notes.length > 0 ? { notes } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(footnote ? { freshness: { note: footnote } } : {}),
      metadata: {
        staleSymbols,
        staleFundamentalsSymbols,
        ...(selection ? { peerSelection: selection } : {}),
        ...(converted && capCurrency ? { marketCapConversion: { currency: capCurrency, rates: converted.conversions,
          basis: "marketCap is converted into the asked currency at each currency's US dollar rate, the rate the app's converted totals use; marketCapNative and marketCapNativeCurrency keep the cap as served." } } : {}),
        ...(extraIds.length > 0 ? { addedColumnsBasis: "Each added column keeps its own source and as-of beside it: short interest at its FINRA settlement date, analyst targets at retrieval, the next earnings date at the calendar's retrieval, gross margin and EV/EBITDA at the screener's statement date." } : {}),
        quoteBasis: "Stale quote fields are excluded from comparison; reportedQuote retains the rejected observation and quoteAsOf retains its source timestamp.",
        priceBasis: "price, change and changePercent are the regular session: after the close, its close and that close's move. A pre-market, after-hours or overnight print is in extendedPrice, extendedChange and extendedChangePercent, measured from that close (extendedMark when it is a bid and ask midpoint). marketCap, the P/E multiples, evSales (through the equity part of the enterprise value) and fcfYield are measured at that regular session price.",
        fundamentalsBasis: "Provider multiples and operating metrics retain independent fundamentalsProvenance. Retrieval time does not establish the valuation date.",
        notices: [
          ...rows.some((row) => Object.keys(row.notMeaningful).length > 0
            || Object.values(row.reportedMultiples).some((value) => value != null && value <= 0)) ? [PRICE_EARNINGS_NOTICE] : [],
          ...rows.flatMap((row) => row.evSalesUnavailable ? [`${row.symbol}: ${row.evSalesUnavailable}`] : []),
          ...rows.flatMap((row) => row.marketCapNote ? [`${row.symbol}: ${row.marketCapNote}`] : []),
        ],
        multipleBasis: "Comparable P/E fields require a positive finite multiple over positive EPS; notMeaningful says why one is null, and reportedMultiples preserves the finite provider values.",
        marketCapBasis: "Market caps retain their own currency and source. Fundamentals retrieval time is not a valuation date; quote timestamps do not date fallback caps.",
      },
    };
  },
};
