import { describe, expect, test } from "bun:test";
import type { CloudThesis, ThesisDocument } from "../../../../api-client";
import {
  attentionReason,
  bookAtRisk,
  catalystState,
  computeHealth,
  convictionRows,
  reviewDue,
  sortForBoard,
  parseSymbolList,
  thesesInScope,
  thesisExposure,
  untrackedRows,
} from "./model";
import type { TickerRecord } from "../../../../types/ticker";

const NOW = Date.parse("2026-09-16T12:00:00Z");

function document(overrides: Partial<ThesisDocument> = {}): ThesisDocument {
  return {
    summary: "",
    instruments: [{ symbol: "NVDA", side: "long", role: "core" }],
    evidence: { symbols: [], keywords: [] },
    pillars: [{ id: "p1", text: "grows", kind: "qualitative", status: "intact" }],
    killConditions: [],
    catalysts: [],
    ...overrides,
  };
}

function thesis(overrides: Partial<CloudThesis> = {}): CloudThesis {
  const doc = overrides.document ?? document();
  return {
    id: overrides.id ?? "t1",
    owner: { kind: "user", id: "u" },
    title: "NVDA",
    status: "active",
    conviction: 5,
    horizon: null,
    reviewEveryDays: 90,
    outcome: null,
    revision: 1,
    openSignals: 0,
    createdBy: "u",
    updatedBy: { id: "u", username: "v", displayName: "V" },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    reviewedAt: null,
    closedAt: null,
    ...overrides,
    document: doc,
    health: computeHealth(doc),
  };
}

function ticker(symbol: string, shares: number, multiplier?: number): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "NASDAQ",
      currency: "USD",
      name: symbol,
      portfolios: ["main"],
      watchlists: [],
      positions: shares ? [{ portfolio: "main", shares, broker: "manual", ...(multiplier ? { multiplier } : {}) }] : [],
      custom: {},
      tags: [],
    },
  };
}

describe("attention and board order", () => {
  test("open signals outrank health, which outranks a due review", () => {
    const signals = thesis({ id: "a", openSignals: 2 });
    const broken = thesis({ id: "b", document: document({ killConditions: [{ id: "k", text: "x", triggered: true }] }) });
    const stale = thesis({ id: "c", createdAt: "2026-01-01T00:00:00.000Z" });
    const fine = thesis({ id: "d", reviewedAt: "2026-09-10T00:00:00.000Z" });
    const watching = thesis({ id: "e", status: "watching", reviewedAt: "2026-09-10T00:00:00.000Z" });
    const closed = thesis({ id: "f", status: "closed" });
    expect(attentionReason(signals, NOW)).toBe("signals");
    expect(attentionReason(broken, NOW)).toBe("broken");
    expect(attentionReason(stale, NOW)).toBe("review");
    expect(attentionReason(fine, NOW)).toBeNull();
    expect(reviewDue(closed, NOW)).toBe(false);
    expect(sortForBoard([closed, fine, watching, stale, signals, broken], NOW).map((entry) => entry.id)).toEqual([
      "b", "a", "c", "d", "e", "f",
    ]);
  });

  test("a slipped catalyst asks for attention", () => {
    const slipped = thesis({
      reviewedAt: "2026-09-10T00:00:00.000Z",
      document: document({ catalysts: [{ id: "c", text: "FDA", date: "2026-09-01", status: "pending" }] }),
    });
    expect(catalystState(slipped.document.catalysts[0]!, NOW)).toBe("passed");
    expect(attentionReason(slipped, NOW)).toBe("catalyst");
    expect(catalystState({ id: "c", text: "Q3", date: "2026-09-25", status: "pending" }, NOW)).toBe("due");
    expect(catalystState({ id: "c", text: "Q3", date: "2026-12-25", status: "pending" }, NOW)).toBe("pending");
  });
});

describe("portfolio integration", () => {
  const exposure = new Map([
    ["NVDA", { symbol: "NVDA", value: 60_000, optionNotional: 0, hasOptions: false }],
    ["AMD", { symbol: "AMD", value: 20_000, optionNotional: 0, hasOptions: false }],
    ["SPY", { symbol: "SPY", value: 20_000, optionNotional: 0, hasOptions: false }],
  ]);

  test("exposure sums held instruments and subtracts hedges", () => {
    const paired = thesis({
      document: document({
        instruments: [
          { symbol: "NVDA", side: "long", role: "core" },
          { symbol: "SPY", side: "short", role: "hedge" },
        ],
      }),
    });
    const result = thesisExposure(paired, exposure, 100_000);
    expect(result.value).toBe(40_000);
    expect(result.weight).toBe(0.4);
  });

  test("book at risk counts only weakening and broken theses", () => {
    const weak = thesis({ id: "w", document: document({ pillars: [{ id: "p", text: "x", kind: "qualitative", status: "weakening" }] }) });
    const ok = thesis({ id: "o", document: document({ instruments: [{ symbol: "AMD", side: "long", role: "core" }] }) });
    const rows = [thesisExposure(weak, exposure, 100_000), thesisExposure(ok, exposure, 100_000)];
    expect(bookAtRisk(rows)).toBe(0.6);
  });

  test("conviction rows rank conviction against weight", () => {
    const big = thesis({ id: "big", conviction: 3 });
    const small = thesis({ id: "small", conviction: 9, document: document({ instruments: [{ symbol: "AMD", side: "long", role: "core" }] }) });
    const rows = convictionRows([thesisExposure(big, exposure, 100_000), thesisExposure(small, exposure, 100_000)]);
    expect(rows.map((row) => [row.thesis.id, row.gap])).toEqual([
      ["big", -1],
      ["small", 1],
    ]);
  });

  test("untracked rows are positions no open thesis holds, biggest first, with names", () => {
    const tickers = [ticker("NVDA", 10), ticker("AMD", 5), ticker("TSM", 3), ticker("AAPL", 1)];
    const closedAmd = thesis({ id: "c", status: "closed", document: document({ instruments: [{ symbol: "AMD", side: "long", role: "core" }] }) });
    const exposure = new Map([
      ["AMD", { symbol: "AMD", value: 5_000, optionNotional: 0, hasOptions: false }],
      ["TSM", { symbol: "TSM", value: 20_000, optionNotional: 0, hasOptions: false }],
      ["AAPL", { symbol: "AAPL", value: Number.NaN, optionNotional: 0, hasOptions: false }],
    ]);
    const rows = untrackedRows(tickers, [thesis(), closedAmd], exposure, 100_000, (symbol) => (symbol === "TSM" ? "Taiwan Semiconductor" : null));
    expect(rows.map((row) => [row.symbol, row.name, row.weight])).toEqual([
      ["TSM", "Taiwan Semiconductor", 0.2],
      ["AMD", null, 0.05],
      ["AAPL", null, 0],
    ]);
  });

  test("a scope keeps the theses holding something in it", () => {
    const amd = thesis({ id: "amd", document: document({ instruments: [{ symbol: "AMD", side: "long", role: "core" }] }) });
    expect(thesesInScope([thesis(), amd], new Set(["AMD"])).map((entry) => entry.id)).toEqual(["amd"]);
    expect(thesesInScope([thesis(), amd], null)).toHaveLength(2);
  });

  test("a typed ticker list splits on spaces and commas", () => {
    expect(parseSymbolList("NVDA,AMD")).toEqual(["NVDA", "AMD"]);
    expect(parseSymbolList(" nvda  amd; nvda ")).toEqual(["NVDA", "AMD"]);
    expect(parseSymbolList("")).toEqual([]);
  });
});
