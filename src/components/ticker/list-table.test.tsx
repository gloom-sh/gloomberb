import { afterEach, describe, expect, test } from "bun:test";
import { act, useEffect, useRef, useState, type ReactNode } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createDefaultConfig } from "../../types/config";
import type { ColumnConfig } from "../../types/config";
import type { TickerFinancials } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
import type { ScrollBoxRenderable } from "../../ui";
import { PaneFooterProvider, type CombinedPaneFooter } from "../layout/pane/footer";
import { TickerListTableView, flashesOnQuoteTick, type TickerTableCell } from "./list-table-view";
import { createTestTicker } from "../../test-support/ticker";

const tui = createOpenTuiTestHarness();
let setHarnessTickers: ((tickers: TickerRecord[]) => void) | null = null;
let tableScrollRef: ScrollBoxRenderable | null = null;
let resolveCellCallCount = 0;

const columns: ColumnConfig[] = [
  { id: "ticker", label: "Ticker", width: 6, align: "left" },
];
const financialsMap = new Map<string, TickerFinancials>();
const manyTickers: TickerRecord[] = Array.from({ length: 1000 }, (_, index) => (createTestTicker(`T${index}`, `Ticker ${index}`)));

function resolveCell(_column: ColumnConfig, ticker: TickerRecord, _financials: TickerFinancials | undefined): TickerTableCell {
  resolveCellCallCount += 1;
  return { text: ticker.metadata.ticker };
}

function TickerTableTestProviders({ children }: { children: ReactNode }) {
  // A stable store like the app's, so row memoization is what the tests see.
  const [value] = useState(() => createStaticAppStore(
    createInitialState(createDefaultConfig("/tmp/gloomberb-ticker-table-test")),
  ));
  return (
    <AppContext value={value}>
      <PaneInstanceProvider paneId="ticker-table-test">
        {children}
      </PaneInstanceProvider>
    </AppContext>
  );
}

function LargeTickerListTableHarness() {
  const [cursorSymbol, setCursorSymbol] = useState("T0");
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    tableScrollRef = scrollRef.current;
    return () => {
      if (tableScrollRef === scrollRef.current) {
        tableScrollRef = null;
      }
    };
  });

  return (
    <TickerTableTestProviders>
      <TickerListTableView
        columns={columns}
        tickers={manyTickers}
        cursorSymbol={cursorSymbol}
        setCursorSymbol={setCursorSymbol}
        resolveCell={resolveCell}
        financialsMap={financialsMap}
        scrollRef={scrollRef}
      />
    </TickerTableTestProviders>
  );
}

function ReorderingTickerListTableViewHarness() {
  const [rows, setRows] = useState(manyTickers);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  setHarnessTickers = setRows;

  useEffect(() => {
    tableScrollRef = scrollRef.current;
    return () => {
      if (tableScrollRef === scrollRef.current) {
        tableScrollRef = null;
      }
    };
  });

  return (
    <TickerTableTestProviders>
      <TickerListTableView
        focused
        columns={columns}
        tickers={rows}
        cursorSymbol="T0"
        setCursorSymbol={() => {}}
        resolveCell={resolveCell}
        financialsMap={financialsMap}
        scrollRef={scrollRef}
      />
    </TickerTableTestProviders>
  );
}

const TICKING_SYMBOLS = manyTickers.slice(0, 20);
const tickingColumns: ColumnConfig[] = [
  { id: "ticker", label: "Ticker", width: 6, align: "left" },
  { id: "price", label: "Price", width: 8, align: "right" },
  { id: "change", label: "Chg", width: 8, align: "right" },
];
let setTickingFinancials: ((map: Map<string, TickerFinancials>) => void) | null = null;
const stableSetCursor = () => {};

function tickingFinancials(symbol: string, price: number): TickerFinancials {
  return { annualStatements: [], quarterlyStatements: [], priceHistory: [], quote: { symbol, price } as TickerFinancials["quote"] };
}

function TickingTickerListTableHarness() {
  const [map, setMap] = useState(() => new Map(TICKING_SYMBOLS.map((ticker, index) => [
    ticker.metadata.ticker, tickingFinancials(ticker.metadata.ticker, 100 + index),
  ])));
  setTickingFinancials = setMap;
  return (
    <TickerTableTestProviders>
      <TickerListTableView
        columns={tickingColumns}
        tickers={TICKING_SYMBOLS}
        cursorSymbol="T0"
        setCursorSymbol={stableSetCursor}
        resolveCell={resolveCell}
        financialsMap={map}
      />
    </TickerTableTestProviders>
  );
}

afterEach(() => {
  resolveCellCallCount = 0;
  setHarnessTickers = null;
  setTickingFinancials = null;
  tableScrollRef = null;
});

