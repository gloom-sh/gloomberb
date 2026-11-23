import { expect, test } from "bun:test";
import type { OptionContract } from "../../../types/financials";
import { parseAlertAddArgs } from "./cli";
import { parseLooseOptionContract, resolveLooseOptionContract, type ChainReader } from "./option-contract";
import { useAlertTestClock } from "./test-fixture";

useAlertTestClock();

// Wed 18 Nov 2026, 16:00 UTC: the 18 Nov expiry is still trading.
const NOW = Date.UTC(2026, 10, 18, 16);
const stamp = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;

/** SPY's listing: daily expiries this week and the 2027 monthly on the same day as one of them. */
function chain(listed: Record<string, number[]>, root = "SPY"): ChainReader {
  const contract = (date: string, strike: number, side: "C" | "P"): OptionContract => ({
    contractSymbol: `${root}${date.slice(2).replaceAll("-", "")}${side}${String(strike * 1000).padStart(8, "0")}`, strike, currency: "USD",
    lastPrice: 1, change: 0, percentChange: 0, bid: 1, ask: 1.1, impliedVolatility: 0.2, inTheMoney: false, expiration: stamp(date), lastTradeDate: 0,
  });
  return async (expiration) => {
    const dates = Object.keys(listed);
    const date = expiration == null ? null : dates.find((entry) => stamp(entry) === expiration)!;
    return {
      expirationDates: dates.map(stamp),
      calls: date ? listed[date]!.map((strike) => contract(date, strike, "C")) : [],
      puts: date ? listed[date]!.map((strike) => contract(date, strike, "P")) : [],
    };
  };
}

test("a contract typed the ways traders write one reads as its root, expiry, side and strike", () => {
  const nov19 = { root: "SPY", year: null, month: 11, day: 19, side: "C", strike: 680 };
  for (const typed of ["SPY 680C 11/19", "spy 11/19 680c", "SPY C680 11/19", "SPY 680 call 11/19", "SPY Nov 19 680 C", "SPY 19 NOV $680 calls"]) {
    expect(parseLooseOptionContract(typed)).toEqual(nov19 as never);
  }
  expect(parseLooseOptionContract("SPY 11/19/26 680P")).toEqual({ ...nov19, year: 2026, side: "P" } as never);
  expect(parseLooseOptionContract("SPY Nov 19 '27 680 put")).toEqual({ ...nov19, year: 2027, side: "P" } as never);
  expect(parseLooseOptionContract("SPY 2026-11-19 681.5C")).toEqual({ ...nov19, year: 2026, strike: 681.5 } as never);
  // An OCC symbol with its strike unpadded, or padded the OCC way.
  expect(parseLooseOptionContract("SPY241119C680")).toEqual({ ...nov19, year: 2024 } as never);
  expect(parseLooseOptionContract("SPY 241119C00680000")).toEqual({ ...nov19, year: 2024 } as never);
  for (const typed of ["SPY", "SPY 680C", "SPY 11/19", "SPY 680 11/19", "SPY 680C 13/19", "SPY 680C 11/19 extra", "680C 11/19"]) {
    expect(parseLooseOptionContract(typed)).toBeNull();
  }
});

