import { describe, expect, test } from "bun:test";
import type { EarningsCalendarQuery, EarningsCalendarReport } from "../../../api-client/earnings";
import type { SupplyChainPayload } from "../../../api-client/supply-chain";
import { DEFAULT_GRAPH_OPTIONS, type GraphOptions, type GraphPayload } from "../../../api-client/supply-chain-graph";
import type { PaneTemplateContext } from "../../../types/plugin";
import { graphOptions } from "../supply-chain/graph-client";
import { supplyChainModule } from "../supply-chain/index";
import { graphPayload } from "../supply-chain/test-fixture-graph";
import { cachedRippleSources, loadRipple, rippleRouteSettings } from "./client";

const link = (role: "customer" | "supplier") => (ticker: string) => ({
  role, counterparty: { ticker, name: ticker, exchange: "NASDAQ", aggregate: false },
  pctBasis: "revenue", pctOfRevenue: 10, pctScope: null, period: "2026-03-31",
});
const chain = (symbol: string, customers: string[], suppliers: string[] = [], truncated = false): SupplyChainPayload =>
  ({ symbol, says: customers.map(link("customer")), names: suppliers.map(link("supplier")), truncated } as SupplyChainPayload);
const report = (symbol: string, date = "2026-11-15"): EarningsCalendarReport =>
  ({ symbol, name: symbol, date, timing: "amc", averageMove: 0.025, averageReports: 8 } as EarningsCalendarReport);
/** The SPLC fixture around a holding: a private supplier one hop up, and `company` two hops up through it. */
const graph = (symbol: string, company: string, overrides: Partial<GraphPayload> = {}): GraphPayload => {
  const base = graphPayload();
  return { ...base, symbol, nodes: base.nodes.map((node) => node.id === "3" ? { ...node, ticker: company, name: company } : node), ...overrides };
};
const calendarOf = (reports: EarningsCalendarReport[], queries: EarningsCalendarQuery[] = []) => async (query: EarningsCalendarQuery) => {
  queries.push(query);
  return { asOf: "2026-11-01", from: query.from, to: query.to, reports: reports.filter((row) => query.symbols?.includes(row.symbol)) };
};
const NOW = new Date("2026-11-01T12:00:00Z");

