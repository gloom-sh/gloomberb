import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { KellySizerHarness, createFinancials, createSizerConfig, createTicker } from "./test-support";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

async function renderPane(props?: Parameters<typeof KellySizerHarness>[0]) {
  await act(async () => {
    testSetup = await testRender(<KellySizerHarness {...props} />, { width: 100, height: 30 });
    await Promise.resolve();
    await testSetup.renderOnce();
  });
}

async function flushFrame() {
  await act(async () => {
    await testSetup!.renderOnce();
  });
}

beforeEach(() => {
  setSharedMarketDataCoordinator(null);
});

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
  setSharedMarketDataCoordinator(null);
});

describe("KellySizerPane", () => {
  test("prefills shared caps from plugin config", async () => {
    const config = {
      ...createSizerConfig(),
      pluginConfig: {
        portfolio: {
          "commonAssumptions:v1": {
            kellyFraction: 0.5,
            maxLossFraction: 0.02,
            maxNameFraction: 0.1,
          },
        },
      },
    };

    await renderPane({ config, paneState: { mode: "scenario" } });
    await flushFrame();

    const frame = testSetup!.captureCharFrame();
    expect(frame).toContain("Scenario");
    expect(frame).toMatch(/Kelly\s+50\.0\s+%/);
    expect(frame).toMatch(/Loss cap\s+2\.00\s+%/);
    expect(frame).toMatch(/Name cap\s+10\.0\s+%/);
  });

  test("keeps shared caps scoped to pane state after seeding", async () => {
    const config = {
      ...createSizerConfig(),
      pluginConfig: {
        portfolio: {
          "commonAssumptions:v1": {
            kellyFraction: 0.5,
            maxLossFraction: 0.02,
            maxNameFraction: 0.1,
          },
        },
      },
    };

    await renderPane({
      config,
      paneState: {
        mode: "scenario",
        "commonAssumptions:v1": {
          kellyFraction: 0.3,
          maxLossFraction: 0.015,
          maxNameFraction: 0.07,
        },
      },
    });
    await flushFrame();

    const frame = testSetup!.captureCharFrame();
    expect(frame).toContain("Scenario");
    expect(frame).toMatch(/Kelly\s+30\.0\s+%/);
    expect(frame).toMatch(/Loss cap\s+1\.50\s+%/);
    expect(frame).toMatch(/Name cap\s+7\.00\s+%/);
    expect(frame).not.toMatch(/Kelly\s+50\.0\s+%/);
  });

  test("converts foreign quote current value to base currency", async () => {
    const ticker = createTicker({
      symbol: "SIVE",
      currency: "SEK",
      positions: [{
        portfolio: "main",
        shares: 100,
        avgCost: 50,
        currency: "SEK",
        broker: "ibkr",
        brokerInstanceId: "ibkr-flex",
        brokerAccountId: "DU12345",
        marketValue: 10_000,
        unrealizedPnl: 5_000,
      }],
    });
    const financials = createFinancials({ symbol: "SIVE", price: 100, currency: "SEK" });

    await renderPane({
      config: createSizerConfig("SIVE"),
      ticker,
      financials,
      exchangeRates: new Map([["USD", 1], ["SEK", 0.1]]),
    });
    await flushFrame();

    const frame = testSetup!.captureCharFrame();
    expect(frame).toContain("SIVE");
    expect(frame).toContain("Main Portfolio");
    expect(frame).toMatch(/Current\s+1000\s+USD/);
    expect(frame).not.toMatch(/Current\s+10000\s+USD/);
  });

  test("toggles sensitivity with s", async () => {
    await renderPane();
    await flushFrame();

    await act(async () => {
      (testSetup!.renderer.keyInput as any).emit("keypress", {
        name: "s",
        sequence: "s",
        ctrl: false,
        meta: false,
        shift: false,
      });
      await testSetup!.renderOnce();
    });
    await flushFrame();

    const frame = testSetup!.captureCharFrame();
    expect(frame).toContain("SENSITIVITY");
    expect(frame).toContain("Win p");
    expect(frame).toContain("Upside");
    expect(frame).not.toContain("Kelly Curve");
  });

  test("focuses ticker search with slash", async () => {
    await renderPane();
    await flushFrame();

    await act(async () => {
      (testSetup!.renderer.keyInput as any).emit("keypress", {
        name: "/",
        sequence: "/",
        ctrl: false,
        meta: false,
        shift: false,
      });
      await testSetup!.renderOnce();
    });
    await flushFrame();

    const frame = testSetup!.captureCharFrame();
    expect(frame).toContain("/ AAPL");
  });
});
