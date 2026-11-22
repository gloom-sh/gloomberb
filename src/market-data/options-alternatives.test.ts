import { expect, test } from "bun:test";
import { createTestCliContext } from "../test-support/cli-context";
import { marketDataCliCommands } from "../cli/commands/market";
import {
  fxVolatilityNote, fxVolatilityPair, listedOptionsAlternative, optionsUnavailableDetails, optionsUnavailableHint, optionsUnavailableTitle,
  unservedOptionsVenue,
} from "./options-alternatives";

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
  // CME lists options on its yen future; the app does not serve them, and says so, with FXY as the proxy.
  await expect(marketDataCliCommands.find((command) => command.name === "options")!.execute(["6J=F"], cli.context))
    .rejects.toThrow("Options on CME yen futures (6J=F) are not served.");
  expect(failure!.details).toContain("gloom options FXY");
  // Nor does it serve options on a spot pair, which no plan changes: the pair's currency fund is the proxy,
  // a dollar pair with no fund of its own reads the dollar fund, and a cross names the funds that hold it.
  await expect(marketDataCliCommands.find((command) => command.name === "options")!.execute(["EURUSD=X"], cli.context))
    .rejects.toThrow("Options on spot FX pairs (EURUSD=X) are not served.");
  expect(failure!.details).toContain("gloom options FXE");
  expect(["AUDUSD=X", "6A=F", "EURJPY=X"].map((symbol) => listedOptionsAlternative(symbol)?.symbol ?? null)).toEqual(["UUP", "UUP", null]);
  expect(optionsUnavailableDetails("EURJPY=X", (symbol) => `gloom fn OMON ${symbol}`))
    .toBe("Currency funds with listed options: gloom fn OMON FXE, gloom fn OMON FXY.");
});

test("a spot pair in any spelling and a currency future in any contract are one FX pair; a stock, a coin, spot gold and a fund are none", () => {
  const pair = (symbol: string) => fxVolatilityPair(symbol);
  expect(["EURUSD=X", "eur/usd", "JPY=X", "GBPUSD=X"].map(pair)).toEqual(["EURUSD", "EURUSD", "USDJPY", "GBPUSD"]);
  // The contract month and the generic roll do not matter, nor does a root with no fund of its own (6A).
  expect(["6E=F", "6EZ26", "6E1", "6J=F", "6A=F", "6AH27"].map(pair)).toEqual(["EURUSD", "EURUSD", "EURUSD", "USDJPY", "AUDUSD", "AUDUSD"]);
  expect(["AAPL", "FXE", "BTC-USD", "XAUUSD=X", "GC=F", "ES=F", "6X=F"].map(pair)).toEqual([null, null, null, null, null, null, null]);
  // The pane's line gives the fund and names HVT, and is no command.
  expect(fxVolatilityNote("EURUSD=X")).toBe("OTC FX volatility is not covered for EURUSD=X. Currency-ETF options are the listed proxy and give an ATM IV30 only, no 25-delta risk reversal or butterfly: FXE. HVT shows the pair's realized volatility.");
  expect(fxVolatilityNote("SPY")).toBeNull();
  // The sterling future has its fund for `options`, as the euro and yen ones do.
  expect(listedOptionsAlternative("6B=F")?.symbol).toBe("FXB");
});

// OMON 0700:HKEX read "Options are not available for 0700:XHKG." HKEX lists Tencent's options; Gloom does not serve them.
test("a listing whose venue lists options says Gloom does not serve them; a served or unlisted one keeps its wording", async () => {
  // Listed abroad: as typed, as stored under its MIC, and bare with its exchange, each named by the venue's own code.
  for (const [symbol, exchange] of [["0700:HKEX"], ["0700:XHKG"], ["0700", "HKEX"]] as const) {
    expect(unservedOptionsVenue(symbol, exchange)).toBe("HKEX");
    expect(optionsUnavailableTitle(symbol, exchange)).toBe("Options on HKEX listings (0700:HKEX) are not served.");
    const said = `${optionsUnavailableHint(symbol, exchange)} ${optionsUnavailableDetails(symbol, (each) => `gloom options ${each}`, exchange)}`;
    expect(said).toContain("Gloom serves options on US listings, BTC and ETH.");
    // No plan serves them, so none is offered.
    expect(said).not.toMatch(/\b(?:pro|plan|upgrade|subscri)/i);
  }
  expect(["7203:JPX", "SAP:XETRA", "SHEL:LSE", "RY:TSX", "BHP:ASX", "MC:EPA"].map((key) => unservedOptionsVenue(key)))
    .toEqual(["JPX", "XETRA", "LSE", "TSX", "ASX", "EPA"]);
  // Served (a US listing) or listed nowhere Gloom knows of (SGX lists no single-stock options): no venue to name.
  expect(["AAPL", "AAPL:NASDAQ", "D05:SGX", "600519:SSE"].map((key) => unservedOptionsVenue(key))).toEqual([null, null, null, null]);
  expect(optionsUnavailableTitle("D05:XSES")).toBe("Options are not available for D05:SGX.");
  expect(optionsUnavailableHint("D05:SGX")).toBe("OSA builds strategy payoffs on a listed underlying.");

  const cli = createTestCliContext({ dataProvider: {
    getOptionsChain: async (symbol: string) => { throw new Error(`No options provider available for ${symbol}`); },
    getQuote: async () => { throw new Error("offline"); },
  } });
  let failure: { message: string; details?: string } | null = null;
  cli.context.fail = ((message: string, details?: string): never => {
    failure = { message, details };
    throw new Error(message);
  }) as typeof cli.context.fail;
  await expect(marketDataCliCommands.find((command) => command.name === "options")!.execute(["0700:HKEX"], cli.context))
    .rejects.toThrow("Options on HKEX listings (0700:HKEX) are not served.");
  expect(failure!.details).toBe("Gloom serves options on US listings, BTC and ETH. Strategy payoffs on a US listing: gloom fn OSA <ticker>");
});
