import { afterEach, expect, test } from "bun:test";
import { boardCoinFor, primeBoardCoins, resetBoardCoins } from "./board-coins";
import { withSearchHints } from "./not-a-ticker";

afterEach(() => resetBoardCoins());

const BOARD = [
  { symbol: "USDT-USD", code: "USDT", name: "Tether USDt", marketCap: 183e9 },
  { symbol: "XAUT-USD", code: "XAUT", name: "Tether Gold", marketCap: 2e9 },
  { symbol: "USDE-USD", code: "USDE", name: "Ethena USDe", marketCap: 4.7e9 },
  { symbol: "USDS-USD", code: "USDS", name: "USDS", marketCap: 10e9 },
];

test("a coin typed bare is named by its one board symbol, by code or name, once the board is read", async () => {
  expect(withSearchHints("Not a ticker: USDS.", ["USDS"])).toBe("Not a ticker: USDS. Try `gloom search USDS`.");
  let reads = 0;
  const load = async () => { reads += 1; return { assets: BOARD }; };
  // Nothing says a bare word is no ticker: no read.
  await primeBoardCoins(["Not a ticker: BTC-USD:NYSE.", null], load);
  expect(reads).toBe(0);
  await primeBoardCoins(["Not a ticker: USDS."], load);
  await primeBoardCoins(["Not a ticker: USDT."], load);
  expect(reads).toBe(1);
  expect(withSearchHints("Not a ticker: USDS.", ["usds"])).toBe("Not a ticker: USDS. Did you mean USDS-USD (USDS)?");
  expect(withSearchHints("Not a ticker: USDT.", ["USDT"])).toBe("Not a ticker: USDT. Did you mean USDT-USD (Tether USDt)?");
  // Two Tether coins: the larger is the one meant.
  expect(boardCoinFor("tether")).toEqual({ symbol: "USDT-USD", name: "Tether USDt" });
  expect(boardCoinFor("ETHENAUSDE")).toEqual({ symbol: "USDE-USD", name: "Ethena USDe" });
  // A short first word is no name, and a word nothing on the board answers keeps the search hint.
  expect(boardCoinFor("USD")).toBeNull();
  expect(withSearchHints("Not a ticker: APPLE.", ["Apple"])).toBe("Not a ticker: APPLE. Try `gloom search Apple`.");
});

test("a board that fails names the coins this build knows, and leaves the search hint for any other word", async () => {
  await primeBoardCoins(["Not a ticker: USDT."], async () => { throw new Error("down"); });
  expect(withSearchHints("Not a ticker: USDT.", ["USDT"])).toBe("Not a ticker: USDT. Did you mean USDT-USD (Tether USDt)?");
  expect(withSearchHints("Not a ticker: APPLE.", ["Apple"])).toBe("Not a ticker: APPLE. Try `gloom search Apple`.");
});

/**
 * In an outage on 3 Nov 2026 `quote USDT` and `quote FOOBARX` both read "Gloom's data service did not
 * answer", a typo and an outage alike, and USDT lost its pointer to USDT-USD with the board the same service serves.
 */
test("a symbol the data service could not check keeps the coin it may be, from the coins this build knows in an outage", async () => {
  const line = "Could not check USDT: Gloom's data service did not answer. Try again in a moment.";
  await primeBoardCoins([line], async () => { throw new Error("down"); });
  expect(withSearchHints(line, ["usdt"])).toBe(`${line} Did you mean USDT-USD (Tether USDt)?`);
  const both = "Could not check USDT, FOOBARX: Gloom's data service did not answer. Try again in a moment.";
  expect(withSearchHints(both, ["USDT", "FOOBARX"])).toBe(`${both} Did you mean USDT-USD (Tether USDt) for USDT?`);
  expect(withSearchHints("Could not check FOOBARX: Gloom couldn't reach its data service", ["FOOBARX"]))
    .toBe("Could not check FOOBARX: Gloom couldn't reach its data service");
  expect(withSearchHints("Could not check out abc1234: not found", [])).toBe("Could not check out abc1234: not found");
  // A command that resolves one symbol says it the same way; the hint is given once.
  const lookup = "Could not look up BTC: Gloom Cloud did not answer. Try again in a minute.";
  expect(withSearchHints(withSearchHints(lookup, ["BTC"]), ["BTC"])).toBe(`${lookup} Did you mean BTC-USD (Bitcoin)?`);
});
