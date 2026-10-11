import { expect, test } from "bun:test";
import { knownGapMessage } from "./known-gaps";
import { buildSearchReport } from "./commands/search";
import { renderPaneCatalogReport } from "./pane-functions/catalog";
import { parsePaneCatalogArgs } from "./pane-functions/options";
import { lookupGlossary } from "./glossary";

test("data a name search cannot find is pointed to, with its proxies, by search and catalog, instead of each pointing at the other", () => {
  const gap = "EU carbon (EUA): the auction price is in EPWR, chart CAP:carbon:eua. Traded proxies: CO2:LSE, KRBN.";
  expect(["EUA", "carbon allowances", "EU-ETS", "Carbon"].map(knownGapMessage)).toEqual([gap, gap, gap, gap]);
  expect(knownGapMessage("carbon fiber")).toBeNull();

  const search = buildSearchReport({ query: "carbon allowances", candidates: [] });
  expect(search).toContain(gap);
  expect(search).not.toContain("catalog");
  const catalog = renderPaneCatalogReport([], parsePaneCatalogArgs(["EUA"]), lookupGlossary("EUA"), knownGapMessage("EUA"));
  expect(catalog).toContain(gap);
  expect(catalog).toContain("EU Allowance");
  expect(catalog).not.toContain("No functions match");
});
