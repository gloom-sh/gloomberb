import { expect, test } from "bun:test";
import type { HeadlessBundleResult, HeadlessPaneContext } from "../../../types/headless";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { timeSalesHeadless } from "./headless";
import { tapeFixture } from "./test-fixture";

async function report(symbol: string, exchange?: string) {
  const asked: string[] = [];
  const context = createTestHeadlessContext({
    settings: { tab: "quotes" },
    resolveInstrument: async () => ({ symbol, exchange }),
    apiClient: {
      getCloudTape: async (tapeSymbol: string, tapeExchange: string) => {
        asked.push(tapeSymbol);
        return { ...tapeFixture(), symbol: tapeSymbol, exchange: tapeExchange };
      },
    } as unknown as HeadlessPaneContext["apiClient"],
  });
  const result = await timeSalesHeadless.load(createTestHeadlessArgs({ argument: symbol, symbols: [symbol] }), context) as HeadlessBundleResult;
  return { result, asked };
}

test("QR on a listing abroad says where the finest bars are instead of loading an empty tape", async () => {
  // The suffix names the ASX; a saved exchange abroad reads the same.
  for (const [symbol, exchange] of [["RMS.AX", undefined], ["7203", "JPX"]] as const) {
    const { result, asked } = await report(symbol, exchange);
    expect(asked).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.sections).toEqual([{ title: "NBBO", rows: [],
      empty: `No second or tick bars; 1-minute bars: fn GIP ${symbol}; trades exist for US listings only.` }]);
  }
  // A US listing loads its tape and keeps the source's own gaps.
  const us = await report("AAPL");
  expect(us.asked).toEqual(["AAPL"]);
  expect(us.result.errors).toEqual(["Observed window only"]);
  expect(us.result.sections.map(({ title }) => title)).toEqual(["Observed window", "Regular session", "Trades", "NBBO"]);
});
