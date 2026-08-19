import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import {
  hydrateFredSeries,
  resetFredSeriesPersistence,
  type FredSeriesCacheEntry,
} from "../../../data/fred-series";
import { testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import { VolatilityPane } from "./index";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;

function entry(id: string, title: string, values: number[]): FredSeriesCacheEntry {
  return {
    fetchedAt: Date.now(),
    stale: false,
    data: {
      observations: values.map((value, index) => ({
        date: `2026-08-${String(14 + index).padStart(2, "0")}`,
        value,
      })),
      info: {
        id,
        title,
        units: "Index",
        frequency: "Daily, Close",
        seasonalAdjustment: "Not Seasonally Adjusted",
        source: "",
        notes: "",
      },
    },
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await setup!.renderOnce();
    await setup!.renderOnce();
  });
}

beforeEach(() => {
  resetFredSeriesPersistence();
  hydrateFredSeries([
    ["VIXCLS", entry("VIXCLS", "CBOE Volatility Index: VIX", [15, 16])],
    ["VXVCLS", entry("VXVCLS", "CBOE S&P 500 3-Month Volatility Index", [18, 19])],
  ]);
});

afterEach(async () => {
  if (setup) {
    await act(async () => setup?.renderer.destroy());
    setup = undefined;
  }
  resetFredSeriesPersistence();
});

describe("VolatilityPane", () => {
  test("selects volatility tenors with keyboard", async () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-volatility-test"));
    setup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <PaneFooterProvider>
          {() => <VolatilityPane paneId="volatility:test" paneType="volatility-term-structure" focused width={76} height={23} />}
        </PaneFooterProvider>
      </AppContext>,
      { width: 76, height: 23 },
    );
    await settle();

    let frame = setup.captureCharFrame();
    expect(frame).toMatch(/▸\s+VIX\s+16\.00/);
    expect(frame).toContain("3M/30D");
    expect(frame).toContain("3M premium +3.00 pts");
    expect(frame).not.toContain("contango");

    // Emitting the key directly, then flushing more than one frame: a single
    // render can capture the pre-selection frame when the suite runs loaded.
    await act(async () => {
      setup!.renderer.keyInput.emit("keypress", {
        name: "right",
        sequence: "\u001B[C",
        ctrl: false,
        meta: false,
        option: false,
        shift: false,
        eventType: "press",
        repeated: false,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as never);
      await setup!.renderOnce();
      await setup!.renderOnce();
    });
    await act(async () => { await setup!.renderOnce(); });
    frame = setup.captureCharFrame();
    expect(frame).toMatch(/▸\s+VIX 3M\s+19\.00/);

    expect(frame).toContain("CBOE S&P 500 3-Month Volatility Index");
  });
});
