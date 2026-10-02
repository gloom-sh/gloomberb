import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchCdxBoard, fetchSovrBoard, loadCurrencyMoves } from "./client";
import { cdxRows, formatContract, formatCurrencyMove, formatLevel, formatMove, sovrRows } from "./model";

const percentile = (value: unknown) => value == null ? "--" : Number(value).toFixed(0);

export const cdxHeadless: HeadlessPaneDefinition<"rows"> = {
  discovery: { aliases: ["CDX"], dataRequirements: ["Gloom Cloud index CDS endpoint"],
    limitations: ["Daily medians of public DTCC prints on the on-the-run 5Y contract", "HY and EM quote in price"] },
  shape: "rows",
  argument: { kind: "none" },
  options: [],
  columns: [
    { key: "name", header: "Index" },
    { key: "level", header: "5Y", align: "right" },
    { key: "change1D", header: "1D", align: "right" },
    { key: "change1W", header: "1W", align: "right" },
    { key: "percentile", header: "Pctl 1Y", align: "right", format: percentile },
    { key: "prints", header: "Prints", align: "right" },
    { key: "contract", header: "Contract" },
    { key: "date", header: "As of" },
  ],
  describe: "Index CDS",
  async load(_args, ctx) {
    const payload = await fetchCdxBoard(ctx.apiClient);
    return {
      rows: cdxRows(payload.indexes, payload.asOf).map((row) => ({
        name: row.label,
        level: formatLevel(row.index.quote, row.index.level),
        change1D: formatMove(row.index.quote, row.index.change1D),
        change1W: formatMove(row.index.quote, row.index.change1W),
        percentile: row.percentile,
        prints: row.index.prints,
        contract: formatContract(row.index.maturity),
        date: row.index.date,
      })),
      metadata: { asOf: payload.asOf },
    };
  },
};

export const sovrHeadless: HeadlessPaneDefinition<"rows"> = {
  discovery: { aliases: ["SOVR", "WCDS"], dataRequirements: ["Gloom Cloud sovereign CDS endpoint"],
    limitations: ["Daily 5Y levels from public DTCC prints; thinly traded names can miss days"] },
  shape: "rows",
  argument: { kind: "none" },
  options: [],
  columns: [
    { key: "name", header: "Sovereign" },
    { key: "level", header: "5Y", align: "right" },
    { key: "change1M", header: "1M", align: "right" },
    { key: "currency", header: "Ccy 1M", align: "right" },
    { key: "percentile", header: "Pctl 1Y", align: "right", format: percentile },
    { key: "date", header: "As of" },
  ],
  describe: "Sovereign CDS",
  async load(_args, ctx) {
    const payload = await fetchSovrBoard(ctx.apiClient);
    const moves = await loadCurrencyMoves(payload.sovereigns.map((row) => row.currency),
      (symbol) => ctx.marketData.getPriceHistory(symbol, "", "3M"));
    return {
      rows: sovrRows(payload.sovereigns, payload.asOf, moves).map((row) => ({
        name: row.label,
        level: formatLevel("spread", row.sovereign.level),
        change1M: formatMove("spread", row.sovereign.change1M),
        currency: formatCurrencyMove(row.sovereign.currency, row.currencyMove),
        percentile: row.percentile,
        date: row.sovereign.date,
      })),
      metadata: { asOf: payload.asOf },
    };
  },
};
