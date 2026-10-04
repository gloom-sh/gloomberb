import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchEarningsCalendar } from "../earnings/client";
import { fetchSupplyChain } from "../supply-chain/client";
import { loadRipple } from "./client";

const percent = (value: unknown) => typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "--";

export const earningsRippleHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "symbol-list", placeholder: "tickers", description: "Holdings to check against their customers' report dates.", minimum: 1, maximum: 60 },
  options: [],
  describe: (args) => `RIPL ${args.symbols.join(", ")}`,
  discovery: { screenshotReadiness: "live-dom", limitations: ["Customers each holding names in its own US filings with a share of its revenue."] },
  async load(args, ctx) {
    const snapshot = await loadRipple(args.symbols, {
      supplyChain: (symbol) => fetchSupplyChain(symbol, ctx.apiClient),
      calendar: (query) => fetchEarningsCalendar(query, ctx.apiClient),
    });
    ctx.signal.throwIfAborted();
    return {
      sections: [{ title: `Customers reporting ${snapshot.from} to ${snapshot.to}`, columns: [
        { key: "date", header: "Date" }, { key: "timing", header: "Time" }, { key: "customer", header: "Customer" },
        { key: "holding", header: "Holding" }, { key: "pctOfRevenue", header: "Revenue %" }, { key: "averageMove", header: "Avg move", format: percent },
        { key: "holdingDate", header: "Holding reports" }, { key: "period", header: "Filing period" },
      ], rows: snapshot.rows.map((row) => ({ ...row, timing: row.timing?.toUpperCase() ?? null })) }],
      complete: snapshot.failures.length === 0,
      unavailableSymbols: snapshot.failures.map((failure) => failure.symbol),
      errors: snapshot.failures.map((failure) => `${failure.symbol}: ${failure.error}`),
      metadata: { from: snapshot.from, to: snapshot.to, unit: "revenue share in percent as each holding's filing discloses it", methodology: "docs/research-data.md#earnings-ripple" },
    };
  },
};
