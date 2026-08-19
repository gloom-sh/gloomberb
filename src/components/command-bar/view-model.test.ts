import { describe, expect, test } from "bun:test";
import {
  buildSections,
  getRowPresentation,
  rankTickerSearchItems,
  resolveCommandBarMode,
} from "./view-model";
import { commands } from "./commands/registry";

describe("command bar view model helpers", () => {
  test("resolves prefix-driven modes", () => {
    expect(resolveCommandBarMode("")).toMatchObject({ kind: "default", badge: "BROWSE" });
    expect(resolveCommandBarMode("DES NVDA")).toMatchObject({ kind: "search", badge: "DES" });
    expect(resolveCommandBarMode("T NVDA")).toMatchObject({ kind: "search", badge: "T" });
    expect(resolveCommandBarMode("TH ")).toMatchObject({ kind: "themes", badge: "THEMES" });
    expect(resolveCommandBarMode("PL notes")).toMatchObject({ kind: "plugins", badge: "PLUGINS" });
    expect(resolveCommandBarMode("LAY ")).toMatchObject({ kind: "layout", badge: "LAYOUT" });
    expect(resolveCommandBarMode("NP ")).toMatchObject({ kind: "default", badge: "FILTER" });
    expect(resolveCommandBarMode("PS")).toMatchObject({ kind: "direct-command", badge: "COMMAND" });
    expect(resolveCommandBarMode("AW")).toMatchObject({ kind: "direct-command", badge: "COMMAND" });
  });

  test("can resolve modes against a renderer-specific command list", () => {
    const desktopCommands = commands.filter((command) => command.id !== "cycle-chart-renderer");
    expect(resolveCommandBarMode("CR", desktopCommands)).toMatchObject({ kind: "default", badge: "FILTER" });
  });

  test("builds sections while preserving order", () => {
    const sections = buildSections([
      { id: "a", category: "Tickers" },
      { id: "b", category: "Commands" },
      { id: "c", category: "Tickers" },
    ]);

    expect(sections.map((section) => section.category)).toEqual(["Tickers", "Commands"]);
    expect(sections[0]?.items.map((item) => item.id)).toEqual(["a", "c"]);
  });

  test("moves danger and debug sections to the end", () => {
    const sections = buildSections([
      { id: "a", category: "Tickers" },
      { id: "b", category: "Danger" },
      { id: "c", category: "Debug" },
      { id: "d", category: "Config" },
    ]);

    expect(sections.map((section) => section.category)).toEqual(["Tickers", "Config", "Danger", "Debug"]);
  });

  test("drops an offer-only section below real matches even when its category leads", () => {
    const sections = buildSections([
      { id: "assist:sign-up", category: "Ask AI", disabled: true, defaultSelectable: false },
      { id: "holders", category: "Panes" },
    ]);

    expect(sections.map((section) => section.category)).toEqual(["Panes", "Ask AI"]);
    expect(sections[0]?.items[0]?.id).toBe("holders");
  });

  test("keeps an answered AI section leading the list", () => {
    const sections = buildSections([
      { id: "assist:candidate:0", category: "Ask AI" },
      { id: "holders", category: "Panes" },
    ]);

    expect(sections.map((section) => section.category)).toEqual(["Ask AI", "Panes"]);
  });

  test("keeps non-exact ticker suggestions behind app sections in app-first order", () => {
    const sections = buildSections([
      { id: "pane", category: "Panes" },
      { id: "primary", category: "Primary Listing" },
      { id: "other", category: "Other Listings" },
      { id: "fund", category: "Funds & Derivatives" },
      { id: "saved", category: "Saved" },
      { id: "exact", category: "Exact Match" },
    ], { sectionOrder: "app-first" });

    expect(sections.map((section) => section.category)).toEqual([
      "Exact Match",
      "Panes",
      "Saved",
      "Primary Listing",
      "Other Listings",
      "Funds & Derivatives",
    ]);
  });

  test("orders ticker sections by their best-ranked candidate", () => {
    const sections = buildSections([
      { id: "primary", category: "Primary Listing" },
      { id: "saved-alternate", category: "Saved" },
      { id: "other", category: "Other Listings" },
      { id: "saved-fallback", category: "Saved" },
      { id: "fund", category: "Funds & Derivatives" },
    ], { sectionOrder: "ranked" });

    expect(sections.map((section) => section.category)).toEqual([
      "Primary Listing",
      "Saved",
      "Other Listings",
      "Funds & Derivatives",
    ]);
    expect(sections.flatMap((section) => section.items.map((item) => item.id))).toEqual([
      "primary",
      "saved-alternate",
      "saved-fallback",
      "other",
      "fund",
    ]);
  });

  test("derives row presentation for toggles and current rows", () => {
    expect(getRowPresentation({
      id: "plugin:news",
      label: "News",
      detail: "Latest headlines",
      category: "Plugins",
      kind: "plugin",
      checked: true,
    }, false, true)).toMatchObject({
      glyph: " ",
      trailing: "on",
      primaryMuted: false,
    });

    expect(getRowPresentation({
      id: "current:amber",
      label: "Amber",
      detail: "Warm terminal palette",
      category: "Config",
      kind: "command",
      right: "amber",
      current: true,
    }, false, true)).toMatchObject({
      glyph: " ",
      trailing: "current",
    });
  });

  test("ranks ticker search matches by symbol relevance and hides duplicate open symbols", () => {
    const items = rankTickerSearchItems([
      {
        id: "search:IVSX",
        label: "IVSX",
        detail: "Invsivx Holdings | ETF",
        category: "Search Results",
        kind: "search",
        right: "NYSE",
      },
      {
        id: "goto:AAPL",
        label: "AAPL",
        detail: "Apple Inc.",
        category: "Open",
        kind: "ticker",
        right: "NASDAQ",
      },
      {
        id: "search:APP",
        label: "APP",
        detail: "AppLovin Corp | EQUITY",
        category: "Search Results",
        kind: "search",
        right: "NASDAQ",
      },
      {
        id: "search:AAPL",
        label: "AAPL",
        detail: "Apple Inc | EQUITY",
        category: "Search Results",
        kind: "search",
        right: "NASDAQ",
      },
    ], "appl");

    expect(items.map((item) => item.id)).toEqual([
      "goto:AAPL",
      "search:APP",
    ]);
  });
});
