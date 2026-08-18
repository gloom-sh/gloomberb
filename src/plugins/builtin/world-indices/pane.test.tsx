import { afterEach, describe, expect, test } from "bun:test";
import { act, useMemo, useState } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState, PaneInstanceProvider } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import type { QuoteBatchResult } from "../../../types/data-provider";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../../runtime";
import { worldIndicesModule } from "./index";

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
    <AppContext value={{ state, dispatch: () => {} }}>
      <PluginRenderProvider runtime={runtime} pluginId="market-overview">
        <PaneInstanceProvider paneId="world-indices">
          <WorldIndicesPane
            paneId="world-indices"
            paneType="world-indices"
            focused
            width={80}
            height={24}
          />
        </PaneInstanceProvider>
      </PluginRenderProvider>
    </AppContext>
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
