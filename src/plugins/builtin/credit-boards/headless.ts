import type { HeadlessPaneColumn, HeadlessPaneDefinition, HeadlessPaneRow } from "../../../types/plugin";
import type { CdxBoardIndex, CreditIndexQuote } from "../../../api-client/credit-boards";
import { CDX_MAX_DAYS, fetchCdxBoard, fetchSovrBoard, loadCurrencyMoves } from "./client";
import {
  cdxDay,
  cdxRows,
  findIndex,
  findSovereign,
  formatContract,
  formatCurrencyMove,
  formatLevel,
  formatMove,
  partialDayText,
  quoteUnits,
  sovrRows,
} from "./model";

const percentile = (value: unknown) => value == null ? "--" : Number(value).toFixed(0);
/** A 1Y rank as the board draws it, a whole number, so exports do not carry 8.23293172691. */
const rank = (value: number | null) => value == null ? null : Math.round(value);
/** The series a row is of, as `history` and the data catalog name it: `cdx:hy`, `sovereign-cds:br`. */
const cdxSeries = (id: string) => `cdx:${id.toLowerCase()}`;
const sovereignSeries = (id: string) => `sovereign-cds:${id.toLowerCase()}`;
const numberOrNull = (value: unknown) => typeof value === "number" ? value : null;
/** A row's quote, from the unit its level is in. */
const rowQuote = (row: HeadlessPaneRow): CreditIndexQuote => row.unit === "bp" ? "spread" : "price";

/**
 * Levels and moves are numbers with their unit beside them (`unit`,
 * `changeUnit`): text draws them as the board does (`58.3bp`, `106.69`,
 * `+0.17`), exports write the number and name the unit.
 */
const levelColumn: HeadlessPaneColumn = {
  key: "level", header: "5Y", align: "right", unitKey: "unit",
  textFormat: (value, row) => formatLevel(rowQuote(row), numberOrNull(value)),
};
const moveColumn = (key: string, header: string, unitKey: string): HeadlessPaneColumn => ({
  key, header, align: "right", unitKey,
  textFormat: (value, row) => formatMove(rowQuote(row), numberOrNull(value)),
});
/** HY and EM's price as a spread in bp; spread-quoted rows leave it blank, their level already is one. */
const spreadColumn: HeadlessPaneColumn = {
  key: "spreadBp", header: "Spread eq", align: "right", unitKey: "spreadUnit",
  description: "HY and EM: the price as a conventional spread in bp, under the ISDA standard model: a flat hazard rate, the index's "
    + "coupon (HY 500bp, EM 100bp) and standard recovery (HY 30%, EM 25%), the contract's maturity and that day's flat USD rate. "
    + "Price 100 is the coupon; above 100 the spread is under it.",
  textFormat: (value) => formatLevel("spread", numberOrNull(value)),
};
/** A day still trading says what it rests on; a complete day says nothing. */
const dayColumn: HeadlessPaneColumn = {
  key: "session", header: "Day",
  description: "Blank for a complete day. For today's New York trade date, still trading: so far, the prints behind its level and the last one's time (UTC).",
  format: (value) => typeof value === "string" ? value : "",
};

/** The publisher a board's payload names, spelled out: `DTCC PPD` is DTCC's public price dissemination. */
function boardPublisher(source: string | null | undefined): string | undefined {
  return source?.trim().replace(/\bPPD\b/, "Public Price Dissemination") || undefined;
}

/**
 * Each day's level on the contract on the run that day, newest first, over
 * the last `days`: the chart as a table. Its key is `day`, not `date`, so the
 * history is not read as the board's own observation dates; every exported
 * row is dated by its day and names the series and unit. HY and EM carry each
 * day's spread equivalent, and today's day, still trading, says so.
 */
