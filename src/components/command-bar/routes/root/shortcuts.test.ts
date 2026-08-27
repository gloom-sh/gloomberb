import { describe, expect, test } from "bun:test";
import type { CommandDef, PaneTemplateDef } from "../../../../types/plugin";
import { parseRootShortcutIntent } from "./shortcuts";

function tickerTemplate(id: string, prefix: string): PaneTemplateDef {
  return {
    id,
    paneId: "ticker-detail",
    label: prefix,
    description: `${prefix} shortcut`,
    shortcut: { prefix, argPlaceholder: "ticker", argKind: "ticker" },
  };
}

const paneTemplates: PaneTemplateDef[] = [
  tickerTemplate("financial-analysis-pane", "FA"),
  tickerTemplate("graph-price-pane", "GP"),
  tickerTemplate("graph-intraday-price-pane", "GIP"),
  tickerTemplate("historical-prices-pane", "HP"),
  {
    id: "fundamental-graph-pane",
    paneId: "fundamental-graph",
    label: "Fundamental Graph",
    description: "GF shortcut",
    shortcut: { prefix: "GF", argPlaceholder: "tickers", argKind: "ticker-list" },
  },
  {
    id: "valuation-graph-pane",
    paneId: "fundamental-graph",
    label: "Valuation Graph",
    description: "GE shortcut",
    shortcut: { prefix: "GE", argPlaceholder: "tickers", argKind: "ticker-list" },
  },
  {
    id: "relationship-graph-pane",
    paneId: "relationship-graph",
    label: "Relationship Graph",
    description: "GR shortcut",
    shortcut: { prefix: "GR", argPlaceholder: "tickers", argKind: "ticker-list" },
  },
  tickerTemplate("earnings-estimates-pane", "EE"),
  {
    id: "provider-search-pane",
    paneId: "provider-search-results",
    label: "Provider Search",
    description: "Search provider instruments",
    shortcut: { prefix: "SRCH", argPlaceholder: "query", argKind: "text" },
  },
  {
    id: "cds-pane",
    paneId: "cds",
    label: "Single-Name CDS",
    description: "CDS shortcut",
    shortcut: { prefix: "CDS", argPlaceholder: "ticker", argKind: "ticker", argOptional: true },
  },
];

const pluginCommands: CommandDef[] = [{
  id: "earnings-monitor-shortcut",
  label: "Earnings Monitor",
  keywords: ["earnings", "monitor"],
  shortcut: "EM",
  shortcutArg: { placeholder: "tickers", kind: "text" },
  category: "data",
  execute: () => {},
}];

function parse(query: string, activeTicker: string | null = null) {
  return parseRootShortcutIntent({
    query,
    commands: [],
    pluginCommands,
    paneTemplates,
    activeTicker,
  });
}

describe("ticker data root shortcuts", () => {
  test.each([
    ["FA AAPL", "financial-analysis-pane"],
    ["GP AAPL", "graph-price-pane"],
    ["GIP AAPL", "graph-intraday-price-pane"],
    ["HP AAPL", "historical-prices-pane"],
    ["GF AAPL", "fundamental-graph-pane"],
    ["GE AAPL", "valuation-graph-pane"],
    ["GR AAPL", "relationship-graph-pane"],
    ["EE AAPL", "earnings-estimates-pane"],
  ])("%s resolves to its ticker pane template", (query, templateId) => {
    const intent = parse(query);
    expect(intent.kind).toBe("complete");
    if (intent.kind === "none") throw new Error("Expected shortcut intent");
    expect(intent.source).toBe("pane-template");
    if (intent.source === "pane-template") {
      expect(intent.template.id).toBe(templateId);
      expect(intent.argText).toBe("AAPL");
    }
  });

  test("ticker pane shortcuts can infer the active ticker", () => {
    const intent = parse("GP", "MSFT");
    expect(intent.kind).toBe("inferred-complete");
    if (intent.kind === "none") throw new Error("Expected shortcut intent");
    expect(intent.completionQuery).toBe("GP MSFT");
  });

  test("GF accepts multiple tickers", () => {
    const intent = parse("GF AMD,NVDA");
    expect(intent.kind).toBe("complete");
    if (intent.kind === "none") throw new Error("Expected shortcut intent");
    expect(intent.source).toBe("pane-template");
    expect(intent.argText).toBe("AMD,NVDA");
  });

  test("GR accepts a ticker pair", () => {
    const intent = parse("GR AMD,NVDA");
    expect(intent.kind).toBe("complete");
    if (intent.kind === "none") throw new Error("Expected shortcut intent");
    expect(intent.source).toBe("pane-template");
    expect(intent.argText).toBe("AMD,NVDA");
  });

  test("SRCH keeps its text query instead of resolving a ticker", () => {
    const intent = parse("SRCH apple inc", "AAPL");
    expect(intent.kind).toBe("complete");
    if (intent.kind === "none") throw new Error("Expected shortcut intent");
    expect(intent.source).toBe("pane-template");
    if (intent.source === "pane-template") {
      expect(intent.template.id).toBe("provider-search-pane");
      expect(intent.argText).toBe("apple inc");
      expect(intent.completionQuery).toBeNull();
    }
  });

  test("SRCH without a query remains a provider search shortcut", () => {
    const intent = parse("SRCH");
    expect(intent.kind).toBe("partial");
    if (intent.kind === "none") throw new Error("Expected shortcut intent");
    expect(intent.source).toBe("pane-template");
    if (intent.source === "pane-template") {
      expect(intent.template.id).toBe("provider-search-pane");
      expect(intent.argText).toBe("");
    }
  });

  test("optional ticker shortcuts do not infer the active ticker", () => {
    const bare = parse("CDS", "MSFT");
    expect(bare.kind).toBe("partial");
    if (bare.kind === "none") throw new Error("Expected shortcut intent");
    expect(bare.completionQuery).toBeNull();

    const scoped = parse("CDS ORCL", "MSFT");
    expect(scoped.kind).toBe("complete");
    if (scoped.kind === "none") throw new Error("Expected shortcut intent");
    expect(scoped.argText).toBe("ORCL");
  });

  test("EM accepts optional text tickers without active ticker inference", () => {
    const bare = parse("EM", "AAPL");
    expect(bare.kind).toBe("partial");
    if (bare.kind === "none") throw new Error("Expected shortcut intent");
    expect(bare.source).toBe("plugin-command");
    expect(bare.completionQuery).toBeNull();

    const scoped = parse("EM AAPL,MSFT");
    expect(scoped.kind).toBe("complete");
    if (scoped.kind === "none") throw new Error("Expected shortcut intent");
    expect(scoped.source).toBe("plugin-command");
    expect(scoped.argText).toBe("AAPL,MSFT");
  });
});
