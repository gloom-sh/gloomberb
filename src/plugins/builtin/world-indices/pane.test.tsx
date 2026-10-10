import { describe, expect, test } from "bun:test";
import { act, useMemo, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import type { QuoteBatchResult } from "../../../types/data-provider";
import { worldIndicesModule } from "./index";
import { Box } from "../../../ui";
import { PaneFooterProvider, PaneFooterBar } from "../../../components/layout/pane/footer";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createTestDataProvider } from "../../../test-support/data-provider";

const WorldIndicesPane = worldIndicesModule.panes![0]!.component as (props: {
  paneId: string;
  paneType: string;
  focused: boolean;
  width: number;
  height: number;
}) => React.ReactNode;

const PRICES: Record<string, number> = { "^GSPC": 6_812.44, "^FTSE": 9_431.2 };

/**
 * Provider identity is what the board's poll effect keys on, so swapping in a
 * failing provider is how a test drives a second load without a 60s wait.
 */
function makeProvider(mode: "ok" | "fail") {
  return {
    getQuotesBatch: async (targets: Array<{ symbol: string }>): Promise<QuoteBatchResult[]> => (
      targets.map((target) => ({
        target: { symbol: target.symbol, exchange: "" },
        quote: mode === "fail" ? null : {
          symbol: target.symbol,
          price: PRICES[target.symbol] ?? 1_000,
          change: 12.5,
          changePercent: 0.42,
          currency: "USD",
          marketState: "REGULAR" as const,
          lastUpdated: Date.now(),
        },
        error: mode === "fail" ? new Error("upstream 503") : undefined,
      })) as QuoteBatchResult[]
    ),
  };
}

let breakProvider: () => void = () => {};

function Harness() {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-wei-pane-test"));
  const [mode, setMode] = useState<"ok" | "fail">("ok");
  breakProvider = () => setMode("fail");
  const runtime = useMemo(() => {
    const provider = createTestDataProvider(makeProvider(mode));
    return createTestPluginRuntime({ getMarketData: () => provider });
  }, [mode]);

  return (
    <TestPaneProvider state={state} paneId="world-indices" runtime={runtime} pluginId="market-overview">
      <WorldIndicesPane
        paneId="world-indices"
        paneType="world-indices"
        focused
        width={80}
        height={24}
      />
    </TestPaneProvider>
  );
}

const tui = createOpenTuiTestHarness();

async function settle() {
  await act(async () => {
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });
}

describe("WorldIndicesPane", () => {
  test("keeps the last good prices when the provider starts failing", async () => {
    await tui.render(<Harness />, { width: 80, height: 24 });
    await settle();
    expect(tui.frame()).toContain("6,812.44");
    // Index levels are points, not money.
    expect(tui.frame()).not.toContain("$6,812.44");

    await act(async () => {
      breakProvider();
    });
    await settle();

    // Regression: a failed load blanked every price to "—" mid-session.
    const frame = tui.frame();
    expect(frame).toContain("6,812.44");
    expect(frame).toContain("SPX");
  });
});

// Saved selections share one live pane, so removed regions must leave no status behind.
test.each([80, 120])("saved index selection prunes unavailable counts and source times at %i cells", async (width) => {
  const times = { "^GSPC": Date.parse("2026-09-11T20:46:00Z"), "^FTSE": Date.parse("2026-09-11T15:35:00Z") };
  let selectSymbols!: (symbols: string[]) => void;
  const provider = createTestDataProvider({ getQuotesBatch: async (targets: Array<{ symbol: string }>): Promise<QuoteBatchResult[]> => targets.map((target) => ({
    target, quote: target.symbol === "DX-Y.NYB" ? null : {
      symbol: target.symbol, price: PRICES[target.symbol]!, change: 12.5, changePercent: 0.42,
      currency: "USD", marketState: "CLOSED" as const, lastUpdated: times[target.symbol as keyof typeof times],
    },
  })) });
  const runtime = createTestPluginRuntime({ getMarketData: () => provider });
  function SelectionHarness() {
    const [symbols, setSymbols] = useState(["^GSPC", "^FTSE", "DX-Y.NYB"]);
    selectSymbols = setSymbols;
    const config = createTestPaneConfig("/tmp/gloomberb-wei-selection-test", {
      paneId: "world-indices", instanceId: "world-indices", settings: { symbols },
    });
    const state = createInitialState(config);
    return <TestPaneProvider state={state} paneId="world-indices" runtime={runtime} pluginId="market-overview">
      <PaneFooterProvider>{(footer) => <Box width={width} height={24} flexDirection="column">
        <Box width={width} height={23}><WorldIndicesPane paneId="world-indices" paneType="world-indices" focused width={width} height={23} /></Box>
        <PaneFooterBar footer={footer} focused width={width} />
      </Box>}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<SelectionHarness />, { width, height: 24 }); });
  await settle();
  const formatTime = (value: number) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  expect(tui.frame()).toContain("1 unavailable");
  expect(tui.frame()).toContain(formatTime(times["^GSPC"]));
  await act(async () => selectSymbols(["^FTSE"]));
  await settle();
  const frame = tui.frame();
  expect(frame).toContain("FTSE");
  expect(frame).not.toContain("DXY");
  expect(frame).not.toContain("unavailable");
  expect(frame).toContain(formatTime(times["^FTSE"]));
  expect(frame).not.toContain(formatTime(times["^GSPC"]));
});

test.each([
  ["No quote provider available for DX-Y.NYB", true],
  ["request timed out", false],
])("a row with no quote because %j says why only when the feed lacks the index", async (failure, feedGap) => {
  const provider = createTestDataProvider({ getQuotesBatch: async (targets: Array<{ symbol: string }>): Promise<QuoteBatchResult[]> => targets.map((target) => ({
    target, quote: target.symbol === "DX-Y.NYB" ? null : {
      symbol: target.symbol, price: PRICES[target.symbol]!, change: 12.5, changePercent: 0.42,
      currency: "USD", marketState: "CLOSED" as const, lastUpdated: Date.parse("2026-09-11T20:46:00Z"),
    },
    ...(target.symbol === "DX-Y.NYB" ? { error: new Error(failure) } : {}),
  })) });
  const runtime = createTestPluginRuntime({ getMarketData: () => provider });
  function GapHarness() {
    const config = createTestPaneConfig("/tmp/gloomberb-wei-gap-test", {
      paneId: "world-indices", instanceId: "world-indices", settings: { symbols: ["^GSPC", "^FTSE", "DX-Y.NYB"] },
    });
    return <TestPaneProvider state={createInitialState(config)} paneId="world-indices" runtime={runtime} pluginId="market-overview">
      <WorldIndicesPane paneId="world-indices" paneType="world-indices" focused width={120} height={24} />
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<GapHarness />, { width: 120, height: 24 }); });
  await settle();
  const row = tui.frame().split("\n").find((line) => line.includes("DXY")) ?? "";
  expect(row.includes("not available from the feed · US Dollar Index")).toBe(feedGap);
  // The figures are blank, not a run of dashes, once the row says why.
  if (feedGap) expect(row).not.toMatch(/[\u2014-]/);
});
