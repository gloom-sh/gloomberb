import { describe, expect, test } from "bun:test";
import type { CommandDef, PaneTemplateDef } from "../../../../types/plugin";
import { parseRootShortcutIntent, shortcutArgument } from "./shortcuts";

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
    id: "research-search-pane",
    paneId: "research-search",
    label: "Research Search",
    description: "Full-text document search",
    shortcut: { prefix: "SRCH", argPlaceholder: "query", argKind: "text", argOptional: true },
  },
  {
    id: "jobs-pane",
    paneId: "jobs",
    label: "Job Postings",
    description: "JOBS shortcut",
    shortcut: { prefix: "JOBS", argPlaceholder: "ticker", argKind: "ticker", argOptional: true },
  },
  {
    id: "cds-pane",
    paneId: "cds",
    label: "Single-Name CDS",
    description: "CDS shortcut",
    shortcut: { prefix: "CDS", aliases: ["CDSW"], argPlaceholder: "ticker", argKind: "ticker", argOptional: true, focusedIssuer: true },
  },
  {
    id: "trace-bonds-pane",
    paneId: "trace-bonds",
    label: "Corporate Bond Tape",
    description: "TRACE shortcut",
    shortcut: { prefix: "TRACE", argKind: "text", argOptional: true, focusedIssuer: true, argPlaceholder: "issuer, symbol or CUSIP" },
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

  test("a required ticker pane uses the prompt ticker when the focused pane has none", () => {
    const intent = parseRootShortcutIntent({
      query: "SEG",
      commands: [],
      paneTemplates: [tickerTemplate("revenue-breakdown-seg", "SEG")],
      activeTicker: null,
      promptTicker: "FLUT",
    });
    expect(intent.kind).toBe("inferred-complete");
    if (intent.kind === "none") throw new Error("Expected shortcut intent");
    expect(intent.completionQuery).toBe("SEG FLUT");
  });

  test("an optional ticker pane does not take the prompt ticker", () => {
    const intent = parseRootShortcutIntent({
      query: "JOBS",
      commands: [],
      paneTemplates,
      activeTicker: null,
      promptTicker: "FLUT",
    });
    expect(intent.kind).toBe("partial");
    if (intent.kind === "none") throw new Error("Expected shortcut intent");
    expect(intent.completionQuery).toBeNull();
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
      expect(intent.template.id).toBe("research-search-pane");
      expect(intent.argText).toBe("apple inc");
      expect(intent.completionQuery).toBeNull();
    }
  });

  test("SRCH without a query remains a document search shortcut", () => {
    const intent = parse("SRCH");
    expect(intent.kind).toBe("partial");
    if (intent.kind === "none") throw new Error("Expected shortcut intent");
    expect(intent.source).toBe("pane-template");
    if (intent.source === "pane-template") {
      expect(intent.template.id).toBe("research-search-pane");
      expect(intent.argText).toBe("");
    }
  });

  test("optional ticker shortcuts do not infer the active ticker", () => {
    const bare = parse("JOBS", "MSFT");
    expect(bare.kind).toBe("partial");
    if (bare.kind === "none") throw new Error("Expected shortcut intent");
    expect(bare.completionQuery).toBeNull();

    const scoped = parse("JOBS ORCL", "MSFT");
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

describe("Bloomberg word order and the issuer in focus", () => {
  const opened = (query: string, activeTicker: string | null = null) => {
    const intent = parse(query, activeTicker);
    if (intent.kind === "none") return null;
    return { prefix: intent.prefix, kind: intent.kind, arg: shortcutArgument(intent) };
  };

  test("a ticker before a function code opens the function on it, a terminal code included", () => {
    // 2 Nov 2026: `NFE CDS` and `NFE US Equity CDS` offered only Ask AI.
    expect(opened("NFE CDS")).toEqual({ prefix: "CDS", kind: "complete", arg: "NFE" });
    expect(opened("nfe us equity cds")).toEqual({ prefix: "CDS", kind: "complete", arg: "NFE" });
    expect(opened("NFE US Equity CDSW")).toEqual({ prefix: "CDSW", kind: "complete", arg: "NFE" });
    expect(opened("VOD LN GP")).toEqual({ prefix: "GP", kind: "complete", arg: "VOD:LSE" });
    expect(opened("AMD GF")).toEqual({ prefix: "GF", kind: "complete", arg: "AMD" });
    expect(opened("NFE TRACE")).toEqual({ prefix: "TRACE", kind: "complete", arg: "NFE" });
    // A name, a search's text argument or a code alone stays as typed.
    expect(opened("new fortress cds")).toBeNull();
    expect(opened("apple SRCH")).toBeNull();
    expect(opened("CDS NFE")).toEqual({ prefix: "CDS", kind: "complete", arg: "NFE" });
  });

  test("an issuer's function opens on the ticker in focus, and market-wide with none", () => {
    expect(opened("CDS", "NFE")).toEqual({ prefix: "CDS", kind: "inferred-complete", arg: "NFE" });
    expect(opened("TRACE", "NFE")).toEqual({ prefix: "TRACE", kind: "inferred-complete", arg: "NFE" });
    expect(opened("CDS")).toEqual({ prefix: "CDS", kind: "partial", arg: "" });
    expect(opened("JOBS", "NFE")).toEqual({ prefix: "JOBS", kind: "partial", arg: "" });
  });
});

describe("shortcut aliases", () => {
  const aliased: PaneTemplateDef = { id: "rate-path-pane", paneId: "rate-path", label: "US Rate Path", description: "WIRP",
    shortcut: { prefix: "WIRP", aliases: ["FFIP"] } };
  const withTicker: PaneTemplateDef = { id: "estimate-revisions-em", paneId: "estimate-revisions", label: "Estimate Revisions",
    description: "EM", shortcut: { prefix: "EM", aliases: ["EEO"], argPlaceholder: "ticker", argKind: "ticker" } };

  test("an alias opens the same template as its primary mnemonic", () => {
    for (const query of ["WIRP", "FFIP", "ffip"]) {
      const intent = parseRootShortcutIntent({ query, commands: [], paneTemplates: [aliased], activeTicker: null });
      expect(intent.kind).not.toBe("none");
      if (intent.kind === "none" || intent.source !== "pane-template") throw new Error("Expected a pane-template intent");
      expect(intent.template.id).toBe("rate-path-pane");
    }
  });

  test("an alias carries its argument", () => {
    const intent = parseRootShortcutIntent({ query: "EEO AAPL", commands: [], paneTemplates: [withTicker], activeTicker: null });
    if (intent.kind === "none" || intent.source !== "pane-template") throw new Error("Expected a pane-template intent");
    expect(intent.template.id).toBe("estimate-revisions-em");
    expect(intent.argText).toBe("AAPL");
  });
});
