import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchEarningsCalendar } from "../earnings/client";
import { fetchSupplyChain } from "../supply-chain/client";
import { fetchSupplyGraph } from "../supply-chain/graph-client";
import { loadRipple } from "./client";
import { hopLabel, revenueOwner } from "./model";

const percent = (value: unknown) => typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "--";

export const earningsRippleHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  freshness: { source: "SEC filings and Gloom Cloud", status: "not-a-feed", basis: "filings and earnings calendar" },
  argument: { kind: "symbol-list", placeholder: "tickers", description: "Holdings to check against their customers' and suppliers' report dates.", minimum: 1, maximum: 60 },
  options: [{ key: "tab", type: "enum", settingKey: "tab", defaultValue: "direct", values: [{ value: "direct" }, { value: "two-hop" }],
    description: "Direct customers and suppliers, or also companies two hops away (Pro)." }],
  describe: (args) => `RIPL ${args.symbols.join(", ")}`,
  discovery: { screenshotReadiness: "live-dom", limitations: ["Customers each holding names in its own US filings, and suppliers whose US filings name it, with a share of revenue.",
    "Two hops: a supplier's supplier or a customer's customer from the supply chain graph, read from filings, company announcements and calls only, Pro only; companies already one hop away are left out."] },
  async load(args, ctx) {
    const secondHop = args.options.tab === "two-hop";
    const snapshot = await loadRipple(args.symbols, {
      supplyChain: (symbol) => fetchSupplyChain(symbol, ctx.apiClient),
      calendar: (query) => fetchEarningsCalendar(query, ctx.apiClient),
      graph: (symbol, options) => fetchSupplyGraph(symbol, options, "", ctx.apiClient),
    }, undefined, { secondHop });
    ctx.signal.throwIfAborted();
    const second = snapshot.secondHop;
    return {
      sections: [{ title: `Customers and suppliers reporting ${snapshot.from} to ${snapshot.to}`, columns: [
        { key: "date", header: "Date" }, { key: "timing", header: "Time" }, { key: "company", header: "Reports" }, { key: "link", header: "Link" },
        { key: "holding", header: "Holding" }, { key: "pctOfRevenue", header: "Revenue %" }, { key: "revenueOf", header: "Of" }, { key: "averageMove", header: "Avg move", format: percent },
        { key: "holdingDate", header: "Holding reports" }, { key: "period", header: "Filing period" },
      ], rows: snapshot.rows.map((row) => ({ ...row, timing: row.timing?.toUpperCase() ?? null, link: row.link === "customer" ? "customer of" : "supplier to", revenueOf: revenueOwner(row) })) },
      ...(second && !second.locked ? [{ title: `Two hops away, reporting ${snapshot.from} to ${snapshot.to}`, columns: [
        { key: "date", header: "Date" }, { key: "timing", header: "Time" }, { key: "company", header: "Reports" }, { key: "link", header: "Link" },
        { key: "via", header: "Via" }, { key: "holding", header: "Holding" }, { key: "hop1", header: "Holding to via" }, { key: "hop2", header: "Via to company" },
        { key: "exposure", header: "Estimated exposure" }, { key: "averageMove", header: "Avg move", format: percent }, { key: "holdingDate", header: "Holding reports" },
      ], rows: second.rows.map((row) => ({ ...row, timing: row.timing?.toUpperCase() ?? null, link: row.link === "customer" ? "customer's customer" : "supplier's supplier",
        hop1: hopLabel(row.hops[0]), hop2: hopLabel(row.hops[1]) })) }] : []),
      ],
      complete: snapshot.failures.length === 0 && snapshot.truncated.length === 0 && !second?.locked && !second?.failures.length && !second?.truncated.length,
      unavailableSymbols: snapshot.failures.map((failure) => failure.symbol),
      // Same wording as SPLC: the preview's cut hides relationships, it does not mean there are none.
      errors: [...snapshot.failures.map((failure) => `${failure.symbol}: ${failure.error}`),
        ...(snapshot.truncated.length ? ["Additional relationships need Gloom Pro"] : []),
        ...(second?.locked ? ["Companies two hops away need Gloom Pro"] : []),
        ...(second?.failures ?? []).map((failure) => `${failure.symbol} graph: ${failure.error}`),
        // As SPLC words it: the graph stopped at a limit, so companies two hops away may be missing.
        ...(second?.truncated ?? []).map(({ symbol, reasons }) => `${symbol}: ${reasons.length
          ? `Graph search incomplete: ${reasons.join(", ").replaceAll("_", " ")}` : "Graph results are truncated"}`)],
      metadata: { from: snapshot.from, to: snapshot.to, truncated: snapshot.truncated, ...(second ? { twoHopTruncated: second.truncated.map(({ symbol }) => symbol) } : {}),
        unit: "percent of the seller's revenue, as the seller's filing discloses it", methodology: "docs/research-data.md#earnings-ripple" },
    };
  },
};
