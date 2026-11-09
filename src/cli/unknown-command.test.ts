import { expect, test } from "bun:test";
import { getLoadablePlugins } from "../plugins/catalog";
import { createDefaultConfig } from "../types/config";
import { nearFunctionCodes } from "./pane-functions/catalog";
import { createPaneCatalog } from "./pane-functions/discovery";
import type { MarketContext } from "./types";
import { catalogPointer, currencyWordPair, subcommandPointer, tickerPointer, unknownCommandReply, type CatalogCommandHit } from "./unknown-command";

const RV: CatalogCommandHit = { code: "RV", label: "Relative Valuation", argKind: "tickers", argPlaceholder: null, peers: true };
const EQS: CatalogCommandHit = { code: "EQS", label: "Equity Screener", argKind: "none", argPlaceholder: null, peers: false };
const HP: CatalogCommandHit = { code: "HP", label: "Historical Prices", argKind: "ticker", argPlaceholder: null, peers: false, takesFx: true };

test("a word the catalog knows points at its function, run with what was typed after it", () => {
  // One ticker meets a function that picks peers: the switch comes along.
  expect(catalogPointer("peers", [RV], ["DUOL"])).toBe("Try `gloom fn RV DUOL --peers` (Relative Valuation). `gloom catalog peers` lists more.");
  expect(catalogPointer("comps", [RV], ["DUOL", "COUR"])).toContain("`gloom fn RV DUOL COUR` (Relative Valuation)");
  // A company's name is no ticker: the placeholder, and the search that finds it.
  expect(catalogPointer("comps", [RV], ["duolingo"]))
    .toBe("Try `gloom fn RV <ticker> --peers` (Relative Valuation); `gloom search duolingo` finds the ticker. `gloom catalog comps` lists more.");
  expect(catalogPointer("comps", [RV], [])).toContain("`gloom fn RV <tickers>`");
});

test("several functions are listed with the catalog search, and none says nothing", () => {
  expect(catalogPointer("screener", [EQS, HP], ["AAPL"])).toBe([
    "Closest functions:",
    "  gloom fn EQS      Equity Screener",
    "  gloom fn HP AAPL  Historical Prices",
    "Search the catalog: gloom catalog screener",
  ].join("\n"));
  expect(catalogPointer("zzqx", [], ["AAPL"])).toBeNull();
});

test("a currency or a pair typed as a command points at quote and fx, and one typed after a function word runs", () => {
  const none = { fn: null, nearFn: null, hits: [], args: [] };
  // `eurusd` alone was a bare "Unknown command".
  expect(unknownCommandReply("eurusd", [], none, null)).toEqual({ message: 'Unknown command "eurusd": it reads as EUR/USD.',
    details: "To quote it: gloom quote EURUSD=X\nRate, conversion and forwards: gloom fx EUR/USD\nRun gloom help to see every command." });
  // Any spelling, a code as its dollar pair the way markets quote it, a name only one currency has; the dollar alone is no pair.
  expect(["EUR/USD", "eurusd=x", "eur", "JPY", "yen"].map((word) => currencyWordPair(word)?.listing))
    .toEqual(["EURUSD=X", "EURUSD=X", "EURUSD=X", "USDJPY=X", "USDJPY=X"]);
  for (const word of ["usd", "comps", "people", "try", "PLTR"]) expect(currencyWordPair(word), word).toBeNull();
  // `skew eur` offered `gloom fn OVDV eur`, which fails: the currency is its pair, and a function that refuses the pair
  // (FX volatility) takes the fund whose options stand in.
  const OVDV: CatalogCommandHit = { code: "OVDV", label: "Volatility Surface", argKind: "ticker", argPlaceholder: null, peers: false,
    refusesSymbol: (key) => key === "EURUSD=X" };
  expect(catalogPointer("skew", [OVDV, HP], ["eur"])).toBe([
    "Closest functions:",
    "  gloom fn OVDV FXE     Volatility Surface",
    "  gloom fn HP EURUSD=X  Historical Prices",
    "FXE's options stand in for EUR/USD: OTC FX volatility is not covered.",
    "Search the catalog: gloom catalog skew",
  ].join("\n"));
});

test("a code in capitals that is also a ticker keeps its ticker answer, and only a function that takes FX rewrites a currency", () => {
  const none = { fn: null, nearFn: null, hits: [], args: [] };
  // COP is ConocoPhillips and NOK Nokia: quote and search first, then the pair.
  expect(unknownCommandReply("COP", [], none, null)).toEqual({ message: 'Unknown command "COP".', details: [
    "To quote it: gloom quote COP", "Find the ticker: gloom search COP",
    "As a currency it reads as USD/COP: gloom quote USDCOP=X", "Rate, conversion and forwards: gloom fx USD/COP",
    "Run gloom help to see every command.",
  ].join("\n") });
  expect(unknownCommandReply("NOK", [], none, null).details).toStartWith("To quote it: gloom quote NOK\nFind the ticker: gloom search NOK\n"
    + "As a currency it reads as USD/NOK: gloom quote USDNOK=X");
  // Typed in lowercase it is the currency.
  expect(unknownCommandReply("nok", [], none, null).message).toBe('Unknown command "nok": it reads as USD/NOK.');
  // A function word with a code in capitals keeps it as typed: Nokia's peers, Nokia's prices.
  expect(catalogPointer("peers", [RV], ["NOK"])).toBe("Try `gloom fn RV NOK --peers` (Relative Valuation). `gloom catalog peers` lists more.");
  expect(catalogPointer("prices", [HP], ["NOK"])).toContain("`gloom fn HP NOK`");
  // In lowercase, only a function that takes FX writes it as the pair; Relative Valuation keeps the word.
  expect(catalogPointer("prices", [HP], ["nok"])).toContain("`gloom fn HP USDNOK=X`");
  expect(catalogPointer("peers", [RV], ["nok"])).toContain("`gloom fn RV nok --peers`");
});

