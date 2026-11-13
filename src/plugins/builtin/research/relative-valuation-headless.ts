import { withBalanceSheetRate } from "../../../market-data/quotes/balance-sheet-rate";
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
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import {
  AUTO_PEERS_SETTING, findPeers, peerMethodTitle, peerSelectionOf, PEER_SELECTION_SETTING, relativeValuationTitle, type PeerSelection,
} from "./relative-valuation-peers";
import { extraColumns, extraColumnsBasis, loadExtraColumns, parseExtraColumns } from "./relative-valuation-columns";
import { fundamentalsBasisParts, revenueGrowthHalfTag, revenueGrowthHeader } from "./relative-valuation-basis";
import { conversionNote, convertMarketCaps, convertTargets, loadFxLegs, relativeCapCurrency, type CapConversion } from "./relative-valuation-currency";

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
  // The company each ticker was read as: MTN is Vail Resorts in New York, MTN Group only as MTN:JSE.
  { key: "name", header: "Name", format: (value) => typeof value === "string" && value ? value : "-" },
  { key: "price", header: "Last", align: "right", unitKey: "currency",
    format: (value, row) => value == null ? gapText(row, "price") : price(value, row) },
  { key: "changePercent", header: "Chg%", align: "right", format: (value, row) => value == null ? gapText(row, "changePercent") : percent(value) },
];

/** The latest quarter's revenue against the same quarter a year earlier; the footer names the quarter. */
const REVENUE_GROWTH_HEADER = "Quarter Revenue YoY";
/** The column's name once a peer reports half-yearly: its figure is a half's (`H1`), named in the footer. */
const PERIOD_REVENUE_GROWTH_HEADER = "Revenue YoY";

const VALUATION_COLUMNS: HeadlessPaneColumn[] = [
  // In the currency each peer's cap is in, which exports write in the header or beside the figure.
  { key: "marketCap", header: "Mkt Cap", align: "right", unitKey: "marketCapCurrency", unitColumn: true,
    format: (value, row) => value == null ? gapText(row, "marketCap") : `${formatCompact(Number(value), { fixedDecimals: true })}${row.marketCapCurrency ? ` ${row.marketCapCurrency}` : ""}` },
  ...([ ["trailingPE", "P/E"], ["forwardPE", "Fwd P/E"] ] as const).map(([key, header]) => {
    // The multiple as reported, else the comparable value itself, so an export reads the column as one of figures.
    const multipleOf = (value: unknown, row: Record<string, unknown>) => {
      const values = row as Partial<ReturnType<typeof relativeValuationValues>>;
      return values.notMeaningful?.[key] ? NOT_MEANINGFUL : values.reportedMultiples?.[key] ?? (typeof value === "number" ? value : null);
    };
    return {
      key, header, align: "right" as const,
      format: (value: unknown, row: Record<string, unknown>) => {
        const multiple = multipleOf(value, row);
        return multiple == null ? gapText(row, key) : formatPriceEarnings(multiple);
      },
      // A P/E on a fiscal year's EPS, where no four newer quarters were filed, says which year; an export has it in P/E period.
      textFormat: (value: unknown, row: Record<string, unknown>) => {
        const multiple = multipleOf(value, row);
        const year = key === "trailingPE" && multiple !== NOT_MEANINGFUL ? (row as Partial<ReturnType<typeof relativeValuationValues>>).trailingPEPeriod : null;
        return multiple == null ? gapText(row, key) : year ? `${formatPriceEarnings(multiple)} ${year}` : formatPriceEarnings(multiple);
      },
    };
  }),
  ...([["evSales", "EV/S"]] as const).map(([key, header]) => ({
    key, header, align: "right" as const,
    // A withdrawn EV says so rather than leaving a bare dash, one at or below zero reads N/M; the note under the table says why.
    format: (value: unknown, row: Record<string, unknown>) => value != null ? formatNumber(Number(value), 1)
      : (row as Partial<ReturnType<typeof relativeValuationValues>>).notMeaningful?.evSales ? formatPriceEarnings(NOT_MEANINGFUL)
        : gapText(row, key),
  })),
  ...([["fcfYield", "FCF Yield"], ["revenueGrowth", REVENUE_GROWTH_HEADER], ["operatingMargin", "TTM Op Margin"]] as const).map(([key, header]) => ({
    key, header, align: "right" as const,
    // A figure alone, so an export's column holds only numbers; the period is in its own column (VALUATION_PERIOD_COLUMNS).
    format: (value: unknown, row: Record<string, unknown>) => value == null ? gapText(row, key)
      : key === "revenueGrowth" ? formatPercent(Number(value)) : formatLevelPercent(Number(value)),
    textFormat: (value: unknown, row: Record<string, unknown>) => value == null ? gapText(row, key)
      : key === "revenueGrowth" ? [formatPercent(Number(value)), revenueGrowthHalfTag(row.revenueGrowthHalf as string | null)].filter(Boolean).join(" ")
        // A margin of the latest fiscal year, where no trailing quarters were served, says which year.
        : key === "operatingMargin" && typeof row.operatingMarginPeriod === "string"
          ? `${formatLevelPercent(Number(value))} ${row.operatingMarginPeriod}` : formatLevelPercent(Number(value)),
  })),
];

