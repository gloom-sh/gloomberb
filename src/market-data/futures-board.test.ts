import { expect, test } from "bun:test";
import { bareFuturesCode, FUTURES_CONTRACTS, futuresBoardContract, futuresBoardContractForTicker } from "./futures-board";

test("every board row is its future as a typed argument, and under the cursor only where no security keeps its code", () => {
  for (const row of FUTURES_CONTRACTS) {
    for (const typed of [row.code, row.code.toLowerCase(), row.symbol, ` ${row.symbol.toLowerCase()} `]) {
      expect(futuresBoardContract(typed)).toBe(row);
    }
    expect(futuresBoardContractForTicker(row.symbol)).toBe(row);
    expect(futuresBoardContractForTicker(row.code)).toBe(row.bareCode ? row : null);
  }
  // NovaGold, Colgate, Eversource, Zoom, Zscaler, Planet Labs and Thales keep their codes; GC is listed on several venues.
  for (const code of ["NG", "CL", "ES", "ZM", "ZS", "PL", "HO", "GC"]) expect(bareFuturesCode(code)).toBeNull();
  expect(["TTF", "zn", "6E"].map((code) => bareFuturesCode(code)?.symbol)).toEqual(["TTF=F", "ZN=F", "6E=F"]);
  expect([bareFuturesCode("TTF=F"), futuresBoardContract("AAPL"), futuresBoardContractForTicker(null)]).toEqual([null, null, null]);
});
