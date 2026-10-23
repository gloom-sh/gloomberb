import { expect, test } from "bun:test";
import { getLoadablePlugins } from "../plugins/catalog";
import { createDefaultConfig } from "../types/config";
import { nearFunctionCodes } from "./pane-functions/catalog";
import { createPaneCatalog } from "./pane-functions/discovery";
import type { MarketContext } from "./types";
import { catalogPointer, tickerPointer, type CatalogCommandHit } from "./unknown-command";

const RV: CatalogCommandHit = { code: "RV", label: "Relative Valuation", argKind: "tickers", argPlaceholder: null, peers: true };
const EQS: CatalogCommandHit = { code: "EQS", label: "Equity Screener", argKind: "none", argPlaceholder: null, peers: false };
const HP: CatalogCommandHit = { code: "HP", label: "Historical Prices", argKind: "ticker", argPlaceholder: null, peers: false };

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