/**
 * The period each export's figure is of, in a column after it, where the text
 * table puts it beside the figure: a P/E on a fiscal year's EPS (`FY Mar-26`),
 * a half's revenue growth (`H2 FY26 vs H2 FY25`) or a quarter's (`quarter to
 * 2026-09-30`), a fiscal year's margin (`FY25`); `TTM` for a trailing figure.
 */
const VALUATION_PERIOD_COLUMNS: Record<string, HeadlessPaneColumn> = {
  trailingPE: { key: "trailingPEPeriod", header: "P/E period",
    format: (value, row) => row.trailingPE == null && !(row.reportedMultiples as Record<string, unknown> | undefined)?.trailingPE ? "" : typeof value === "string" && value ? value : "TTM" },
  revenueGrowth: { key: "revenueGrowthHalf", header: "Revenue YoY period",
    format: (value, row) => row.revenueGrowth == null ? "" : typeof value === "string" && value ? value
      : typeof row.revenueGrowthQuarter === "string" ? `quarter to ${row.revenueGrowthQuarter}` : "" },
  operatingMargin: { key: "operatingMarginPeriod", header: "TTM Op Margin period",
    format: (value, row) => row.operatingMargin == null ? "" : typeof value === "string" && value ? value : "TTM" },
};

/** VALUATION_COLUMNS as exports write them: each figure's period in a column after it. */
const VALUATION_EXPORT_COLUMNS: HeadlessPaneColumn[] = VALUATION_COLUMNS.flatMap((column) => {
  const period = VALUATION_PERIOD_COLUMNS[column.key];
  return period ? [column, period] : [column];
});

