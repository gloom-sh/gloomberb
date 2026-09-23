import { describe, expect, test } from "bun:test";
import type { ScannerFlowEvent } from "../../../api-client";
import {
  DEFAULT_FLOW_FILTERS,
  compareFlowDesc,
  filterFlowEvents,
  flowEmptyState,
  flowHistoryQuery,
  flowHistorySearch,
  flowRowsSpanDays,
  formatFlowTime,
  keepFlowPrints,
  mergeFlowRows,
  type FlowFilters,
} from "./flow-model";

const NOW = Date.parse("2026-03-02T15:00:00Z");

function event(overrides: Partial<ScannerFlowEvent> = {}): ScannerFlowEvent {
  return {
    id: overrides.id ?? `id-${Math.random()}`,
    at: NOW,
    underlying: "NVDA",
    contract: "NVDA260320C01300000",
    right: "C",
    strike: 1300,
    expiry: "2026-03-20",
    side: "ask",
    kind: "sweep",
    size: 100,
    price: 10,
    premium: 500_000,
    volume: 5000,
    openInterest: 1000,
    volOi: 5,
    iv: 0.6,
    ...overrides,
  };
}

function filters(overrides: Partial<FlowFilters> = {}): FlowFilters {
  return { ...DEFAULT_FLOW_FILTERS, ...overrides };
}

const watchlist = new Set(["NVDA"]);

describe("client-side flow filters", () => {
  test("composes every filter as an AND over the same shared feed", () => {
    const events = [
      event({ id: "keep" }),
      event({ id: "cheap", premium: 100_000 }),
      event({ id: "put", right: "P" }),
      event({ id: "block", kind: "block" }),
      event({ id: "thin-oi", volOi: 0.4 }),
      event({ id: "far", expiry: "2026-12-18" }),
      event({ id: "off-watchlist", underlying: "TSLA" }),
    ];

    const kept = filterFlowEvents(events, filters({
      minPremium: "250000",
      side: "calls",
      kind: "sweeps",
      volOi: "1",
      expiry: "30",
      universe: "watchlist",
    }), watchlist, NOW);

    expect(kept.map((entry) => entry.id)).toEqual(["keep"]);
  });

  test("defaults only apply the premium floor", () => {
    const events = [
      event({ id: "put-block-far", right: "P", kind: "block", expiry: "2027-01-15", volOi: null }),
      event({ id: "small", premium: 60_000 }),
      event({ id: "other-name", underlying: "SPY" }),
    ];
    expect(filterFlowEvents(events, filters(), watchlist, NOW).map((entry) => entry.id))
      .toEqual(["put-block-far", "other-name"]);
  });

  test("drops events with unknown vol/OI only when a floor is set", () => {
    const events = [event({ id: "unknown-oi", volOi: null })];
    expect(filterFlowEvents(events, filters({ volOi: "off" }), watchlist, NOW)).toHaveLength(1);
    expect(filterFlowEvents(events, filters({ volOi: "1" }), watchlist, NOW)).toHaveLength(0);
  });

  test("keeps today's expiry inside a 7 day window and rejects unparsable dates", () => {
    const events = [
      event({ id: "today", expiry: "2026-03-02" }),
      event({ id: "in-7", expiry: "2026-03-09" }),
      event({ id: "in-8", expiry: "2026-03-10" }),
      event({ id: "bad", expiry: "not-a-date" }),
    ];
    expect(filterFlowEvents(events, filters({ expiry: "7" }), watchlist, NOW).map((entry) => entry.id))
      .toEqual(["today", "in-7"]);
  });
});

describe("flow empty state", () => {
  test("blames the filters only when the feed actually sent prints", () => {
    expect(flowEmptyState(12, 0, "live").title).toBe("12 prints hidden by filters.");
    expect(flowEmptyState(1, 0, "live").title).toBe("1 print hidden by filters.");
    // An empty tape is not a filter problem, whatever the filters are set to.
    expect(flowEmptyState(0, 0, "live").title).toBe("No prints on the tape yet.");
    expect(flowEmptyState(0, 0, "closed").hint).toContain("next session");
  });
});

