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
  expect(withSearchHints("Not a ticker: USDS.", ["USDS"])).toBe("Not a ticker: USDS. Try `gloomberb search USDS`.");
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
  expect(withSearchHints("Not a ticker: APPLE.", ["Apple"])).toBe("Not a ticker: APPLE. Try `gloomberb search Apple`.");
});

test("a board that fails leaves the search hint", async () => {
  await primeBoardCoins(["Not a ticker: USDT."], async () => { throw new Error("down"); });
  expect(withSearchHints("Not a ticker: USDT.", ["USDT"])).toBe("Not a ticker: USDT. Try `gloomberb search USDT`.");
});
