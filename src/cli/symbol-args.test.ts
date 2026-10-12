import { expect, test } from "bun:test";
import { splitSymbolArgs } from "./symbol-args";

test("arguments split on commas, spaces and newlines in any mix", () => {
  expect(splitSymbolArgs(["AAPL, msft ,XXXXX,ttf.as", "nvda", "xom ", "BRK.B;SAN:EPA\n7203.T"]))
    .toEqual(["AAPL", "msft", "XXXXX", "ttf.as", "nvda", "xom", "BRK.B", "SAN:EPA", "7203.T"]);
});

test("a list pasted from a terminal, a sheet or a chat splits whatever its separators and keeps each symbol's typed case", () => {
  expect(splitSymbolArgs(["jnk\nEMB\nBRK.B, bf-b "])).toEqual(["jnk", "EMB", "BRK.B", "bf-b"]);
  expect(splitSymbolArgs(["AAPL\tMSFT\r\nNVDA\r\n\r\n,, ,"])).toEqual(["AAPL", "MSFT", "NVDA"]);
  expect(splitSymbolArgs(["\uFEFFAAPL MSFT"])).toEqual(["AAPL", "MSFT"]);
  expect(splitSymbolArgs(["", "  \n "])).toEqual([]);
});
