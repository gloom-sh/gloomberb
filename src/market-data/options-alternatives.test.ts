import { expect, test } from "bun:test";
import { createTestCliContext } from "../test-support/cli-context";
import { marketDataCliCommands } from "../cli/commands/market";
import { fxVolatilityNote, fxVolatilityPair, listedOptionsAlternative } from "./options-alternatives";

test("every spelling of a futures root finds the same listed fund, and a stock finds none", () => {
  const alternative = (symbol: string) => listedOptionsAlternative(symbol)?.symbol ?? null;
  expect(["GC=F", "gc=f", "GCZ26", "GC1", "GCZ26.CMX"].map(alternative)).toEqual(["GLD", "GLD", "GLD", "GLD", "GLD"]);
  // Month codes that are also letters of a root: NG (G is February), HG (H is March), RTY.
  expect(["NGZ26", "HGH27", "RTYZ26", "CL=F", "SI=F", "NG=F"].map(alternative)).toEqual(["UNG", "CPER", "IWM", "USO", "SLV", "UNG"]);
  expect(["AAPL", "GLD", "MU", "SPY", "ESPR", "7203.T"].map(alternative)).toEqual([null, null, null, null, null, null]);
});

test("options on a future with no chain names the listed alternative and OSA, not the routing error", async () => {
  const cli = createTestCliContext({ dataProvider: {
    getOptionsChain: async (symbol: string) => { throw new Error(`No options provider available for ${symbol}`); },
    getQuote: async () => { throw new Error("offline"); },
  } });
  let failure: { message: string; details?: string } | null = null;
  cli.context.fail = ((message: string, details?: string): never => {
    failure = { message, details };
    throw new Error(message);
  }) as typeof cli.context.fail;
  await expect(marketDataCliCommands.find((command) => command.name === "options")!.execute(["GC=F"], cli.context))
    .rejects.toThrow("Options are not available for GC=F.");
  expect(failure!.details).toContain("gloom options GLD");
  expect(failure!.details).toContain("gloom fn OSA GLD");
  expect(`${failure!.message} ${failure!.details}`).not.toMatch(/provider/i);
});

test("a spot pair in any spelling and a currency future in any contract are one FX pair; a stock, a coin, spot gold and a fund are none", () => {
  const pair = (symbol: string) => fxVolatilityPair(symbol);
  expect(["EURUSD=X", "eur/usd", "JPY=X", "GBPUSD=X"].map(pair)).toEqual(["EURUSD", "EURUSD", "USDJPY", "GBPUSD"]);
  // The contract month and the generic roll do not matter, nor does a root with no fund of its own (6A).
  expect(["6E=F", "6EZ26", "6E1", "6J=F", "6A=F", "6AH27"].map(pair)).toEqual(["EURUSD", "EURUSD", "EURUSD", "USDJPY", "AUDUSD", "AUDUSD"]);
  expect(["AAPL", "FXE", "BTC-USD", "XAUUSD=X", "GC=F", "ES=F", "6X=F"].map(pair)).toEqual([null, null, null, null, null, null, null]);
  // The pane's line gives the fund and names HVT, and is no command.
  expect(fxVolatilityNote("EURUSD=X")).toBe("OTC FX volatility is not covered for EURUSD=X. Currency-ETF options are the listed proxy: FXE. HVT shows the pair's realized volatility.");
  expect(fxVolatilityNote("SPY")).toBeNull();
  // The sterling future has its fund for `options`, as the euro and yen ones do.
  expect(listedOptionsAlternative("6B=F")?.symbol).toBe("FXB");
});
