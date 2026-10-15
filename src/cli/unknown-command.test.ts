import { expect, test } from "bun:test";
import { catalogPointer, type CatalogCommandHit } from "./unknown-command";

const RV: CatalogCommandHit = { code: "RV", label: "Relative Valuation", argKind: "tickers", argPlaceholder: null, peers: true };
const EQS: CatalogCommandHit = { code: "EQS", label: "Equity Screener", argKind: "none", argPlaceholder: null, peers: false };
const HP: CatalogCommandHit = { code: "HP", label: "Historical Prices", argKind: "ticker", argPlaceholder: null, peers: false };

test("a word the catalog knows points at its function, run with what was typed after it", () => {
  // One ticker meets a function that picks peers: the switch comes along.
  expect(catalogPointer("peers", [RV], ["DUOL"])).toBe("Try `gloomberb fn RV DUOL --peers` (Relative Valuation). `gloomberb catalog peers` lists more.");
  expect(catalogPointer("comps", [RV], ["DUOL", "COUR"])).toContain("`gloomberb fn RV DUOL COUR` (Relative Valuation)");
  // A company's name is no ticker: the placeholder, and the search that finds it.
  expect(catalogPointer("comps", [RV], ["duolingo"]))
    .toBe("Try `gloomberb fn RV <ticker> --peers` (Relative Valuation); `gloomberb search duolingo` finds the ticker. `gloomberb catalog comps` lists more.");
  expect(catalogPointer("comps", [RV], [])).toContain("`gloomberb fn RV <tickers>`");
});

test("several functions are listed with the catalog search, and none says nothing", () => {
  expect(catalogPointer("screener", [EQS, HP], ["AAPL"])).toBe([
    "Closest functions:",
    "  gloomberb fn EQS      Equity Screener",
    "  gloomberb fn HP AAPL  Historical Prices",
    "Search the catalog: gloomberb catalog screener",
  ].join("\n"));
  expect(catalogPointer("zzqx", [], ["AAPL"])).toBeNull();
});
