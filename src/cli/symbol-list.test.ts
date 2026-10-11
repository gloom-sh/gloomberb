import { expect, test } from "bun:test";
import { parseSymbolText, readSymbolList, splitSymbolArgs } from "./symbol-list";

test("arguments split on commas, spaces and newlines in any mix", () => {
  expect(splitSymbolArgs(["AAPL, msft ,XXXXX,ttf.as", "nvda", "xom ", "BRK.B;SAN:EPA\n7203.T"]))
    .toEqual(["AAPL", "msft", "XXXXX", "ttf.as", "nvda", "xom", "BRK.B", "SAN:EPA", "7203.T"]);
});

test("a spreadsheet export reads its symbol column, or its first column, past BOM, CRLF, quotes, blanks and comments", () => {
  const exported = "\uFEFFName,\"Ticker Symbol\",\"Weight, %\"\r\n\"Apple Inc.\",\"AAPL\",5.1\r\n\r\n# exported from sheets\r\n,,\r\n\"Microsoft, Corp\", msft ,4.2\r\n";
  expect(parseSymbolText(exported)).toEqual(["AAPL", "msft"]);
  // Semicolons and tabs, as European spreadsheets and pasted tables split them.
  expect(parseSymbolText("Code;Name\n7203;Toyota\n6758;Sony\n")).toEqual(["7203", "6758"]);
  expect(parseSymbolText("Symbol\tLast\nNVDA\t229.28\n")).toEqual(["NVDA"]);
  // Without a header, names and numbers beside the symbols make it a table.
  expect(parseSymbolText("AAPL,Apple Inc.,336.64\nMSFT,Microsoft,535.07\n")).toEqual(["AAPL", "MSFT"]);
  expect(parseSymbolText("SAN:EPA,12\nASML.AS,3\n")).toEqual(["SAN:EPA", "ASML.AS"]);
});

test("a plain list gives every symbol, whether on its own line, split by spaces or by commas", () => {
  expect(parseSymbolText("AAPL\nmsft  nvda\n\n// later\nXOM\n")).toEqual(["AAPL", "msft", "nvda", "XOM"]);
  expect(parseSymbolText("AAPL, MSFT\nNVDA, XOM")).toEqual(["AAPL", "MSFT", "NVDA", "XOM"]);
  expect(parseSymbolText("Symbol\nAAPL\nMSFT\n")).toEqual(["AAPL", "MSFT"]);
});

test("symbols come from arguments, the file and standard input together, each once", async () => {
  const list = await readSymbolList({ args: ["AAPL,aapl", "-"], readStdin: async () => "$AAPL\nMSFT\r\nmsft\r\n" });
  expect(list).toEqual({ symbols: ["AAPL", "MSFT"], repeated: 3 });
  // Piped input is read only when no symbol was typed.
  expect(await readSymbolList({ args: ["NVDA"], stdinPiped: true, readStdin: async () => "XOM" })).toEqual({ symbols: ["NVDA"], repeated: 0 });
  expect(await readSymbolList({ args: [], stdinPiped: true, readStdin: async () => "XOM" })).toEqual({ symbols: ["XOM"], repeated: 0 });
});