describe("TickerListTableView", () => {
  test("renders a bounded window for large ticker lists", async () => {
    await tui.render(
      <LargeTickerListTableHarness />,
      { width: 20, height: 6 },
    );

    await act(async () => {
      await tui.setup().renderOnce();
    });

    const frame = tui.frame();
    expect(frame).toContain("T0");
    expect(frame).not.toContain("T999");
    expect(resolveCellCallCount).toBeLessThan(100);

    await act(async () => {
      for (let index = 0; index < 12; index++) {
        await tui.setup().mockMouse.scroll(2, 2, "down");
      }
      await Promise.resolve();
      await tui.setup().renderOnce();
    });

    const scrollTop = tableScrollRef?.scrollTop ?? 0;
    expect(scrollTop).toBeGreaterThan(0);
    expect(tui.frame()).toContain(`T${scrollTop}`);
  });

  test("a quote tick on one symbol redraws only that symbol's row", async () => {
    await tui.render(<TickingTickerListTableHarness />, { width: 40, height: 24 });
    await act(async () => {
      await tui.setup().renderOnce();
    });
    expect(tui.frame()).toContain("T19");

    resolveCellCallCount = 0;
    await act(async () => {
      const next = new Map(TICKING_SYMBOLS.map((ticker, index) => [
        ticker.metadata.ticker, tickingFinancials(ticker.metadata.ticker, 100 + index),
      ]));
      setTickingFinancials?.(next);
      await tui.setup().renderOnce();
    });
    // Every row got new records: all visible cells resolve again.
    expect(resolveCellCallCount).toBe(20 * tickingColumns.length);

    resolveCellCallCount = 0;
    await act(async () => {
      setTickingFinancials?.((current: Map<string, TickerFinancials>) => new Map(current).set("T7", tickingFinancials("T7", 250)) as never);
      await tui.setup().renderOnce();
    });
    expect(resolveCellCallCount).toBe(tickingColumns.length);
  });

  test("preserves manual scroll when market data reorders rows around the same cursor", async () => {
    await tui.render(
      <ReorderingTickerListTableViewHarness />,
      { width: 20, height: 8 },
    );

    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    tableScrollRef!.scrollTop = 20;
    expect(tableScrollRef?.scrollTop).toBe(20);

    await act(async () => {
      setHarnessTickers?.([...manyTickers.slice(1), manyTickers[0]!]);
      await Promise.resolve();
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    expect(tableScrollRef?.scrollTop).toBe(20);
  });

  test("the pane menu offers the cursor row's right-click actions while the table is focused", async () => {
    let footer: CombinedPaneFooter | null = null;
    let setFocused: (focused: boolean) => void = () => {};
    function Harness() {
      const [cursorSymbol, setCursorSymbol] = useState("T0");
      const [focused, updateFocused] = useState(true);
      setFocused = updateFocused;
      return (
        <TickerTableTestProviders>
          <PaneFooterProvider>
            {(current) => {
              footer = current;
              return (
                <TickerListTableView
                  focused={focused}
                  columns={columns}
                  tickers={manyTickers.slice(0, 5)}
                  cursorSymbol={cursorSymbol}
                  setCursorSymbol={setCursorSymbol}
                  resolveCell={resolveCell}
                  financialsMap={financialsMap}
                />
              );
            }}
          </PaneFooterProvider>
        </TickerTableTestProviders>
      );
    }
    const labels = () => footer!.menu.flatMap((item) => (item.type === "divider" ? [] : [item.label]));
    await tui.render(<Harness />, { width: 20, height: 8 });
    await act(async () => { await tui.setup().renderOnce(); });
    expect(labels()).toContain("Open T0 Ticker Research");

    await tui.emitKeypress({ name: "j" });
    await act(async () => { await tui.setup().renderOnce(); });
    expect(labels()).toContain("Open T1 Ticker Research");
    expect(labels()).not.toContain("Open T0 Ticker Research");

    await act(async () => { setFocused(false); await tui.setup().renderOnce(); });
    expect(labels()).not.toContain("Open T1 Ticker Research");
  });
});

describe("flashesOnQuoteTick", () => {
  const quote = (overrides: Partial<TickerFinancials["quote"] & object>) => ({
    symbol: "SPCX", currency: "USD", price: 165.39, change: -2.21, changePercent: -1.32, previousClose: 167.6,
    marketState: "POST", postMarketPrice: 165.39, postMarketChange: 4.82, lastUpdated: Date.parse("2026-10-08T22:22:00Z"),
    ...overrides,
  }) as TickerFinancials["quote"];

  test("after the regular close a tick leaves LAST, CHG and CHG% alone and flashes the columns that moved", () => {
    const afterHours = quote({ regularClose: 160.57, regularCloseSessionDate: "2026-10-08" });
    for (const id of ["price", "change", "change_pct"]) expect(flashesOnQuoteTick(id, afterHours)).toBe(false);
    for (const id of ["ext_hours", "day_pnl", "mkt_value", "bid"]) expect(flashesOnQuoteTick(id, afterHours)).toBe(true);
    // Before a close is known the print is the headline, so it flashes.
    for (const open of [quote({ marketState: "REGULAR" }), quote({ marketState: "POST", postMarketChange: undefined })]) {
      for (const id of ["price", "change", "change_pct"]) expect(flashesOnQuoteTick(id, open)).toBe(true);
    }
  });
});
