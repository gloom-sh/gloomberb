import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import {
  MarketDataCoordinator,
  setSharedMarketDataCoordinator,
} from "../../../market-data/coordinator";
import type { QueryEntry } from "../../../market-data/result-types";
import { AppContext, createInitialState, PaneInstanceProvider } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../../runtime";
import { fxMatrixModule } from "./index";

const FxMatrixPane = fxMatrixModule.panes![0]!.component as (props: {
  paneId: string;
  paneType: string;
  focused: boolean;
  width: number;
  height: number;
}) => React.ReactNode;

function readyEntry(rate: number): QueryEntry<number> {
  return {
    phase: "ready",
    data: rate,
    lastGoodData: rate,
    source: "test",
    fetchedAt: 1,
    staleAt: null,
    error: null,
    attempts: [],
  };
}

function errorEntry(): QueryEntry<number> {
  return {
    phase: "error",
    data: null,
    lastGoodData: null,
    source: "test",
    fetchedAt: null,
    staleAt: null,
    error: { reasonCode: "upstream", message: "no rate" },
    attempts: [],
  };
}

/** Every currency resolves except JPY, which has no rate at all. */
const RATES: Record<string, number> = { EUR: 1.08, GBP: 1.27, CHF: 1.12, CAD: 0.73, AUD: 0.65, NZD: 0.6 };

function installCoordinator(): void {
  setSharedMarketDataCoordinator({
    subscribe: () => () => {},
    subscribeKeys: () => () => {},
    getVersion: () => 1,
    getFxEntry: (currency: string) => (
      RATES[currency] != null ? readyEntry(RATES[currency]!) : errorEntry()
    ),
    loadFxRate: async () => {},
  } as unknown as MarketDataCoordinator);
}

function Harness() {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-fxc-pane-test"));
  const runtime = { getMarketData: () => ({}) } as unknown as PluginRuntimeAccess;

  return (
    <AppContext value={{ state, dispatch: () => {} }}>
      <PluginRenderProvider runtime={runtime} pluginId="market-overview">
        <PaneInstanceProvider paneId="fx-matrix">
          <FxMatrixPane paneId="fx-matrix" paneType="fx-matrix" focused width={100} height={14} />
        </PaneInstanceProvider>
      </PluginRenderProvider>
    </AppContext>
  );
}

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
  setSharedMarketDataCoordinator(null);
});

describe("FxMatrixPane", () => {
  test("renders a missing rate as unavailable instead of parity", async () => {
    installCoordinator();
    testSetup = await testRender(<Harness />, { width: 100, height: 14 });
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    // EUR/USD is a real cross built from the two USD legs.
    expect(frame).toContain("1.0800");

    // Regression: a currency with no rate rendered 1.0000 against everything.
    const jpyRow = frame.split("\n").find((line) => line.trimStart().startsWith("JPY"));
    expect(jpyRow).toBeDefined();
    expect(jpyRow).not.toContain("1.0000");
    expect(jpyRow).toContain("—");
  });
});
