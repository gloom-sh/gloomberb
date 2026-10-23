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
  // Lines are entries, read as typed entries are: a line with spaces is a name or symbols on one line.
  expect(parseSymbolText("AAPL\nmsft  nvda\n\n// later\nXOM\n")).toEqual({ symbols: ["AAPL", "msft nvda", "XOM"], ignored: [], entries: true });
  expect(symbolsOf("AAPL, MSFT\nNVDA, XOM")).toEqual(["AAPL", "MSFT", "NVDA", "XOM"]);
  expect(symbolsOf("Symbol\nAAPL\nMSFT\n")).toEqual(["AAPL", "MSFT"]);
});

test("a pasted list of company names keeps each line or semicolon cell one name, and a line of tickers stays tickers", async () => {
  // GLO-1105: "Altria Group" was the symbols ALTRIA and GROUP, and "philip morris intl" added INTL, a fund.
  const names = { "altria group": "MO", "philip morris intl": "PM", "lockheed martin": "LMT" } as Record<string, string>;
  const readEntries = async (entries: string[]) => entries.flatMap((entry) => names[entry.toLowerCase()] ?? entry.split(/\s+/));
  const read = (text: string) => readSymbolList({ args: ["-"], readStdin: async () => text, readEntries });
  expect((await read("Altria Group\nphilip morris intl\nLockheed Martin\n")).symbols).toEqual(["MO", "PM", "LMT"]);
  expect((await read("Altria Group; Lockheed Martin; philip morris intl\n")).symbols).toEqual(["MO", "LMT", "PM"]);
  expect((await read("Altria Group;\nLockheed Martin\n")).symbols).toEqual(["MO", "LMT"]);
  expect(await read("AAPL MSFT NVDA\n")).toEqual({ symbols: ["AAPL", "MSFT", "NVDA"], repeated: 0, notes: [] });
  expect((await read("MO;PM;LMT")).symbols).toEqual(["MO", "PM", "LMT"]);
  // Figures beside the symbols, split by spaces or by commas, still make a table read by its first column.
  expect(parseSymbolText("AAPL 150.00\nMSFT 420.10\n")).toEqual({ symbols: ["AAPL", "MSFT"], ignored: ["150.00", "420.10"] });
});