describe("loadRipple", () => {
  test("a failing calendar after slow disclosures rejects once, with no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(loadRipple(["CRUS", "QRVO"], {
        supplyChain: async (symbol) => { await Bun.sleep(30); return chain(symbol, ["AAPL"]); },
        calendar: () => Promise.reject(new Error("calendar down")),
      })).rejects.toThrow("calendar down");
      await Bun.sleep(60);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("requests customers and holdings explicitly within the New York date window", async () => {
    const queries: EarningsCalendarQuery[] = [];
    const reports = [report("AAPL"), report("SMALL"), report("CRUS", "2026-11-20"), report("QRVO", "2026-11-21"), report("UNRELATED")];
    const snapshot = await loadRipple(["crus", "CRUS", "QRVO"], {
      supplyChain: async (symbol) => chain(symbol, symbol === "CRUS" ? ["AAPL", "SMALL"] : ["AAPL"]),
      calendar: async (query) => {
        queries.push(query);
        return { asOf: "2026-11-01", from: query.from, to: query.to, reports: reports.filter((row) => query.symbols?.includes(row.symbol)) };
      },
    }, new Date("2026-11-02T04:30:00Z")); // Still Nov 1 in New York, after the fall DST change.
    expect(queries).toEqual([{ from: "2026-11-01", to: "2026-12-01", perDay: 0, symbols: ["AAPL", "CRUS", "QRVO", "SMALL"] }]);
    expect([snapshot.from, snapshot.to]).toEqual(["2026-11-01", "2026-12-01"]);
    expect(snapshot.rows.map((row) => [row.holding, row.company, row.holdingDate])).toEqual([
      ["CRUS", "AAPL", "2026-11-20"], ["CRUS", "SMALL", "2026-11-20"], ["QRVO", "AAPL", "2026-11-21"],
    ]);
  });

  test("merges symbol chunks and preserves stale status from the later chunk", async () => {
    const customers = Array.from({ length: 250 }, (_, index) => `C${String(index).padStart(3, "0")}`);
    const queries: EarningsCalendarQuery[] = [];
    const staleFlags: boolean[] = [];
    const reports = [...customers.map((symbol) => report(symbol)), report("HOLDING", "2026-11-20")];
    const snapshot = await loadRipple(["HOLDING"], {
      staleFlags,
      supplyChain: async (symbol) => chain(symbol, customers),
      calendar: async (query) => {
        queries.push(query);
        staleFlags.push(queries.length === 2);
        return { asOf: "2026-11-01", from: query.from, to: query.to, reports: reports.filter((row) => query.symbols?.includes(row.symbol)) };
      },
    }, new Date("2026-11-01T12:00:00Z"));
    expect(queries.map((query) => [query.perDay, query.symbols?.length])).toEqual([[0, 200], [0, 51]]);
    expect(queries.flatMap((query) => query.symbols ?? [])).toEqual([...customers, "HOLDING"]);
    expect(snapshot.rows).toHaveLength(250);
    expect(snapshot.rows.find((row) => row.company === "C249")?.holdingDate).toBe("2026-11-20");
    expect(snapshot.stale).toBe(true);
  });

  test("skips the calendar without candidate customers and retains disclosure failures", async () => {
    let calendarCalls = 0;
    const snapshot = await loadRipple(["EMPTY", "FAILED"], {
      supplyChain: async (symbol) => {
        if (symbol === "FAILED") throw new Error("disclosures unavailable");
        return chain(symbol, []);
      },
      calendar: async (query) => {
        calendarCalls++;
        return { asOf: "2026-11-01", from: query.from, to: query.to, reports: [] };
      },
    });
    expect(calendarCalls).toBe(0);
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.failures).toEqual([{ symbol: "FAILED", error: "disclosures unavailable" }]);
  });
  test("asks the calendar for suppliers too, keeps both links, and names the holdings the preview cut", async () => {
    const queries: EarningsCalendarQuery[] = [];
    const reports = [report("AAPL", "2026-10-29"), report("CRUS", "2026-11-03")];
    const snapshot = await loadRipple(["AAPL", "CRUS"], {
      // CRUS names AAPL as a customer; AAPL's names view carries CRUS as its supplier.
      supplyChain: async (symbol) => symbol === "CRUS" ? chain("CRUS", ["AAPL"]) : chain("AAPL", [], ["CRUS"], true),
      calendar: async (query) => {
        queries.push(query);
        return { asOf: "2026-10-05", from: query.from, to: query.to, reports: reports.filter((row) => query.symbols?.includes(row.symbol)) };
      },
    }, new Date("2026-10-05T12:00:00Z"));
    expect(queries.map((query) => query.symbols)).toEqual([["AAPL", "CRUS"]]);
    expect(snapshot.rows.map((row) => [row.holding, row.link, row.company])).toEqual([["CRUS", "customer", "AAPL"], ["AAPL", "supplier", "CRUS"]]);
    expect(snapshot.truncated).toEqual(["AAPL"]);
  });
  test("two hops ask the graph once per holding, with filing, announcement and call evidence on supplier and customer links only", async () => {
    const queries: EarningsCalendarQuery[] = [];
    const graphCalls: [string, GraphOptions][] = [];
    const snapshot = await loadRipple(["NVDA"], {
      supplyChain: async (symbol) => chain(symbol, ["MSFT"]),
      calendar: calendarOf([report("MSFT"), report("ASML", "2026-11-10"), report("NVDA", "2026-11-19")], queries),
      graph: async (symbol, options) => { graphCalls.push([symbol, options]); return graph(symbol, "ASML"); },
    }, NOW, { secondHop: true });
    expect(graphCalls).toEqual([["NVDA", { depth: 2, direction: "both", roles: ["customer", "supplier"], sources: [], tiers: ["structured", "primary"],
      minPct: 0, minConfidence: 0, limit: 50, ranking: "score" }]]);
    // Hop 2 joins hop 1 and the holdings in one calendar request.
    expect(queries.map((query) => query.symbols)).toEqual([["ASML", "MSFT", "NVDA"]]);
    expect(snapshot.rows.map((row) => row.company)).toEqual(["MSFT"]);
    expect(snapshot.secondHop?.rows.map((row) => [row.company, row.via, row.date, row.holdingDate])).toEqual([["ASML", "Private supplier", "2026-11-10", "2026-11-19"]]);
  });

  test("a one-hop account makes at most one graph request and keeps its one-hop rows", async () => {
    const holdings = ["CRUS", "QRVO", "SWKS"];
    const sources = { supplyChain: async (symbol: string) => chain(symbol, ["AAPL"]), calendar: calendarOf([report("AAPL"), report("X")]) };
    const direct = await loadRipple(holdings, sources, NOW);
    // The pane builds a free account's sources without a graph at all.
    expect("graph" in cachedRippleSources("anonymous:preview", false, "off")).toBe(false);
    const free = await loadRipple(holdings, sources, NOW, { secondHop: true });
    expect([free.rows, free.secondHop]).toEqual([direct.rows, { rows: [], failures: [], truncated: [], locked: true }]);

    const graphCalls: string[] = [];
    const preview = await loadRipple(holdings, { ...sources, graph: async (symbol) => {
      graphCalls.push(symbol);
      return graph(symbol, "X", { access: "preview", maxDepth: 1 });
    } }, NOW, { secondHop: true });
    expect(graphCalls).toEqual(["CRUS"]);
    expect([preview.rows, preview.secondHop]).toEqual([direct.rows, { rows: [], failures: [], truncated: [], locked: true }]);
  });

  test("a failed or capped graph is reported for its holding while the others still project", async () => {
    const snapshot = await loadRipple(["AAPL", "MSFT", "NVDA"], {
      supplyChain: async (symbol) => chain(symbol, []),
      calendar: calendarOf([report("ASML"), report("AMAT")]),
      graph: async (symbol) => {
        if (symbol === "AAPL") throw new Error("Supply chain graph is not available yet.");
        return symbol === "MSFT" ? graph(symbol, "AMAT", { truncated: true, search: { complete: false, reasons: ["node_limit"], exploredStates: 9, maxStates: 50_000 } })
          : graph(symbol, "ASML");
      },
    }, NOW, { secondHop: true });
    expect(snapshot.secondHop?.failures).toEqual([{ symbol: "AAPL", error: "Supply chain graph is not available yet." }]);
    expect(snapshot.secondHop?.truncated).toEqual([{ symbol: "MSFT", reasons: ["node_limit"] }]);
    expect(snapshot.secondHop?.locked).toBe(false);
    expect(snapshot.secondHop?.rows.map((row) => [row.holding, row.company])).toEqual([["MSFT", "AMAT"], ["NVDA", "ASML"]]);
  });
  test("a 2 hops row opens SPLC Path from the holding to the company, on RIPL's query in the row's direction", async () => {
    const template = supplyChainModule.paneTemplates!.find((entry) => entry.id === "supply-chain-pane")!;
    const context = { activeTicker: null } as unknown as PaneTemplateContext;
    const route = await template.createInstance!(context, { symbol: "NVDA", values: rippleRouteSettings({ company: "ASML", link: "supplier" }) });
    expect(route).toMatchObject({ binding: { kind: "fixed", symbol: "NVDA" }, settings: { tab: "path", to: "ASML" } });
    expect(graphOptions(route!.settings!)).toEqual({ ...DEFAULT_GRAPH_OPTIONS, depth: 2, direction: "upstream", roles: ["customer", "supplier"], tiers: ["structured", "primary"] });
    // Its own pane, so the holding's SPLC keeps the view it was on.
    expect(route!.instanceId).not.toBe((await template.createInstance!(context, { symbol: "NVDA" }))!.instanceId);
  });
});
