import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { decodePositionsFile, MAX_IMPORT_POSITIONS, parsePositionsFile, PositionsFileError, SKIP_REASONS, type PositionsFile } from "./parse";

const NOW = new Date("2025-02-01T12:00:00Z");

function fixture(name: string): PositionsFile {
  return parsePositionsFile(readFileSync(join(import.meta.dir, "fixtures", name), "utf8"), NOW);
}

/** symbol → [shares, avg cost, currency, purchase date] */
function positions(file: PositionsFile) {
  return Object.fromEntries(file.positions.map((position) => [position.symbol, [position.shares, position.avgCost, position.currency, position.dateAcquired]]));
}

function skipped(file: PositionsFile) {
  return file.skipped.map((row) => [row.label, row.reason]);
}

describe("broker exports", () => {
  test("Fidelity: two accounts of one symbol add up; core money market, an option, a T-bill and pending activity are skipped", () => {
    const file = fixture("fidelity.csv");
    expect(file.layout).toBe("fidelity");
    expect(positions(file)).toEqual({
      // 25 @ 150 + 10 @ 180: the cost is by shares.
      AAPL: [35, 158.571428571429, "USD", null],
      VTI: [40.512, 224.63, "USD", null],
      FXAIX: [12.345, 162.01, "USD", null],
    });
    expect(file.positions[0]!.lines).toEqual([3, 8]);
    expect(skipped(file)).toEqual([
      ["SPAXX**", SKIP_REASONS.cash],
      ["-AAPL250620C240", SKIP_REASONS.option],
      ["912797LB1", SKIP_REASONS.bond],
      ["Pending Activity", SKIP_REASONS.pending],
    ]);
  });

  test("Schwab: the title line above the header, a total cost per share, Incomplete cost, an option, a Treasury note and the cash line", () => {
    const file = fixture("schwab.csv");
    expect(file.layout).toBe("schwab");
    expect(positions(file)).toEqual({
      MSFT: [12, 300, "USD", null],
      "BRK.B": [5, 350, "USD", null],
      SCHD: [100, 25, "USD", null],
      SWPPX: [50.123, null, "USD", null],
    });
    expect(skipped(file)).toEqual([
      ["AAPL 01/17/2025 230.00 C", SKIP_REASONS.option],
      ["91282CJL6", SKIP_REASONS.bond],
      ["Cash & Cash Investments", SKIP_REASONS.cash],
    ]);
  });

  test("Schwab all accounts: each account's header starts a section, and their rows of one symbol add up", () => {
    const file = fixture("schwab-all-accounts.csv");
    expect(file.layout).toBe("schwab");
    expect(positions(file)).toEqual({
      AMD: [10, 118, "USD", null],
      KR: [15.5536, 45.0056578541302, "USD", null],
    });
    expect(skipped(file)).toEqual([["Cash & Cash Investments", SKIP_REASONS.cash]]);
  });

  test("Vanguard: no cost, the settlement fund is cash, the trades below are not holdings, a plan fund has no ticker", () => {
    const file = fixture("vanguard.csv");
    expect(file.layout).toBe("vanguard");
    expect(positions(file)).toEqual({
      VTI: [30, null, "USD", null],
      VXUS: [80, null, "USD", null],
      VFIAX: [10.5, null, "USD", null],
    });
    expect(skipped(file)).toEqual([
      ["VMFXX", SKIP_REASONS.cash],
      ["Vanguard Target Retirement 2050 Trust", SKIP_REASONS.noTicker],
    ]);
  });

  test("E*TRADE: the account summary and filters above the table are not rows; price paid is the cost", () => {
    const file = fixture("etrade.csv");
    expect(file.layout).toBe("etrade");
    expect(positions(file)).toEqual({
      NVDA: [20, 48.25, "USD", null],
      QQQ: [10, 410, "USD", null],
    });
    expect(skipped(file)).toEqual([
      ["NVDA Jan 16 '26 $150 Call", SKIP_REASONS.option],
      ["CASH", SKIP_REASONS.cash],
    ]);
  });

  test("Merrill: the cost is the value less the unrealized gain; a note without a ticker and the bank deposit are skipped", () => {
    const file = fixture("merrill.csv");
    expect(file.layout).toBe("merrill");
    expect(positions(file)).toEqual({
      KO: [60, 50, "USD", null],
      JNJ: [15, 160, "USD", null],
    });
    expect(skipped(file)).toEqual([
      ["US TREASURY NOTE 1.375% 10/15/2026", SKIP_REASONS.bond],
      ["ML BANK DEPOSIT PROGRAM", SKIP_REASONS.cash],
    ]);
  });

  test("a table of its own: cost per share, the purchase date (ISO or month first) and the currency", () => {
    const file = fixture("generic.csv");
    expect(file.layout).toBe("generic");
    expect(positions(file)).toEqual({
      "ASML.AS": [4, 612.5, "EUR", "2023-05-10"],
      SHOP: [10, 55, "USD", "2022-03-15"],
      "7203.T": [100, 2150, "JPY", "2021-11-01"],
    });
    expect(skipped(file)).toEqual([["CASH", SKIP_REASONS.cash]]);
  });
});

