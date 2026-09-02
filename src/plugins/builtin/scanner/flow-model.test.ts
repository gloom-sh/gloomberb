import { describe, expect, test } from "bun:test";
import type { ScannerFlowEvent } from "../../../api-client";
import { DEFAULT_FLOW_FILTERS, filterFlowEvents, flowEmptyState, type FlowFilters } from "./flow-model";

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