describe("paging below the live tape", () => {
  test("the pane keeps every live print it received, newest first, once each", () => {
    const first = keepFlowPrints([], [event({ id: "b", at: NOW - 1 }), event({ id: "a", at: NOW - 2 })]);
    // The tape rolled: "a" fell off, "c" arrived. The pane still has "a".
    const second = keepFlowPrints(first, [event({ id: "c", at: NOW }), event({ id: "b", at: NOW - 1 })]);
    expect(second.map((entry) => entry.id)).toEqual(["c", "b", "a"]);
    expect(keepFlowPrints(second, [event({ id: "c", at: NOW })])).toBe(second);
    expect(keepFlowPrints(second, [event({ id: "d", at: NOW + 1 })], 2).map((entry) => entry.id)).toEqual(["d", "c"]);
  });

  test("merged rows are newest first with ties in byte order, each print once", () => {
    const live = [event({ id: "opt-b", at: NOW }), event({ id: "opt-a", at: NOW })];
    const older = [event({ id: "opt-a", at: NOW }), event({ id: "opt-z", at: NOW - 5 })];
    expect(mergeFlowRows(live, older).map((entry) => entry.id)).toEqual(["opt-b", "opt-a", "opt-z"]);
    // Matches Postgres' "C" collation, which the server pages by.
    expect([event({ id: "opt-B", at: NOW }), event({ id: "opt-a", at: NOW })].sort(compareFlowDesc).map((entry) => entry.id))
      .toEqual(["opt-a", "opt-B"]);
  });

  test("the pane's filters become the recorded-print query", () => {
    expect(flowHistoryQuery(DEFAULT_FLOW_FILTERS, watchlist)).toEqual({ limit: 100, minPremium: 250_000 });
    expect(flowHistoryQuery(
      filters({ side: "puts", kind: "blocks", volOi: "5", expiry: "7", universe: "watchlist", minPremium: "1000000" }),
      new Set(["nvda", "BRK.B"]),
      { at: NOW, id: "opt-1" },
      50,
    )).toEqual({
      before: { at: NOW, id: "opt-1" },
      limit: 50,
      minPremium: 1_000_000,
      right: "P",
      kind: "block",
      minVolOi: 5,
      maxExpiryDays: 7,
      symbols: ["BRK.B", "NVDA"],
    });
  });

  test("the query goes over the wire as the Cloud route reads it", () => {
    expect(flowHistorySearch({ limit: 100, minPremium: 250_000 })).toBe("limit=100&minPremium=250000");
    expect(new URLSearchParams(flowHistorySearch({
      before: { at: 1_790_183_480_304, id: "opt-1-NVDA-ab-9" },
      limit: 50,
      right: "P",
      kind: "block",
      minVolOi: 5,
      maxExpiryDays: 7,
      symbols: ["BRK.B", "NVDA"],
    })).toString()).toBe(
      "beforeAt=1790183480304&beforeId=opt-1-NVDA-ab-9&limit=50&right=P&kind=block&minVolOi=5&maxExpiryDays=7&universe=symbols&symbols=BRK.B%2CNVDA",
    );
  });

  test("share classes and adjusted contracts match the watchlist by option root", () => {
    const events = [
      event({ id: "brk", underlying: "BRKB" }),
      event({ id: "soxs", underlying: "SOXS1" }),
      event({ id: "amd", underlying: "AMD" }),
    ];
    const visible = filterFlowEvents(events, filters({ universe: "watchlist" }), new Set(["BRK.B", "SOXS"]), NOW);
    expect(visible.map((entry) => entry.id)).toEqual(["brk", "soxs"]);
  });

  test("prints from earlier days show their date", () => {
    const today = new Date(2026, 2, 2, 15, 4, 5).getTime();
    const yesterday = new Date(2026, 2, 1, 9, 31, 0).getTime();
    expect(formatFlowTime(today, today)).toBe("15:04:05");
    expect(formatFlowTime(yesterday, today)).toBe("03/01 09:31");
    expect(flowRowsSpanDays([event({ at: today })], today)).toBe(false);
    expect(flowRowsSpanDays([event({ at: today }), event({ at: yesterday })], today)).toBe(true);
  });
});
