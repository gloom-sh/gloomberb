import { expect, test } from "bun:test";
import { parseSymbolText, readSymbolList } from "./symbol-list";

const symbolsOf = (text: string) => parseSymbolText(text).symbols;

test("a spreadsheet export reads its symbol column, or its first column, past BOM, CRLF, quotes, blanks and comments", () => {
  const exported = "\uFEFFName,\"Ticker Symbol\",\"Weight, %\"\r\n\"Apple Inc.\",\"AAPL\",5.1\r\n\r\n# exported from sheets\r\n,,\r\n\"Microsoft, Corp\", msft ,4.2\r\n";
  expect(parseSymbolText(exported)).toEqual({ symbols: ["AAPL", "msft"], ignored: [] });
  // Semicolons and tabs, as European spreadsheets and pasted tables split them.
  expect(symbolsOf("Code;Name\n7203;Toyota\n6758;Sony\n")).toEqual(["7203", "6758"]);
  expect(symbolsOf("Symbol\tLast\nNVDA\t229.28\n")).toEqual(["NVDA"]);
  // Without a header, names and numbers beside the symbols make it a table, and the cells left out are returned.
  expect(parseSymbolText("AAPL,Apple Inc.,336.64\nMSFT,Microsoft,535.07\n")).toEqual({ symbols: ["AAPL", "MSFT"], ignored: ["Apple Inc.", "336.64", "Microsoft", "535.07"] });
  expect(parseSymbolText("SAN:EPA,12\nASML.AS,3\n")).toEqual({ symbols: ["SAN:EPA", "ASML.AS"], ignored: ["12", "3"] });
});

test("a plain list gives every symbol, whether on its own line, split by spaces or by commas", () => {
  expect(symbolsOf("AAPL\nmsft  nvda\n\n// later\nXOM\n")).toEqual(["AAPL", "msft", "nvda", "XOM"]);
  expect(symbolsOf("AAPL, MSFT\nNVDA, XOM")).toEqual(["AAPL", "MSFT", "NVDA", "XOM"]);
  expect(symbolsOf("Symbol\nAAPL\nMSFT\n")).toEqual(["AAPL", "MSFT"]);
});

test("one ragged line, or a symbol with a stray separator in its quotes, does not turn a pasted list into a table", async () => {
  // GLO-1044: the quoted "BIMAS ," made the whole paste a table read by its first column, dropping KCHOL.IS, FROTO, JNJ and MSFT unsaid.
  const pasted = "thyao, THYAO.IS\n\"BIMAS ,\"\nasels , KCHOL.IS\nTupRS,froto\nko, JNJ\nbrk-b, MSFT\n";
  expect(await readSymbolList({ args: ["-"], readStdin: async () => pasted })).toEqual({
    symbols: ["thyao", "THYAO.IS", "BIMAS", "asels", "KCHOL.IS", "TupRS", "froto", "ko", "JNJ", "brk-b", "MSFT"],
    repeated: 0,
    notes: ['Ignored the stray "," after BIMAS.'],
  });
  // A real table still reads its first column, and names every cell it left out.
  const table = await readSymbolList({ args: ["-"], readStdin: async () => "AAPL,Apple Inc.,336.64\nMSFT,Microsoft,535.07\n" });
  expect(table.notes).toEqual(["Read the first column as symbols; ignored the 4 cells beside it: Apple Inc., 336.64, Microsoft, 535.07."]);
});

test("symbols come from arguments, the file and standard input together, each once", async () => {
  const list = await readSymbolList({ args: ["AAPL,aapl", "-"], readStdin: async () => "$AAPL\nMSFT\r\nmsft\r\n" });
  expect(list).toEqual({ symbols: ["AAPL", "MSFT"], repeated: 3, notes: [] });
  // Piped input is read only when no symbol was typed.
  expect(await readSymbolList({ args: ["NVDA"], stdinPiped: true, readStdin: async () => "XOM" })).toEqual({ symbols: ["NVDA"], repeated: 0, notes: [] });
  expect(await readSymbolList({ args: [], stdinPiped: true, readStdin: async () => "XOM" })).toEqual({ symbols: ["XOM"], repeated: 0, notes: [] });
});

test("a separator stuck to a symbol in a list is dropped before any lookup and named, not read as part of the ticker", async () => {
  // The first line holds no delimiter, so each later cell keeps its own trailing `;`.
  const read = (text: string) => readSymbolList({ args: ["-"], readStdin: async () => text });
  expect(await read("Symbol\nUPST;\nGME;\n")).toEqual({
    symbols: ["UPST", "GME"],
    repeated: 0,
    notes: ['Ignored the stray ";" after UPST.', 'Ignored the stray ";" after GME.'],
  });
  expect(await read("GME\n\"UPST\",\nAMC\n")).toEqual({ symbols: ["GME", "UPST", "AMC"], repeated: 0, notes: ['Ignored the stray "," after UPST.'] });
  // Typed, only the ends of the list can be stray: in the middle a separator is what splits it.
  expect(await readSymbolList({ args: ["GME,", "UPST;"] })).toEqual({ symbols: ["GME", "UPST"], repeated: 0, notes: ['Ignored the stray ";" after UPST.'] });
});
