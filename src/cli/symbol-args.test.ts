import { expect, test } from "bun:test";
import { splitSymbolArgs, uniqueSecuritySymbols } from "./symbol-args";

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

test("a security typed twice, in either case or with either share-class separator, is kept once in its first spelling", () => {
  expect(uniqueSecuritySymbols(["AAPL", "aapl", "BRK-B", "BRK.B", "$AAPL", "BRK.A", "SAN:EPA", "san:epa", "SAN"]))
    .toEqual(["AAPL", "BRK-B", "BRK.A", "SAN:EPA", "SAN"]);
});