describe("files", () => {
  test("a semicolon file with decimal commas, a total cost, a short, lots of one symbol and a date after today", () => {
    const file = parsePositionsFile([
      "Symbol;Quantity;Cost;Date acquired",
      "SAP;10;1.250,50;15.03.2021",
      "SAP;5;700,00;01.02.2020",
      "TSLA;-3;750,00;",
      "OR;2;800,00;01.03.2026",
    ].join("\n"), NOW);
    expect(positions(file)).toEqual({
      // 1,950.50 over 15 shares, dated by the earlier lot.
      SAP: [15, 130.033333333333, null, "2020-02-01"],
      TSLA: [-3, 250, null, null],
      // A purchase date after today is not one.
      OR: [2, 400, null, null],
    });
  });

  test("a tab file of US numbers keeps its thousands; only a number no decimal point could mean makes a file decimal-comma", () => {
    // 1,500 is fifteen hundred and 1,200.50 a cost, as a US export writes them; a slashed date is month first.
    expect(positions(parsePositionsFile("Symbol\tQuantity\tCost Basis\tDate Acquired\nAAPL\t1,500\t\"1,200.50\"\t04/03/2024\nMSFT\t2\t600\t\n", NOW))).toEqual({
      AAPL: [1500, 0.800333333333333, null, "2024-04-03"],
      MSFT: [2, 300, null, null],
    });
    // 12,5 makes 1,500 a decimal comma too, and such a file writes the day first.
    expect(positions(parsePositionsFile("Symbol;Quantity;Avg Cost;Date Acquired\nSAP;1,500;12,5;04/03/2024\n", NOW))).toEqual({
      SAP: [1.5, 12.5, null, "2024-03-04"],
    });
    // A table in pounds writes the day first; one date past the 12th settles the rest, in either order.
    expect(positions(parsePositionsFile("Symbol,Quantity,Currency,Purchase Date\nVOD.L,100,GBP,04/03/2024\nBP.L,10,GBP,\n", NOW))["VOD.L"]![3]).toBe("2024-03-04");
    expect(positions(parsePositionsFile("Symbol,Quantity,Currency,Purchase Date\nVOD.L,100,GBP,04/03/2024\nBP.L,10,GBP,01/25/2024\n", NOW))["VOD.L"]![3]).toBe("2024-04-03");
  });

  test("each role takes its most specific column wherever it stands: Trade Date over Date, Average Cost over Cost", () => {
    const file = parsePositionsFile("Date,Symbol,Cost,Quantity,Trade Date,Average Cost\n01/31/2025,AAPL,1500,10,03/01/2024,140\n", NOW);
    expect(positions(file)).toEqual({ AAPL: [10, 140, null, "2024-03-01"] });
  });

  test("an activity or trade history and a file with no positions table say so", () => {
    expect(() => parsePositionsFile("Run Date,Action,Symbol,Description,Quantity,Price,Amount\n01/02/2025,YOU BOUGHT,AAPL,APPLE INC,5,190,-950\n", NOW))
      .toThrow(/activity history/);
    // Buys and sells are not holdings, even under a plain Type column.
    expect(() => parsePositionsFile("Date,Type,Symbol,Quantity,Price\n2024-01-02,Buy,AAPL,10,190\n2024-02-02,Sell,AAPL,4,200\n", NOW))
      .toThrow(/activity history/);
    expect(() => parsePositionsFile("Date,Side,Symbol,Quantity,Price\n2024-01-02,B,AAPL,10,190\n", NOW)).toThrow(/activity history/);
    expect(() => parsePositionsFile("Name,Weight\nApple,50%\n", NOW)).toThrow(PositionsFileError);
  });

  test("a UTF-16 file reads by its byte order mark, and a file not in UTF-8 as Windows-1252", () => {
    const text = "Symbol\tQuantity\tDescription\nAIR.PA\t3\tAirbus Société\n";
    const utf16 = new Uint8Array([0xff, 0xfe, ...[...text].flatMap((char) => [char.charCodeAt(0) & 0xff, char.charCodeAt(0) >> 8])]);
    expect(decodePositionsFile(utf16)).toBe(text);
    expect(decodePositionsFile(new Uint8Array([...Buffer.from("Name,Société\n", "latin1")]))).toBe("Name,Société\n");
    expect(positions(parsePositionsFile(decodePositionsFile(utf16), NOW))).toEqual({ "AIR.PA": [3, null, null, null] });
  });

  test("a cell of any length is read in time, and a file of more positions than an import takes is refused", () => {
    const long = (fill: string) => `"${fill.repeat(100_000)}x"`;
    const started = performance.now();
    const file = parsePositionsFile(`Symbol,Quantity,Avg Cost,Date Acquired\nAAPL,${long("1")},${long("(")},2024-01-01${" ".repeat(100_000)}1\n${long("*")},1,1,\n`, NOW);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(file.skipped.map((row) => [row.label.length <= 60, row.reason])).toEqual([[true, SKIP_REASONS.noShares], [true, SKIP_REASONS.notSymbol]]);

    const rows = Array.from({ length: MAX_IMPORT_POSITIONS + 1 }, (_, index) => `S${index},1`);
    expect(() => parsePositionsFile(`Symbol,Quantity\n${rows.join("\n")}\n`, NOW)).toThrow(/at most 1,000/);
  });

  test("a row whose symbol is not a ticker, one without shares, and rows of one symbol in two currencies are skipped", () => {
    const file = parsePositionsFile("Symbol,Shares,Avg Cost,Currency\nSee note 1,3,10,USD\nAMZN,,180,USD\nNESN,10,90,CHF\nNESN,5,95,EUR\n", NOW);
    expect(file.positions).toEqual([]);
    expect(skipped(file)).toEqual([
      ["See note 1", SKIP_REASONS.notSymbol],
      ["AMZN", SKIP_REASONS.noShares],
      ["NESN", `${SKIP_REASONS.currencies} (CHF, EUR)`],
      ["NESN", `${SKIP_REASONS.currencies} (CHF, EUR)`],
    ]);
  });
});
