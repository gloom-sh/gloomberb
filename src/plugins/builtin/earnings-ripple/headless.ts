import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchEarningsCalendar } from "../earnings/client";
import { fetchSupplyChain } from "../supply-chain/client";
import { loadRipple } from "./client";
import { revenueOwner } from "./model";

const percent = (value: unknown) => typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "--";

export const earningsRippleHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  freshness: { source: "SEC filings and Gloom Cloud", status: "not-a-feed", basis: "filings and earnings calendar" },
  argument: { kind: "symbol-list", placeholder: "tickers", description: "Holdings to check against their customers' and suppliers' report dates.", minimum: 1, maximum: 60 },
  options: [],
  describe: (args) => `RIPL ${args.symbols.join(", ")}`,
  discovery: { screenshotReadiness: "live-dom", limitations: ["Customers each holding names in its own US filings, and suppliers whose US filings name it, with a share of revenue."] },
  async load(args, ctx) {
    const snapshot = await loadRipple(args.symbols, {
      supplyChain: (symbol) => fetchSupplyChain(symbol, ctx.apiClient),
      calendar: (query) => fetchEarningsCalendar(query, ctx.apiClient),
    });
    ctx.signal.throwIfAborted();
    return {
      sections: [{ title: `Customers and suppliers reporting ${snapshot.from} to ${snapshot.to}`, columns: [
        { key: "date", header: "Date" }, { key: "timing", header: "Time" }, { key: "company", header: "Reports" }, { key: "link", header: "Link" },
        { key: "holding", header: "Holding" }, { key: "pctOfRevenue", header: "Revenue %" }, { key: "revenueOf", header: "Of" }, { key: "averageMove", header: "Avg move", format: percent },
        { key: "holdingDate", header: "Holding reports" }, { key: "period", header: "Filing period" },
      ], rows: snapshot.rows.map((row) => ({ ...row, timing: row.timing?.toUpperCase() ?? null, link: row.link === "customer" ? "customer of" : "supplier to", revenueOf: revenueOwner(row) })) }],
      complete: snapshot.failures.length === 0 && snapshot.truncated.length === 0,
      unavailableSymbols: snapshot.failures.map((failure) => failure.symbol),
      // Same wording as SPLC: the preview's cut hides relationships, it does not mean there are none.
      errors: [...snapshot.failures.map((failure) => `${failure.symbol}: ${failure.error}`),
        ...(snapshot.truncated.length ? ["Additional relationships need Gloom Pro"] : [])],
      metadata: { from: snapshot.from, to: snapshot.to, truncated: snapshot.truncated, unit: "percent of the seller's revenue, as the seller's filing discloses it", methodology: "docs/research-data.md#earnings-ripple" },
    };
  },
};
