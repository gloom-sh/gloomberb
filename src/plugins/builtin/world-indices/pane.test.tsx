import { afterEach, describe, expect, test } from "bun:test";
import { act, useMemo, useState } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import type { QuoteBatchResult } from "../../../types/data-provider";
import type { PluginRuntimeAccess } from "../../runtime";
import { worldIndicesModule } from "./index";
import { Box } from "../../../ui";
import { PaneFooterProvider, PaneFooterBar } from "../../../components/layout/pane/footer";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";

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
    const provider = makeProvider(mode);
    return { getMarketData: () => provider } as unknown as PluginRuntimeAccess;
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

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  if (!testSetup) return;
  await act(async () => {
    testSetup!.renderer.destroy();
  });
  testSetup = undefined;
});

async function settle() {
  await act(async () => {
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
  });
}

describe("WorldIndicesPane", () => {
  test("renders regions and prices from the shared quote board", async () => {
    testSetup = await testRender(<Harness />, { width: 80, height: 24 });
    await settle();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Americas");
    expect(frame).toContain("SPX");
    expect(frame).toContain("6,812.44");
    expect(frame).not.toContain("$6,812.44");
    expect(frame).toContain("+0.42%");
  });

  test("keeps the last good prices when the provider starts failing", async () => {
    testSetup = await testRender(<Harness />, { width: 80, height: 24 });
    await settle();
    expect(testSetup.captureCharFrame()).toContain("6,812.44");

    await act(async () => {
      breakProvider();
    });
    await settle();

    // Regression: a failed load blanked every price to "—" mid-session.
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("6,812.44");
    expect(frame).toContain("SPX");
  });
});

// Saved selections share one live pane, so removed regions must leave no status behind.
test.each([80, 120])("saved index selection prunes unavailable counts and source times at %i cells", async (width) => {
  const times = { "^GSPC": Date.parse("2026-09-11T20:46:00Z"), "^FTSE": Date.parse("2026-09-11T15:35:00Z") };
  let selectSymbols!: (symbols: string[]) => void;
  const provider = { getQuotesBatch: async (targets: Array<{ symbol: string }>) => targets.map((target) => ({
    target, quote: target.symbol === "DX-Y.NYB" ? null : {
      symbol: target.symbol, price: PRICES[target.symbol], change: 12.5, changePercent: 0.42,
      currency: "USD", marketState: "CLOSED", lastUpdated: times[target.symbol as keyof typeof times],
    },
  })) };
  const runtime = { getMarketData: () => provider } as unknown as PluginRuntimeAccess;
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
  await act(async () => { testSetup = await testRender(<SelectionHarness />, { width, height: 24 }); });
  await settle();
  const formatTime = (value: number) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  expect(testSetup!.captureCharFrame()).toContain("1 unavailable");
  expect(testSetup!.captureCharFrame()).toContain(formatTime(times["^GSPC"]));
  await act(async () => selectSymbols(["^FTSE"]));
  await settle();
  const frame = testSetup!.captureCharFrame();
  expect(frame).toContain("FTSE");
  expect(frame).not.toContain("DXY");
  expect(frame).not.toContain("unavailable");
  expect(frame).toContain(formatTime(times["^FTSE"]));
  expect(frame).not.toContain(formatTime(times["^GSPC"]));
});
