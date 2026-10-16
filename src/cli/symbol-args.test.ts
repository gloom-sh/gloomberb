import { expect, test } from "bun:test";
import { splitSymbolArgs, stripStrayEdges, uniqueSecuritySymbols } from "./symbol-args";

test("an argument with commas, semicolons, tabs or lines splits on those alone, so an entry can be a name; one without splits on spaces", () => {
  expect(splitSymbolArgs(["AAPL, msft ,XXXXX,ttf.as", "nvda", "xom ", "BRK.B;SAN:EPA\n7203.T"]))
    .toEqual(["AAPL", "msft", "XXXXX", "ttf.as", "nvda", "xom", "BRK.B", "SAN:EPA", "7203.T"]);
  expect(splitSymbolArgs(["WHR, Whirlpool  Corporation , BRK.B"])).toEqual(["WHR", "Whirlpool Corporation", "BRK.B"]);
  expect(splitSymbolArgs(["JNK EMB", "BRK.B"])).toEqual(["JNK", "EMB", "BRK.B"]);
});

test("a list pasted from a terminal, a sheet or a chat splits whatever its separators and keeps each symbol's typed case", () => {
  expect(splitSymbolArgs(["jnk\nEMB\nBRK.B, bf-b "])).toEqual(["jnk", "EMB", "BRK.B", "bf-b"]);
  expect(splitSymbolArgs(["AAPL\tMSFT\r\nNVDA\r\n\r\n,, ,"])).toEqual(["AAPL", "MSFT", "NVDA"]);
  expect(splitSymbolArgs(["\uFEFFAAPL MSFT"])).toEqual(["AAPL", "MSFT"]);
  expect(splitSymbolArgs(["", "  \n "])).toEqual([]);
});

test("quote marks around a pasted entry are dropped, single, double or curly, whole or stray", () => {
  expect(splitSymbolArgs([`"GME", 'AMC'; “CVNA”, "BRK-B`, `'UPST`])).toEqual(["GME", "AMC", "CVNA", "BRK-B", "UPST"]);
  expect(splitSymbolArgs(['"', "''"])).toEqual([]);
});

test("a separator stuck to the end of a list or cell is dropped and named, quote marks silently", () => {
  expect(stripStrayEdges("UPST;")).toEqual({ text: "UPST", notes: ['Ignored the stray ";" after UPST.'] });
  expect(stripStrayEdges(`;"GME",`)).toEqual({ text: `GME`, notes: ['Ignored the stray ";" before GME.', 'Ignored the stray "," after GME.'] });
  expect(stripStrayEdges("GME, AMC,")).toEqual({ text: "GME, AMC", notes: ['Ignored the stray "," after AMC.'] });
  expect(stripStrayEdges(";")).toEqual({ text: "", notes: ['Ignored the stray ";".'] });
  expect(stripStrayEdges(`"GME" `)).toEqual({ text: "GME", notes: [] });
  expect(stripStrayEdges("SAN:EPA")).toEqual({ text: "SAN:EPA", notes: [] });
});

test("a security typed twice, in either case or with either share-class separator, is kept once in its first spelling", () => {
  expect(uniqueSecuritySymbols(["AAPL", "aapl", "BRK-B", "BRK.B", "$AAPL", "BRK.A", "SAN:EPA", "san:epa", "SAN"]))
    .toEqual(["AAPL", "BRK-B", "BRK.A", "SAN:EPA", "SAN"]);
});