/** The peers of the one symbol `--peers` was given; several symbols are already a peer list. */
async function choosePeers(symbols: readonly string[], ctx: HeadlessPaneContext): Promise<PeerSelection> {
  if (symbols.length !== 1) {
    throw new Error(`--peers picks the peers of one symbol, such as RV ${symbols[0] ?? "DUOL"} --peers; with several symbols, leave it out.`);
  }
  return findPeers(symbols[0]!, ctx);
}

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
  columns: [...QUOTE_COLUMNS, ...EXTENDED_EXPORT_COLUMNS, ...VALUATION_EXPORT_COLUMNS],
  async expandArgument(args, ctx) {
    if (args.options.peers !== true) return null;
    const selection = await choosePeers(args.symbols, ctx);
    return {
      argument: [selection.subject, ...selection.peers].join(", "),
      settings: { [PEER_SELECTION_SETTING]: selection },
      title: relativeValuationTitle([], selection),
    };
  },
  // The app adds the peers of a pane opened on one ticker; a capture draws the tickers given, as the report does,
  // unless --peers widened them.
  shotState: (args) => args.options.peers === true ? {} : { settings: { [AUTO_PEERS_SETTING]: false } },
  async load(args, ctx) {
    // --peers picked in advance (fn and shot) reads the same peers; any other caller picks them here.
    const preset = args.options.peers === true ? peerSelectionOf(ctx.settings?.[PEER_SELECTION_SETTING], args.symbols) : null;
    const selection = args.options.peers === true ? preset ?? await choosePeers(args.symbols, ctx) : null;
    const symbols = selection ? [selection.subject, ...selection.peers] : args.symbols;
    // A withdrawn EV's bridge converts a balance sheet in another currency at our close on its date, as `fundamentals` does.
    const loaded = await loadHeadlessSymbols(symbols, ctx, async (symbol) => withBalanceSheetRate(await loadHeadlessFinancials(ctx, symbol)));
    const baseRows = loaded.entries.map(({ symbol, data }) => ({ symbol, ...relativeValuationValues(data), ...quoteFreshnessFields(data?.quote) }));
    const unavailableSymbols = [...loaded.unavailableSymbols, ...baseRows.filter((row) => ![
      row.marketCap, row.trailingPE, row.forwardPE, row.evSales, row.fcfYield, row.revenueGrowth, row.operatingMargin,
    ].some((value) => value != null)).map(({ symbol }) => symbol)];
    const staleSymbols = baseRows.filter((row) => row.quoteStale).map((row) => row.symbol);
    const staleFundamentalsSymbols = baseRows.filter((row) => row.fundamentalsProvenance?.stale).map((row) => row.symbol);

    // Every cap in one currency, at the rates the app converts with, as the pane compares them: the one --currency asks
    // for, else the peers' own when they share one, else the app's base currency.
    const askedCurrency = typeof args.options.currency === "string" ? args.options.currency : null;
    const capCurrency = relativeCapCurrency(askedCurrency, baseRows.map((row) => row.marketCapCurrency), ctx.config?.baseCurrency);
    const converts = askedCurrency != null || baseRows.some((row) => row.marketCapCurrency && row.marketCapCurrency !== capCurrency);
    const fx = converts ? await loadFxLegs([capCurrency, ...baseRows.flatMap((row) => row.marketCapCurrency ?? [])], ctx) : null;
    const converted = fx ? convertMarketCaps(baseRows, capCurrency, fx.legs) : null;
    const capRows = converted?.rows ?? baseRows;

    // --columns: each added column read from the path its own function uses.
    const extraIds = parseExtraColumns(args.options.columns);
    const financials = new Map(loaded.entries.map(({ symbol, data }) => [symbol, data] as const));
    const extra = await loadExtraColumns(extraIds, capRows.map((row) => row.symbol), financials, ctx);
    const extraRows = capRows.map((row) => ({ ...row, ...extra.fields.get(row.symbol) }));
    // Analyst targets go into the asked currency with the caps, at the same rates.
    const targetCurrencies = askedCurrency && fx ? extraRows.flatMap((row): string[] => {
      const currency = (row as Record<string, unknown>).targetCurrency;
      return typeof currency === "string" && currency ? [currency] : [];
    }) : [];
    const targetFx = targetCurrencies.length > 0 ? await loadFxLegs(targetCurrencies.filter((currency) => !fx!.legs.has(resolveCurrencyUnit(currency).currency)), ctx) : null;
    const targets = askedCurrency && fx && targetCurrencies.length > 0
      ? convertTargets(extraRows, capCurrency, new Map([...fx.legs, ...targetFx?.legs ?? []])) : null;
    const rows = targets?.rows ?? extraRows;
    const conversions = [...converted?.conversions ?? [], ...targets?.conversions ?? []]
      .filter((conversion, index, all): conversion is CapConversion => all.findIndex((other) => other.from === conversion.from) === index);

    const errors = [...loaded.errors,
      ...staleSymbols.map((symbol) => `${symbol}: ${RELATIVE_VALUATION_STALE_QUOTE_NOTICE}`),
      ...staleFundamentalsSymbols.map((symbol) => `${symbol}: ${RELATIVE_VALUATION_STALE_FUNDAMENTALS_NOTICE}`),
      ...extra.errors,
    ];
    const failedRates = [...fx?.failed ?? [], ...targetFx?.failed ?? []];
    const unconvertedWarning = (what: string) => ({ currency, symbols: left }: { currency: string; symbols: string[] }) => {
      const reason = failedRates.find((failure) => failure.currency === resolveCurrencyUnit(currency).currency)?.reason;
      return `No ${currency} rate${reason ? ` (${reason})` : ""}: ${left.join(", ")} ${left.length === 1 ? "keeps its" : "keep their"} ${what} in ${currency}.`;
    };
    const warnings = [
      ...converted?.unconverted.map(unconvertedWarning("market cap")) ?? [],
      ...targets?.unconverted.map(unconvertedWarning("analyst target")) ?? [],
    ];
    // A half-year reporter's growth is a half's: the column is named for no one period and each half says so.
    const growthHeader = revenueGrowthHeader(rows, REVENUE_GROWTH_HEADER, PERIOD_REVENUE_GROWTH_HEADER);
    // The footer: the rates the caps were converted at, the statement period the figures run through, and the
    // basis of each column that is not trailing twelve months.
    const footnote = [
      ...converted ? [conversionNote(capCurrency, conversions,
        targets?.conversions.length ? `market caps and analyst targets in ${capCurrency}` : undefined)] : [],
      ...fundamentalsBasisParts(rows, growthHeader),
      ...extraColumnsBasis(extraIds, rows),
    ].filter(Boolean).join(" · ");
    const notes = [
      ...selection ? [`Peers chosen automatically: ${selection.basis}. To choose your own: gloom fn RV ${selection.subject} <tickers>.`] : [],
      ...extra.notes,
    ];
    // Last and Chg% are the regular session; an extended print gets a column only when a peer has one.
    // Exports keep every session's price and move, so their header is the same in every market state.
    const extendedSessions = EXTENDED_SESSIONS.filter((session) => rows.some((row) => row.extendedSession === session));
    const textColumns = [...QUOTE_COLUMNS, ...extendedSessions.map(extendedColumn),
      ...VALUATION_COLUMNS.map((column) => column.key === "revenueGrowth" ? { ...column, header: growthHeader } : column)];
    const added = extraIds.length > 0 ? extraColumns(extraIds) : null;
    return {
      rows, unavailableSymbols, errors, complete: unavailableSymbols.length === 0 && errors.length === 0,
      ...(selection ? { symbols } : {}),
      columns: [...QUOTE_COLUMNS, ...EXTENDED_EXPORT_COLUMNS, ...VALUATION_EXPORT_COLUMNS, ...added?.export ?? []],
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
        ...(converted ? { marketCapConversion: { currency: capCurrency, rates: converted.conversions,
          basis: "marketCap is converted into one currency (the asked one, else the peers' own when they share one, else the base currency) at each currency's US dollar rate, the rate the app's converted totals use; marketCapNative and marketCapNativeCurrency keep the cap as served." } } : {}),
        ...(extraIds.length > 0 ? { addedColumnsBasis: "Each added column keeps its own source and as-of beside it: short interest at its FINRA settlement date, analyst targets at retrieval (converted with the caps under --currency, targetMeanNative keeping the served one), the next earnings date at the calendar's retrieval, gross margin and EV/EBITDA at the end of the latest quarter they sum. EV/EBITDA is the listing's enterprise value over the trailing four quarters of operating income plus D&A, as GE's EV/EBITDA ends." } : {}),
        quoteBasis: "Stale quote fields are excluded from comparison; reportedQuote retains the rejected observation and quoteAsOf retains its source timestamp.",
        priceBasis: "price, change and changePercent are the regular session: after the close, its close and that close's move. A pre-market, after-hours or overnight print is in extendedPrice, extendedChange and extendedChangePercent, measured from that close (extendedMark when it is a bid and ask midpoint). marketCap, the P/E multiples, evSales (through the equity part of the enterprise value) and fcfYield are measured at that regular session price.",
        fundamentalsBasis: "Provider multiples and operating metrics retain independent fundamentalsProvenance. Retrieval time does not establish the valuation date.",
        notices: [
          ...rows.some((row) => row.notMeaningful.trailingPE || row.notMeaningful.forwardPE
            || Object.values(row.reportedMultiples).some((value) => value != null && value <= 0)) ? [PRICE_EARNINGS_NOTICE] : [],
          ...rows.flatMap((row) => row.evSalesUnavailable ? [`${row.symbol}: ${row.evSalesUnavailable}`] : []),
          ...rows.flatMap((row) => row.evSalesNote ? [`${row.symbol}: ${row.evSalesNote}`] : []),
          ...rows.flatMap((row) => row.marketCapNote ? [`${row.symbol}: ${row.marketCapNote}`] : []),
          ...rows.flatMap((row) => row.marketCapWithheld ? [`${row.symbol}: ${row.marketCapWithheld}`] : []),
        ],
        multipleBasis: "Comparable P/E fields require a positive finite multiple over positive EPS, and evSales an enterprise value above zero; notMeaningful says why one is null, and reportedMultiples preserves the finite provider P/E values.",
        marketCapBasis: "Market caps retain their own currency and source. Fundamentals retrieval time is not a valuation date; quote timestamps do not date fallback caps.",
      },
    };
  },
};