test("a ticker typed as a command is pointed at quote and search, and taken for no function code", async () => {
  expect(tickerPointer("PLTR")).toBe("To quote it: gloom quote PLTR\nFind the ticker: gloom search PLTR");
  for (const ticker of ["BRK.B", "BTC-USD", "^GSPC", "7203:TSE"]) expect(tickerPointer(ticker), ticker).toContain(`gloom quote ${ticker}`);
  // A command word is lowercase: `comps` keeps only the catalog's answer.
  expect(tickerPointer("comps")).toBeNull();
  expect(tickerPointer("2024")).toBeNull();

  const context = { config: createDefaultConfig("/tmp/unknown-command-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    // Most are one slip from a code (CLTR, BETA, QQ, PF, BT); typed as a command, none is read as one.
    for (const ticker of ["PLTR", "META", "QQQ", "PFE", "BTC", "AAPL", "NVDA", "TSLA"]) {
      expect(nearFunctionCodes(registry, ticker, { commandWord: true }), ticker).toEqual([]);
    }
    expect(nearFunctionCodes(registry, "PLTR").map(({ code }) => code)).toContain("CLTR");
    // A slip from a code that keeps its first letter still is, as a command or after `fn`.
    expect(nearFunctionCodes(registry, "RCDF", { commandWord: true })).toEqual([{ code: "RDCF", label: "Reverse DCF" }]);
    expect(nearFunctionCodes(registry, "RCDF")).toEqual([{ code: "RDCF", label: "Reverse DCF" }]);
  } finally {
    registry.destroy();
  }
});

test("a subcommand typed without its command points at the command it belongs to, run with what was typed", () => {
  const commands = [
    { name: "portfolio", usage: ["portfolio show <name>", "portfolio add <portfolio> <symbols...>", "portfolio position set <portfolio> <symbol> <shares> <avg-cost>"] },
    { name: "watchlist", usage: ["watchlist add <name> <symbols...>"] },
    { name: "fn", usage: ["fn <function> [argument]"] },
  ];
  expect(subcommandPointer("position", ["set", "Izmir", "THYAO", "100", "280"], commands)).toEqual({
    owners: ["portfolio"], run: ["gloom portfolio position set Izmir THYAO 100 280"],
  });
  expect(subcommandPointer("add", ["Izm", "Turk Hava Yollari"], commands)?.run).toEqual([
    'gloom portfolio add Izm "Turk Hava Yollari"', 'gloom watchlist add Izm "Turk Hava Yollari"',
  ]);
  // A word that is only an argument in a usage line, or a placeholder, belongs to no command.
  expect(subcommandPointer("set", [], commands)).toBeNull();
  expect(subcommandPointer("<function>", [], commands)).toBeNull();
});

// `gloom export LMT` lost its --csv/--json answer, and `gloom CASH` its ticker answer, to the subcommand pointer.
test("an unknown word is a subcommand only after it is no export, bank figure or ticker", () => {
  const commands = [
    { name: "notes", usage: ["notes show <symbol>", "notes export [dir]"] },
    { name: "portfolio", usage: ["portfolio cash set <portfolio> <amount> [currency]"] },
    { name: "fundamentals", usage: ["fundamentals nim <symbol>"] },
  ];
  const reply = (token: string, args: string[]) =>
    unknownCommandReply(token, commands, { fn: null, nearFn: null, hits: [], args }, null);
  expect(reply("export", ["LMT"])).toEqual({
    message: 'Unknown command "export".',
    details: expect.stringContaining("e.g. gloom history LMT --csv --output lmt.csv"),
  });
  expect(reply("CASH", [])).toEqual({
    message: 'Unknown command "CASH".',
    details: expect.stringContaining("To quote it: gloom quote CASH"),
  });
  expect(reply("nim", ["JPM"]).message).toBe('Unknown command "nim": a bank\'s figures are in the Bank section of fundamentals.');
  // Typed as words, they still lead to the command they belong to.
  expect(reply("cash", ["set", "Izmir", "1000"])).toEqual({
    message: 'Unknown command "cash": it is a subcommand of portfolio.',
    details: "Run: gloom portfolio cash set Izmir 1000",
  });
  expect(reply("show", ["AAPL"]).message).toBe('Unknown command "show": it is a subcommand of notes.');
});
