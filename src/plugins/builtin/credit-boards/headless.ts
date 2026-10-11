import type { HeadlessPaneColumn, HeadlessPaneDefinition, HeadlessPaneRow } from "../../../types/plugin";
import type { CreditIndexQuote } from "../../../api-client/credit-boards";
import { fetchCdxBoard, fetchSovrBoard, loadCurrencyMoves } from "./client";
import { cdxRows, formatContract, formatCurrencyMove, formatLevel, formatMove, quoteUnits, sovrRows } from "./model";

const percentile = (value: unknown) => value == null ? "--" : Number(value).toFixed(0);
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

/** The publisher a board's payload names, spelled out: `DTCC PPD` is DTCC's public price dissemination. */
function boardPublisher(source: string | null | undefined): string | undefined {
  return source?.trim().replace(/\bPPD\b/, "Public Price Dissemination") || undefined;
}

export const cdxHeadless: HeadlessPaneDefinition<"rows"> = {
  discovery: { aliases: ["CDX"], dataRequirements: ["Gloom Cloud index CDS endpoint"],
    limitations: ["Daily medians of public DTCC prints on the on-the-run 5Y contract.", "HY and EM quote in price, and move in points."] },
  shape: "rows",
  freshness: { source: "DTCC", status: "not-a-feed", basis: "daily medians of public trades", cadence: "daily", observedKey: "date" },
  argument: { kind: "none" },
  options: [],
  columns: [
    { key: "name", header: "Index" },
    levelColumn,
    moveColumn("change1D", "1D", "changeUnit"),
    moveColumn("change1W", "1W", "changeUnit"),
    { key: "percentile", header: "Pctl 1Y", align: "right", format: percentile },
    { key: "prints", header: "Prints", align: "right" },
    { key: "contract", header: "Contract" },
    { key: "date", header: "As of" },
  ],
  describe: "Index CDS",
  async load(_args, ctx) {
    const payload = await fetchCdxBoard(ctx.apiClient);
    const publisher = boardPublisher(payload.source);
    return {
      rows: cdxRows(payload.indexes, payload.asOf).map((row) => {
        const units = quoteUnits(row.index.quote);
        return {
          name: row.label,
          level: row.index.level,
          unit: units.level,
          change1D: row.index.change1D,
          change1W: row.index.change1W,
          changeUnit: units.move,
          percentile: row.percentile,
          prints: row.index.prints,
          contract: formatContract(row.index.maturity),
          date: row.index.date,
        };
      }),
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
  argument: { kind: "none" },
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
  async load(_args, ctx) {
    const payload = await fetchSovrBoard(ctx.apiClient);
    const moves = await loadCurrencyMoves(payload.sovereigns.map((row) => row.currency),
      (symbol) => ctx.marketData.getPriceHistory(symbol, "", "3M"));
    const publisher = boardPublisher(payload.source);
    return {
      rows: sovrRows(payload.sovereigns, payload.asOf, moves).map((row) => ({
        name: row.label,
        level: row.sovereign.level,
        unit: quoteUnits("spread").level,
        change1M: row.sovereign.change1M,
        currency: formatCurrencyMove(row.sovereign.currency, row.currencyMove),
        percentile: row.percentile,
        date: row.sovereign.date,
      })),
      metadata: { asOf: payload.asOf },
      ...(publisher ? { freshness: { publisher } } : {}),
    };
  },
};