test("names beside other text are a table read by its first column, or by the column a Name header names", async () => {
  // A sector beside each name is not a symbol: it was added twice as TECHNOLOGY.
  const sectors = "Apple Inc,Technology\nMicrosoft Corp,Technology\n";
  expect(parseSymbolText(sectors)).toEqual({ symbols: ["Apple Inc", "Microsoft Corp"], ignored: ["Technology", "Technology"], entries: true });
  const names = { "apple inc": "AAPL", "microsoft corp": "MSFT" } as Record<string, string>;
  const read = await readSymbolList({ args: ["-"], readStdin: async () => sectors, readEntries: async (entries) => entries.map((entry) => names[entry.toLowerCase()] ?? entry) });
  expect(read).toEqual({ symbols: ["AAPL", "MSFT"], repeated: 0, notes: ["Read the first column as symbols; ignored the 2 cells beside it: Technology, Technology."] });
  // A header is not a company, and names the column to read.
  expect(parseSymbolText(`Name,Sector\n${sectors}`)).toEqual({ symbols: ["Apple Inc", "Microsoft Corp"], ignored: [], entries: true });
  expect(parseSymbolText(`Sector;Company\nTechnology;Apple Inc\n`).symbols).toEqual(["Apple Inc"]);
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

test("a European sheet's prices are number cells, never symbols, whatever splits each line", async () => {
  // Before, the comma of `2.582,52` split the line, and `2.582` was added as 2582:HKEX.
  const pasted = "ED 2.582,52\nCNX;1.899,21\nEQT\t3.594,10\n$$$\nN/A\n";
  expect(await readSymbolList({ args: ["-"], readStdin: async () => pasted })).toEqual({
    symbols: ["ED", "CNX", "EQT", "$$$", "N/A"],
    repeated: 0,
    notes: ["Read the first column as symbols; ignored the 3 number cells beside it: 2.582,52; 1.899,21; 3.594,10."],
  });
  // US and European forms, signs, percents and currency marks, beside a symbol or on a line of their own.
  const figures = ["2.582,52", "1,899.21", "1.899", "-2,5%", "+4", "12%", "$12.50", "€1.234,56", "(1,234.56)"];
  for (const separator of [" ", "\t", ";", ","]) {
    const read = await readSymbolList({ args: ["-"], readStdin: async () => `${figures.map((figure) => `XOM${separator}${figure}`).join("\n")}\n1.899,21\n` });
    expect(read.symbols).toEqual(["XOM"]);
    expect(read.notes.at(-1)).toBe("Ignored 1.899,21, a number, not a symbol.");
  }
  // Typed, a number is never a symbol either: beside one (a pasted line) or on its own.
  expect(await readSymbolList({ args: ["ED 2.582,52\nCNX;1.899,21", "1.899", "EQT"] })).toEqual({
    symbols: ["ED", "CNX", "EQT"],
    repeated: 0,
    notes: ["Ignored 3 numbers, not symbols: 2.582,52; 1.899,21; 1.899."],
  });
});

test("a numeric ticker is a symbol alone or in the symbol column, and a bare number beside a symbol is its value", async () => {
  const read = (text: string) => readSymbolList({ args: ["-"], readStdin: async () => text });
  const codes = ["7203", "0700.HK", "2330:TWSE", "2582:HKEX"];
  expect((await read(`${codes.join("\n")}\n`)).symbols).toEqual(codes);
  expect((await readSymbolList({ args: codes })).symbols).toEqual(codes);
  expect((await read("7203;1.899,21\n2582:HKEX\t3.594,10\nED 2582\n")).symbols).toEqual(["7203", "2582:HKEX", "ED"]);
  expect((await readSymbolList({ args: ["ED 2582"] })).symbols).toEqual(["ED"]);
  // Codes among symbols, or side by side, stay codes: `7203,6758` holds no decimal comma.
  for (const args of [["7203 6758"], ["7203,6758"]]) expect((await readSymbolList({ args })).symbols).toEqual(["7203", "6758"]);
  expect((await readSymbolList({ args: ["amd 2222 pltr"] })).symbols).toEqual(["amd", "2222", "pltr"]);
});

test("a comma between plain digits splits codes, unless the line or the sheet's header has another separator", async () => {
  const read = (text: string) => readSymbolList({ args: ["-"], readStdin: async () => text });
  // Read as 0700.25 and 9988.15, a sheet of codes and weights added nothing.
  expect(await read("Symbol,Weight\n0700,25\n9988,15\n")).toEqual({ symbols: ["0700", "9988"], repeated: 0, notes: [] });
  expect((await read("Code,Shares\n7203,10\n6758,5\n")).symbols).toEqual(["7203", "6758"]);
  expect(await read("7203,10\n")).toEqual({ symbols: ["7203"], repeated: 0, notes: ["Read the first column as symbols; ignored the number cell beside it: 10."] });
  for (const arg of ["9988,5", "5,700", "700,388"]) expect((await readSymbolList({ args: [arg] })).symbols).toEqual(arg.split(","));
  // Beside a tab, a semicolon or spaces between cells, or under a header split by tabs, the comma is a decimal one.
  expect((await read("ED 116,26\nCNX;35,73\nEQT\t54,67\n")).symbols).toEqual(["ED", "CNX", "EQT"]);
  expect(await readSymbolList({ args: ["ED 2,5"] })).toEqual({ symbols: ["ED"], repeated: 0, notes: ["Ignored 2,5, a number, not a symbol."] });
  expect(await read("Symbol\tWeight\n7203\t2,5\n6758,5\n")).toEqual({ symbols: ["7203"], repeated: 0, notes: ["Ignored 6758,5, a number, not a symbol."] });
  // A number only a number can be stays one where commas split the line.
  expect(await read("ED,2.582,52\nCNX,1,899.21\n")).toEqual({
    symbols: ["ED", "CNX"], repeated: 0, notes: ["Read the first column as symbols; ignored the 2 number cells beside it: 2.582,52; 1,899.21."],
  });
});
