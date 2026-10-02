import { describe, expect, test } from "bun:test";
import { browserBuiltinPlugins } from "./catalog-browser";
import { getLoadablePlugins } from "./catalog";

const ids = browserBuiltinPlugins.map((plugin) => plugin.id);
const paneIds = browserBuiltinPlugins.flatMap((plugin) => plugin.panes?.map((pane) => pane.id) ?? []);
const templateIds = new Set(browserBuiltinPlugins.flatMap((plugin) => plugin.paneTemplates?.map((template) => template.id) ?? []));

describe("browser plugin catalog", () => {
  test("excludes native, filesystem, and debug plugins", () => {
    for (const forbidden of ["broker", "notes", "debug"]) {
      expect(ids).not.toContain(forbidden);
    }
  });

  test("keeps every public pane handoff restorable in the hosted browser", () => {
    const unavailable = getLoadablePlugins()
      .flatMap((plugin) => plugin.paneTemplates ?? [])
      .filter((template) => template.publicShare && !templateIds.has(template.id))
      .map((template) => template.id);
    expect(unavailable).toEqual([]);
  });

  test("omits unsupported modules inside otherwise browser-safe product areas", () => {
    expect(paneIds).toEqual(expect.arrayContaining([
      "ticker-research",
      "chart-composer",
      "options-calculator",
      "ticker-news",
      // Shared wire panes and filings must open on the hosted terminal too.
      "news-top",
      "news-feed",
      "news-breaking",
      "news-industry",
      "sec",
      "insider",
      "world-indices",
      "econ-calendar",
      "treasury-auctions",
      "dividend-yield",
    ]));
    for (const forbidden of [
      "buildout",
      "market-movers",
      "earnings-calendar",
      "short-interest",
      "thirteenf-funds",
    ]) {
      expect(paneIds).not.toContain(forbidden);
    }
  });
});
