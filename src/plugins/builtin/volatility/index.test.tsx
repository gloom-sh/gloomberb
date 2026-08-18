import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import {
  hydrateFredSeries,
  resetFredSeriesPersistence,
  type FredSeriesCacheEntry,
} from "../../../data/fred-series";
import { testRender } from "../../../renderers/opentui/test-utils";
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
    setup = await testRender(
      <PaneFooterProvider>
        {() => <VolatilityPane paneId="volatility:test" paneType="volatility-term-structure" focused width={76} height={23} />}
      </PaneFooterProvider>,
      { width: 76, height: 23 },
    );
    await settle();

    let frame = setup.captureCharFrame();
    expect(frame).toMatch(/▸\s+VIX\s+16\.00/);

    await act(async () => {
      setup!.mockInput.pressArrow("right");
      await setup!.renderOnce();
    });
    frame = setup.captureCharFrame();
    expect(frame).toMatch(/▸\s+VIX 3M\s+19\.00/);

    expect(frame).toContain("CBOE S&P 500 3-Month Volatility Index");
  });
});