/** `alerts add 'SPY 680C 11/19' iv spike 5` and `SPY241119C680 iv spike 5` met a generic iv error. */
test("a loose contract is the one listed contract it names, the next listed day when no year is typed", async () => {
  const listed = chain({ "2026-11-18": [680], "2026-11-19": [680, 681], "2026-11-20": [680], "2027-11-19": [680] });
  const resolve = (typed: string) => resolveLooseOptionContract(typed, parseLooseOptionContract(typed)!, listed, NOW);
  expect(await resolve("SPY 680C 11/19")).toEqual({ contract: "SPY261119C00680000", readAs: `Read "SPY 680C 11/19" as SPY261119C00680000 (SPY 19 Nov '26 $680 Call).` });
  expect((await resolve("SPY 680P 11/19/27")).contract).toBe("SPY271119P00680000");
  // Past its expiry it is kept as typed, for the rule to refuse it as expired; no chain is read.
  expect(await resolveLooseOptionContract("SPY241119C680", parseLooseOptionContract("SPY241119C680")!, async () => { throw new Error("no read"); }, NOW))
    .toEqual({ contract: "SPY241119C00680000", readAs: null });
  // Naming nothing listed, the error names the OCC form and a listed contract to copy.
  await expect(resolve("SPY 682C 11/19")).rejects.toThrow(`"SPY 682C 11/19" (SPY Nov 19 $682 Call) names no listed contract: SPY's 2026-11-19 expiry lists no $682 call. `
    + "An IV spike follows one OCC contract: the root, the expiry as YYMMDD, C or P, and the strike times 1,000 in 8 digits, such as SPY261119C00681000; gloom options SPY lists them.");
  await expect(resolve("SPY 680C 11/21")).rejects.toThrow("SPY lists no live expiry on Nov 21. An IV spike follows one OCC contract");
  // An SPX weekly is listed under SPXW: the rule follows the contract as it trades.
  const spx = chain({ "2026-11-20": [6800] }, "SPXW");
  expect((await resolveLooseOptionContract("SPX 6800C 11/20", parseLooseOptionContract("SPX 6800C 11/20")!, spx, NOW)).contract).toBe("SPXW261120C06800000");
});

/** The match took the first listed contract at the strike, side and day: on SPX's monthly expiry that is SPX or SPXW, whichever came first. */
test("a loose contract that two listed contracts match is refused, naming each to copy", async () => {
  const monthly = (["SPX", "SPXW"] as const).map((root): OptionContract => ({
    contractSymbol: `${root}261218C06800000`, strike: 6800, currency: "USD", lastPrice: 1, change: 0, percentChange: 0,
    bid: 1, ask: 1.1, impliedVolatility: 0.2, inTheMoney: false, expiration: stamp("2026-12-18"), lastTradeDate: 0,
  }));
  const both: ChainReader = async (expiration) => ({ expirationDates: [stamp("2026-12-18")], calls: expiration == null ? [] : monthly, puts: [] });
  await expect(resolveLooseOptionContract("SPX 6800C 12/18", parseLooseOptionContract("SPX 6800C 12/18")!, both, NOW)).rejects
    .toThrow('"SPX 6800C 12/18" (SPX Dec 18 $6800 Call) matches 2 listed contracts: SPX261218C06800000, SPXW261218C06800000. An IV spike follows one: name it by its OCC symbol.');
});

test("alerts add takes the contract of an IV spike in one word or several, and names the OCC form for one it cannot read", () => {
  expect(parseAlertAddArgs(["SPY 680C 11/19", "iv", "spike", "5"], undefined)).toMatchObject({ kind: "iv_spike", contract: "SPY 680C 11/19", points: 5,
    loose: { root: "SPY", month: 11, day: 19, side: "C", strike: 680 } });
  expect(parseAlertAddArgs(["SPY", "680C", "11/19", "iv", "spike", "5"], undefined)).toMatchObject({ kind: "iv_spike", contract: "SPY 680C 11/19" });
  expect(parseAlertAddArgs(["SPY241119C680", "iv", "spike", "5"], undefined)).toMatchObject({ kind: "iv_spike", loose: { year: 2024 } });
  expect(parseAlertAddArgs(["SPY 261119C00680000", "iv", "spike", "5"], undefined)).toEqual({ kind: "iv_spike", contract: "SPY261119C00680000", points: 5 });
  expect(() => parseAlertAddArgs(["SPY", "iv", "spike", "5"], undefined)).toThrow(/^"SPY" is not an option contract\. An IV spike follows one OCC contract: .* For SPY's 30-day ATM IV, add a level: gloom alerts add SPY iv above 50\.$/);
});
