import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../../renderers/opentui/test-utils";
import { instrumentFromTicker } from "../../market-data/request-types";
import { buildQuoteKey } from "../../market-data/selectors";
import { instrumentIdentityKey } from "../../utils/instrument-identity";
import type { TickerRecord } from "../../types/ticker";
import { buildLiveQuoteTarget, useSampledValue } from "./live-ticker-financials";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
  }
  testSetup = undefined;
});

function brokerHeldTicker(): TickerRecord {
  return {
    metadata: {
      ticker: "AAPL",
      exchange: "NASDAQ",
      currency: "USD",
      name: "Apple",
      portfolios: ["ibkr-main"],
      watchlists: [],
      positions: [{
        portfolio: "ibkr-main",
        shares: 10,
        broker: "ibkr",
        brokerInstanceId: "ibkr-work",
        brokerContractId: 265598,
      }],
      broker_contracts: [{
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-work",
        conId: 265598,
        symbol: "AAPL",
        secType: "STK",
        exchange: "SMART",
        currency: "USD",
      }],
      custom: {},
      tags: [],
    },
  };
}

describe("buildLiveQuoteTarget", () => {
  test("streams a broker-held position on the key its portfolio reads", () => {
    const ticker = brokerHeldTicker();
    const instrumentOptions = { portfolioId: "ibkr-main" };
    const target = buildLiveQuoteTarget("AAPL", ticker, {
      surface: "portfolio",
      visible: false,
      weight: 20,
      instrumentOptions,
    })!;
    const read = instrumentFromTicker(ticker, "AAPL", instrumentOptions)!;

    // Same route as the portfolio pane, so the two subscriptions merge.
    expect(target.route).toBe("broker");
    expect(buildQuoteKey({
      symbol: target.symbol,
      exchange: target.exchange,
      brokerId: target.context?.brokerId,
      brokerInstanceId: target.context?.brokerInstanceId,
      instrument: target.context?.instrument ?? null,
    })).toBe(buildQuoteKey(read));
    // Outside the portfolio the same ticker is a plain listing.
    const listing = buildLiveQuoteTarget("AAPL", { ...ticker, metadata: { ...ticker.metadata, broker_contracts: [] } })!;
    expect(listing.route).toBe("auto");
    expect(instrumentIdentityKey({ symbol: listing.symbol, exchange: listing.exchange, instrument: null }))
      .not.toBe(instrumentIdentityKey(read));
  });
});

describe("useSampledValue", () => {
  test("passes the first change, collapses a burst into one trailing update, and resets on a new key", async () => {
    let setValue: (value: number) => void = () => {};
    let setScope: (scope: string) => void = () => {};
    function Harness() {
      const [value, updateValue] = useState(0);
      const [scope, updateScope] = useState("a");
      setValue = updateValue;
      setScope = updateScope;
      return <text>{`v${useSampledValue(value, 400, scope)}`}</text>;
    }
    const frame = async (waitMs = 0) => {
      if (waitMs > 0) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        });
      }
      await act(async () => {
        await testSetup!.renderOnce();
      });
      return testSetup!.captureCharFrame();
    };

    await act(async () => {
      testSetup = await testRender(<Harness />, { width: 10, height: 1 });
    });
    expect(await frame()).toContain("v0");

    await act(async () => setValue(1));
    expect(await frame()).toContain("v1");

    await act(async () => setValue(2));
    await act(async () => setValue(3));
    expect(await frame()).toContain("v1");
    expect(await frame(500)).toContain("v3");

    await act(async () => setValue(4));
    await act(async () => setScope("b"));
    expect(await frame()).toContain("v4");
  });
});
