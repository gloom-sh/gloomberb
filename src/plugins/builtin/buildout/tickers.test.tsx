import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { setSharedRegistryForTests, type PluginRegistry } from "../../../plugins/registry";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { resetInlineTickerFailures } from "../../../state/hooks/inline-ticker-failures";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createTestTicker } from "../../../test-support/ticker";
import { createDefaultConfig } from "../../../types/config";
import { Box } from "../../../ui";
import { renderBuildoutCell } from "./cells";
import { listingKey } from "./format";
import type { BuildoutColumn, BuildoutCompany, BuildoutRow } from "./model/types";
import { columnsForTab, rowTickerSymbols } from "./table-model";

const tui = createOpenTuiTestHarness({ width: 40, height: 4 });
afterEach(() => {
  resetInlineTickerFailures();
  setSharedMarketDataCoordinator(null);
  setSharedRegistryForTests(undefined);
});

describe("the key a dataset ticker opens by", () => {
  test("a number-only listing takes the venue the dataset names, and without one reads as no listing", () => {
    expect(listingKey("nvda", "NASDAQ")).toBe("NVDA");
    expect(listingKey("2330", "TWSE")).toBe("2330:TWSE");
    expect(listingKey("005930", "KRX")).toBe("005930:KRX");
    expect(listingKey("688795.SS", "SSE")).toBe("688795:SSE");
    expect(listingKey("981", null)).toBeNull();
    expect(listingKey("2330", "Nowhere Exchange")).toBeNull();
    expect(listingKey("  ", "TWSE")).toBeNull();
  });
});

const column = (id: BuildoutColumn["id"]): BuildoutColumn => ({ id, label: id, width: 13, align: "left" });
const company = (ticker: string, exchange: string | null): BuildoutRow => ({
  kind: "company",
  item: { id: ticker, name: `${ticker} Inc`, ticker, exchange } as BuildoutCompany,
});

describe("the company table's tickers", () => {
  test("every listing the app can open is one chip that opens it, and one it cannot read is plain text, not another chip", async () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-buildout-tickers-test"));
    state.tickers.set("NVDA", createTestTicker("NVDA", "NVIDIA"));
    state.tickers.set("2330:TWSE", createTestTicker("2330", "TSMC", { exchange: "TWSE", currency: "TWD" }));
    for (const [key, currency] of [["NVDA", "USD"], ["2330:TWSE", "TWD"]] as const) {
      state.financials.set(key, { annualStatements: [], quarterlyStatements: [], priceHistory: [],
        quote: { symbol: key, price: 100, currency, change: 1, changePercent: 1, lastUpdated: Date.now() } });
    }
    const opened: string[] = [];
    setSharedRegistryForTests({ pinTicker: (symbol: string) => { opened.push(symbol); } } as unknown as PluginRegistry);
    const rows = [company("NVDA", "NASDAQ"), company("2330", "TWSE"), company("981", null)];
    await act(async () => {
      await tui.render(
        <AppContext value={createStaticAppStore(state)}>
          <Box flexDirection="column">
            {rows.map((row) => (
              <Box key={row.item.id} height={1}>
                {renderBuildoutCell(row, column("ticker"), { selected: false }, { favoriteBusyKey: null, toggleFavorite: () => {} }).content}
              </Box>
            ))}
          </Box>
        </AppContext>,
        { width: 40, height: 4 },
      );
    });
    await act(async () => { await tui.setup().renderOnce(); });
    const lines = tui.frame().split("\n");
    expect(lines[0]).toContain("NVDA");
    // The chip says the number as the dataset writes it and opens the listing.
    expect(lines[1]).toContain("2330 ");
    expect(lines[1]).not.toContain("TWSE");
    expect(lines[2]).toContain("981");

    for (const [y, x] of [[0, 2], [1, 2], [2, 1]] as const) {
      await act(async () => { await tui.setup().mockMouse.click(x, y); await tui.setup().renderOnce(); });
    }
    expect(opened).toEqual(["NVDA", "2330:TWSE"]);
  });

  test("the name is a plain cell, so the table gives it the spare width and the ticker keeps its own column", () => {
    const named = renderBuildoutCell(company("2330", "TWSE"), column("company"), { selected: false }, { favoriteBusyKey: null, toggleFavorite: () => {} });
    expect(named.text).toBe("2330 Inc");
    expect(named.content).toBeUndefined();
    const themes = columnsForTab("themes", null, false, 160);
    expect(themes.slice(0, 2).map((entry) => entry.id)).toEqual(["ticker", "company"]);
    expect(themes.filter((entry) => entry.flexGrow).map((entry) => entry.id)).toEqual(["company"]);
    expect(rowTickerSymbols(company("2330", "TWSE"))).toEqual(["2330:TWSE"]);
  });
});
