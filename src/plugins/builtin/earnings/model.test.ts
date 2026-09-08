import { describe, expect, test } from "bun:test";
import type { TickerRecord } from "../../../types/ticker";
import type { PaneTemplateContext } from "../../../types/plugin";
import { earningsModule } from "./index";
import {
  groupEarningsByRelativeDate,
  resolveEarningsCollectionId,
  scopedSymbolsFromSettings,
  trackedEarningsSymbols,
} from "./model";

function ticker(
  symbol: string,
  portfolios: string[] = [],
  watchlists: string[] = [],
): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "",
      currency: "USD",
      name: symbol,
      portfolios,
      watchlists,
      positions: [],
      custom: {},
      tags: [],
    },
  };
}

describe("ERN pane scope", () => {
  /**
   * The shortcut takes tickers, but the template used to drop them and follow
   * the active collection instead, so `ERN NKE` opened a pane that reported no
   * tickers in scope while the same argument produced a report.
   */
  test("scopes the pane to the tickers the shortcut was given", async () => {
    const template = earningsModule.paneTemplates?.find(
      (candidate) => candidate.id === "earnings-calendar-pane",
    );
    const context = { activeCollectionId: "main" } as unknown as PaneTemplateContext;

    const scoped = await template?.createInstance?.(context, { arg: "nke, msft" });
    expect(scopedSymbolsFromSettings(scoped?.settings)).toEqual(["NKE", "MSFT"]);

    const unscoped = await template?.createInstance?.(context, undefined);
    expect(scopedSymbolsFromSettings(unscoped?.settings)).toEqual([]);
    expect(unscoped?.settings?.collectionId).toBe("main");
  });
});

describe("trackedEarningsSymbols", () => {
  test("gives settings-less legacy panes one stable collection scope", () => {
    expect(resolveEarningsCollectionId(undefined, "main")).toBe("main");
    expect(resolveEarningsCollectionId({ collectionId: " watchlist " }, "main")).toBe("watchlist");
    expect(resolveEarningsCollectionId({ collectionId: "" }, "main")).toBe("main");
  });

  test("excludes incidental cached tickers when no collection is focused", () => {
    const tickers = [
      ticker("CACHE"),
      ticker("AAPL", ["main"]),
      ticker("MSFT", [], ["watchlist"]),
      ticker(" aapl ", ["main"], ["watchlist"]),
    ];

    expect(trackedEarningsSymbols(tickers, null)).toEqual(["AAPL", "MSFT"]);
  });

  test("limits symbols to the focused collection when available", () => {
    const tickers = [
      ticker("AAPL", ["main"]),
      ticker("MSFT", ["broker"]),
      ticker("NVDA", [], ["main"]),
    ];

    expect(trackedEarningsSymbols(tickers, "main")).toEqual(["AAPL", "NVDA"]);
  });
});

describe("groupEarningsByRelativeDate", () => {
  test("groups date-only UTC midnight earnings on the UTC calendar day", () => {
    const rows = groupEarningsByRelativeDate([
      {
        symbol: "AAPL",
        name: "Apple",
        earningsDate: new Date("2026-05-13T00:00:00.000Z"),
        epsActual: null,
        revenueActual: null,
        surprise: null,
      },
    ], new Date("2026-05-13T21:00:00.000Z"));

    expect(rows[0]).toMatchObject({ kind: "separator", label: "TODAY (1)" });
    expect(rows[1]).toMatchObject({ kind: "event", event: expect.objectContaining({ symbol: "AAPL" }) });
  });
});
