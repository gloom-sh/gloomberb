import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { formatCompact, formatNumber } from "../../../utils/format";
import { createShortWatchDependencies, loadShortWatch } from "./watch-client";
import { customUniverse, type ShortWatchSetup, setupLabel, SHORT_WATCH_LIMIT, sortShortWatchRows } from "./watch-model";

const number = (digits: number, suffix = "") => (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? `${formatNumber(value, digits)}${suffix}` : "--";
const signedPercent = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? `${value > 0 ? "+" : ""}${formatNumber(value, 1)}%` : "--";

export const shortWatchHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  argument: { kind: "symbol-list", maximum: SHORT_WATCH_LIMIT, description: "US tickers; the pane defaults to your portfolios and watchlists." },
  options: [],
  describe: "Short squeeze watch",
  discovery: {
    aliases: ["SIW"],
    screenshotReadiness: "live-dom",
    dataRequirements: ["FINRA short interest settlements", "Float", "Daily closes"],
    limitations: ["Percent of float uses the current float against the settlement's shares short",
      "Crowded is a fixed threshold, not a squeeze forecast"],
  },
  columns: [
    { key: "symbol", header: "Symbol" },
    { key: "setup", header: "Setup", format: (value) => setupLabel(value as ShortWatchSetup | null) || "--" },
    { key: "percentFloat", header: "% Float", align: "right", format: number(2, "%") },
    { key: "daysToCover", header: "Days to Cover", align: "right", format: number(2) },
    { key: "changePercent", header: "SI Chg %", align: "right", format: signedPercent },
    { key: "return1M", header: "1M %", align: "right", format: signedPercent },
    { key: "sharesShort", header: "Shares Short", align: "right", format: (value) => typeof value === "number" ? formatCompact(value) : "--" },
    { key: "settlementDate", header: "Settled" },
    { key: "closeDate", header: "Close" },
  ],
  async load(args, ctx) {
    const universe = customUniverse(args.symbols.join(","));
    const rows = sortShortWatchRows(await loadShortWatch(universe.symbols, { signal: ctx.signal, forceRefresh: ctx.refresh },
      createShortWatchDependencies(ctx.marketData, ctx.apiClient)), "setup", "desc");
    const missing = rows.filter((row) => !row.settlementDate);
    return {
      rows: rows.map(({ error: _error, ...row }) => row),
      complete: !missing.length && !universe.notice && rows.every((row) => row.return1M != null),
      symbols: universe.symbols,
      unavailableSymbols: missing.map((row) => row.symbol),
      errors: [universe.notice, ...missing.map((row) => `${row.symbol}: ${row.error ?? "No short interest reported"}`)]
        .filter((value): value is string => !!value),
      metadata: { methodology: "docs/research-data.md#short-squeeze-watch-siw" },
    };
  },
};
