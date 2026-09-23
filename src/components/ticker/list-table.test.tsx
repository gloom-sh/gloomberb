import { afterEach, describe, expect, test } from "bun:test";
import { act, useEffect, useRef, useState, type ReactNode } from "react";
import { emitKeypress, testRender } from "../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../state/app/context";
import { createDefaultConfig } from "../../types/config";
import type { ColumnConfig } from "../../types/config";
import type { TickerFinancials } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
import type { ScrollBoxRenderable } from "../../ui";
import { PaneFooterProvider, type CombinedPaneFooter } from "../layout/pane/footer";
import { TickerListTableView, type TickerTableCell } from "./list-table-view";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let setHarnessTickers: ((tickers: TickerRecord[]) => void) | null = null;
let tableScrollRef: ScrollBoxRenderable | null = null;
let resolveCellCallCount = 0;

const columns: ColumnConfig[] = [
  { id: "ticker", label: "Ticker", width: 6, align: "left" },
];
const financialsMap = new Map<string, TickerFinancials>();
const manyTickers: TickerRecord[] = Array.from({ length: 1000 }, (_, index) => ({
  metadata: {
    ticker: `T${index}`,
    exchange: "NASDAQ",
    currency: "USD",
    name: `Ticker ${index}`,
    portfolios: [],
    watchlists: [],
    positions: [],
    custom: {},
    tags: [],
  },
}));

function resolveCell(_column: ColumnConfig, ticker: TickerRecord, _financials: TickerFinancials | undefined): TickerTableCell {
  resolveCellCallCount += 1;
  return { text: ticker.metadata.ticker };
}

const testDispatch = () => {};

function TickerTableTestProviders({ children }: { children: ReactNode }) {
  // A stable store like the app's, so row memoization is what the tests see.
  const [value] = useState(() => ({
    state: createInitialState(createDefaultConfig("/tmp/gloomberb-ticker-table-test")),
    dispatch: testDispatch,
  }));
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

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
  resolveCellCallCount = 0;
  setHarnessTickers = null;
  setTickingFinancials = null;
  tableScrollRef = null;
});

describe("TickerListTableView", () => {
  test("renders a bounded window for large ticker lists", async () => {
    testSetup = await testRender(
      <LargeTickerListTableHarness />,
      { width: 20, height: 6 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("T0");
    expect(frame).not.toContain("T999");
    expect(resolveCellCallCount).toBeLessThan(100);

    await act(async () => {
      for (let index = 0; index < 12; index++) {
        await testSetup!.mockMouse.scroll(2, 2, "down");
      }
      await Promise.resolve();
      await testSetup!.renderOnce();
    });

    const scrollTop = tableScrollRef?.scrollTop ?? 0;
    expect(scrollTop).toBeGreaterThan(0);
    expect(testSetup.captureCharFrame()).toContain(`T${scrollTop}`);
  });

  test("a quote tick on one symbol redraws only that symbol's row", async () => {
    testSetup = await testRender(<TickingTickerListTableHarness />, { width: 40, height: 24 });
    await act(async () => {
      await testSetup!.renderOnce();
    });
    expect(testSetup.captureCharFrame()).toContain("T19");

    resolveCellCallCount = 0;
    await act(async () => {
      const next = new Map(TICKING_SYMBOLS.map((ticker, index) => [
        ticker.metadata.ticker, tickingFinancials(ticker.metadata.ticker, 100 + index),
      ]));
      setTickingFinancials?.(next);
      await testSetup!.renderOnce();
    });
    // Every row got new records: all visible cells resolve again.
    expect(resolveCellCallCount).toBe(20 * tickingColumns.length);

    resolveCellCallCount = 0;
    await act(async () => {
      setTickingFinancials?.((current: Map<string, TickerFinancials>) => new Map(current).set("T7", tickingFinancials("T7", 250)) as never);
      await testSetup!.renderOnce();
    });
    expect(resolveCellCallCount).toBe(tickingColumns.length);
  });

  test("preserves manual scroll when market data reorders rows around the same cursor", async () => {
    testSetup = await testRender(
      <ReorderingTickerListTableViewHarness />,
      { width: 20, height: 8 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    tableScrollRef!.scrollTop = 20;
    expect(tableScrollRef?.scrollTop).toBe(20);

    await act(async () => {
      setHarnessTickers?.([...manyTickers.slice(1), manyTickers[0]!]);
      await Promise.resolve();
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
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
    testSetup = await testRender(<Harness />, { width: 20, height: 8 });
    await act(async () => { await testSetup!.renderOnce(); });
    expect(labels()).toContain("Open T0 Ticker Research");

    await emitKeypress(testSetup, { name: "j" });
    await act(async () => { await testSetup!.renderOnce(); });
    expect(labels()).toContain("Open T1 Ticker Research");
    expect(labels()).not.toContain("Open T0 Ticker Research");

    await act(async () => { setFocused(false); await testSetup!.renderOnce(); });
    expect(labels()).not.toContain("Open T1 Ticker Research");
  });
});