function historySection(index: CdxBoardIndex, days: number, now: number) {
  const unit = quoteUnits(index.quote).level;
  const latest = index.points.at(-1)?.date;
  const from = latest ? new Date(Date.parse(`${latest}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10) : "";
  const today = cdxDay(index, now);
  // A server that predates the spread equivalent sends none: no column of blanks.
  const priced = index.quote === "price" && index.points.some((point) => point.spreadBp !== undefined);
  const partial = today.partial && latest === index.date;
  const symbol = cdxSeries(index.id);
  return {
    title: `${index.name} 5Y daily ${index.quote === "spread" ? "spread" : "price"}`,
    columns: [
      { key: "day", header: "Date" },
      { ...levelColumn, header: index.quote === "spread" ? "Spread" : "Price" },
      ...(priced ? [spreadColumn] : []),
      { key: "prints", header: "Prints", align: "right" as const },
      { key: "maturity", header: "Contract", textFormat: (value: unknown) => formatContract(typeof value === "string" ? value : null) },
      ...(partial ? [dayColumn] : []),
    ],
    rows: index.points.filter((point) => point.date > from).reverse().map((point) => ({
      day: point.date, level: point.level, unit,
      ...(priced ? { spreadBp: point.spreadBp ?? null, spreadUnit: "bp" } : {}),
      prints: point.prints, maturity: point.maturity, series: symbol,
      ...(partial && point.date === latest ? { session: partialDayText(point.prints, today.lastPrintAt), partial: true, lastPrintAt: today.lastPrintAt } : {}),
    })),
    rowUnitKey: "unit",
    rowSymbolKey: "series",
    rowAsOfKey: "day",
    interval: "daily",
  };
}

const CDX_COLUMNS: HeadlessPaneColumn[] = [
  { key: "name", header: "Index" },
  levelColumn,
  moveColumn("change1D", "1D", "changeUnit"),
  moveColumn("change1W", "1W", "changeUnit"),
  moveColumn("change1M", "1M", "changeUnit"),
  spreadColumn,
  { key: "percentile", header: "Pctl 1Y", align: "right", format: percentile },
  { key: "prints", header: "Prints", align: "right" },
  { key: "contract", header: "Contract" },
  { key: "date", header: "As of" },
];

export const cdxHeadless: HeadlessPaneDefinition<"bundle"> = {
  discovery: { aliases: ["CDX"], dataRequirements: ["Gloom Cloud index CDS endpoint"],
    limitations: ["Daily medians of public DTCC prints on the on-the-run 5Y contract.", "HY and EM quote in price, and move in points; Spread eq converts their price at a standard coupon and recovery, a model figure, not a traded spread.",
      "Today's New York trade date is so far until it ends; the moves compare complete days."] },
  shape: "bundle",
  freshness: { source: "DTCC", status: "not-a-feed", basis: "daily medians of public trades", cadence: "daily", observedKey: "date" },
  argument: { kind: "free-text", optional: true, placeholder: "index",
    description: "An index (IG, HY, EM, MAIN, XOVER) for its daily history; omit for the board." },
  options: [{ key: "days", shot: { reportOnly: "sets how many days of an index's history the text report prints" }, type: "integer", minimum: 30, maximum: CDX_MAX_DAYS, defaultValue: 365,
    description: "Days of a named index's daily levels." }],
  describe: "Index CDS",
  async load(args, ctx) {
    const days = Number(args.options.days ?? 365);
    // The 1Y rank always reads a full year, whatever history is asked for.
    const payload = await fetchCdxBoard(ctx.apiClient, Math.max(days, 365));
    const query = typeof args.argument === "string" ? args.argument.trim() : "";
    const index = query ? findIndex(payload.indexes, query) : null;
    if (query && !index) throw new Error(`No index ${query}. Use one of: ${payload.indexes.map((entry) => entry.id).join(", ")}.`);
    const publisher = boardPublisher(payload.source);
    const now = Date.now();
    const shown = index ? [index] : payload.indexes;
    // A server that predates the spread equivalent sends none: no column of blanks.
    const spreads = shown.some((entry) => entry.spreadBp !== undefined);
    const rows = cdxRows(shown, payload.asOf, now).map((row) => {
      const units = quoteUnits(row.index.quote);
      const priced = spreads && row.index.quote === "price";
      return {
        name: row.label,
        series: cdxSeries(row.index.id),
        level: row.index.level,
        unit: units.level,
        change1D: row.day.change1D,
        change1W: row.day.change1W,
        change1M: row.day.change1M,
        changeUnit: units.move,
        ...(priced ? { spreadBp: row.index.spreadBp ?? null, spreadUnit: "bp" } : {}),
        percentile: rank(row.percentile),
        prints: row.index.prints,
        contract: formatContract(row.index.maturity),
        date: row.index.date,
        changeDate: row.day.changeDate,
        ...(row.day.partial ? { session: partialDayText(row.index.prints, row.day.lastPrintAt), partial: true, lastPrintAt: row.day.lastPrintAt } : {}),
      };
    });
    const anyPartial = rows.some((row) => row.partial === true);
    return {
      sections: [
        {
          title: "On the run, 5Y", columns: [...CDX_COLUMNS.filter((column) => spreads || column !== spreadColumn), ...(anyPartial ? [dayColumn] : [])], rows,
          rowUnitKey: "unit", rowSymbolKey: "series", rowAsOfKey: "date", interval: "daily",
        },
        ...(index ? [historySection(index, days, now)] : []),
      ],
      ...(anyPartial ? { notes: ["Today's New York trade date is still trading: its level and prints are so far, and 1D, 1W and 1M run to the last complete day."] } : {}),
      metadata: { asOf: payload.asOf },
      ...(publisher ? { freshness: { publisher } } : {}),
    };
  },
};

export const sovrHeadless: HeadlessPaneDefinition<"rows"> = {
  discovery: { aliases: ["SOVR", "WCDS"], dataRequirements: ["Gloom Cloud sovereign CDS endpoint"],
    limitations: ["Daily 5Y levels from public DTCC prints; thinly traded names can miss days."] },
  shape: "rows",
  freshness: { source: "DTCC", status: "not-a-feed", basis: "daily levels of public trades", cadence: "daily", observedKey: "date" },
  argument: { kind: "free-text", optional: true, placeholder: "country",
    description: "A country (Brazil, BR) to list its row alone; omit for every sovereign." },
  options: [],
  columns: [
    { key: "name", header: "Sovereign" },
    levelColumn,
    moveColumn("change1M", "1M", "unit"),
    { key: "currency", header: "Ccy 1M", align: "right" },
    { key: "percentile", header: "Pctl 1Y", align: "right", format: percentile },
    { key: "date", header: "As of" },
  ],
  describe: "Sovereign CDS",
  async load(args, ctx) {
    const payload = await fetchSovrBoard(ctx.apiClient);
    const query = typeof args.argument === "string" ? args.argument.trim() : "";
    const country = query ? findSovereign(payload.sovereigns, query) : null;
    if (query && !country) throw new Error(`No sovereign ${query}. Use one of: ${payload.sovereigns.map((entry) => entry.name).join(", ")}.`);
    const sovereigns = country ? [country] : payload.sovereigns;
    const moves = await loadCurrencyMoves(sovereigns.map((row) => row.currency),
      (symbol) => ctx.marketData.getPriceHistory(symbol, "", "3M"));
    const publisher = boardPublisher(payload.source);
    return {
      rows: sovrRows(sovereigns, payload.asOf, moves).map((row) => ({
        name: row.label,
        series: sovereignSeries(row.sovereign.id),
        level: row.sovereign.level,
        unit: quoteUnits("spread").level,
        change1M: row.sovereign.change1M,
        currency: formatCurrencyMove(row.sovereign.currency, row.currencyMove),
        percentile: rank(row.percentile),
        date: row.sovereign.date,
      })),
      rowUnitKey: "unit",
      rowSymbolKey: "series",
      rowAsOfKey: "date",
      interval: "daily",
      metadata: { asOf: payload.asOf },
      ...(publisher ? { freshness: { publisher } } : {}),
    };
  },
};
