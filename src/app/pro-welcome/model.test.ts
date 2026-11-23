import { describe, expect, test } from "bun:test";
import { createTestTicker } from "../../test-support/ticker";
import { createDefaultConfig, type AppConfig } from "../../types/config";
import type { TickerRecord } from "../../types/ticker";
import { openedFunctions, ownTickers, pickProWelcomeChips, proWelcomeEligible } from "./model";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const DAY = 86_400_000;
const PAYING = { isPayingPro: true, isTrialActive: false };

function eligible(overrides: Partial<Parameters<typeof proWelcomeEligible>[0]> = {}, chargedDaysAgo = 3) {
  return proWelcomeEligible({
    access: PAYING,
    plan: { firstChargeAt: new Date(NOW - chargedDaysAgo * DAY).toISOString(), proTeam: null },
    dismissed: false,
    now: NOW,
    ...overrides,
  });
}

describe("who sees the Pro row", () => {
  test("a payer of their own plan from the day of the first charge through day 14", () => {
    expect(eligible({}, 0)).toBe(true);
    // A charge a moment ahead of this machine's clock is today's.
    expect(eligible({}, -0.01)).toBe(true);
    expect(eligible({}, 14)).toBe(true);
    expect(eligible({}, 14.99)).toBe(true);
    expect(eligible({}, 15)).toBe(false);
  });

  test("someone on a trial of their own plan, from its first day, with no charge yet", () => {
    const TRIAL = { isPayingPro: false, isTrialActive: true };
    // The server names no first charge for a trial; an older one leaves the field out.
    expect(eligible({ access: TRIAL, plan: { firstChargeAt: null, proTeam: null } })).toBe(true);
    expect(eligible({ access: TRIAL, plan: { proTeam: null } })).toBe(true);
    expect(eligible({ access: TRIAL, plan: { firstChargeAt: null, proTeam: { id: "t1", name: "Desk" } } })).toBe(false);
    expect(eligible({ access: TRIAL, plan: { firstChargeAt: null, proTeam: null }, dismissed: true })).toBe(false);
    expect(eligible({ access: TRIAL, plan: null })).toBe(false);
  });

  test("not a Team seat, someone who dismissed it, or a payer the server named no charge for", () => {
    expect(eligible({ plan: { firstChargeAt: new Date(NOW - DAY).toISOString(), proTeam: { id: "t1", name: "Desk" } } })).toBe(false);
    expect(eligible({ dismissed: true })).toBe(false);
    expect(eligible({ plan: { firstChargeAt: null, proTeam: null } })).toBe(false);
    // An older server says nothing about the first charge.
    expect(eligible({ plan: { proTeam: null } })).toBe(false);
    expect(eligible({ plan: null })).toBe(false);
    expect(eligible({ access: { isPayingPro: false, isTrialActive: false } })).toBe(false);
  });
});

const TEMPLATE_PANES: Record<string, string> = {
  "earnings-calls-pane": "earnings-calls",
  "scanner-flow-pane": "scanner-flow",
  "social-mentions-pane": "social-mentions",
  "jobs-pane": "jobs",
  "filing-events-pane": "filing-events",
  "risk-factors-pane": "risk-factors",
};
const paneIdOf = (templateId: string) => TEMPLATE_PANES[templateId] ?? null;
const everyTemplate = () => true;

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...createDefaultConfig("/tmp/gloom-pro-welcome"),
    portfolios: [{ id: "main", name: "Main", currency: "USD" }],
    watchlists: [{ id: "watch", name: "Watch" }],
    ...overrides,
  } as AppConfig;
}

describe("what the Pro row names", () => {
  const tickers = new Map<string, TickerRecord>([
    ["NVDA", createTestTicker("NVDA", "NVIDIA", { portfolios: ["main"] })],
    ["BTC-USD", createTestTicker("BTC-USD", "Bitcoin", { portfolios: ["main"], exchange: "CCC", assetCategory: "CRYPTO" })],
    ["AAPL", createTestTicker("AAPL", "Apple", { watchlists: ["watch"] })],
  ]);

  test("functions not run from the command bar nor open in any layout, each on another of the user's tickers it has data for", () => {
    const base = config();
    const opened = openedFunctions({
      layout: base.layout,
      layouts: [{ name: "Old", layout: { ...base.layout, instances: [{ instanceId: "jobs:NVDA", paneId: "jobs" }] } }],
      recentCommands: [{ id: "pane-template:earnings-calls-pane", label: "Earnings Calls", arg: "NVDA" }],
    }, paneIdOf);
    expect([...opened].sort()).toEqual(["earnings-calls-pane", "jobs-pane"]);

    const chips = pickProWelcomeChips(ownTickers(base, tickers, []), opened, everyTemplate);
    // Holdings first; a coin has no options flow, so FLOW goes to the next stock.
    expect(chips.map((chip) => `${chip.fn.shortcut} ${chip.symbol}`)).toEqual([
      "FLOW NVDA",
      "BUZZ BTC-USD",
      "EK AAPL",
    ]);
    expect(chips[0]?.ticker).toBe(tickers.get("NVDA")!);
  });

  test("with no portfolio or watchlist, the tickers viewed most recently", () => {
    const own = ownTickers(config({ portfolios: [], watchlists: [] }), new Map(), ["TSLA", "MSFT"]);
    const chips = pickProWelcomeChips(own, new Set(), everyTemplate);
    expect(chips.map((chip) => `${chip.fn.shortcut} ${chip.symbol}`)).toEqual(["CALLS TSLA", "FLOW MSFT", "BUZZ TSLA"]);
  });

  test("nothing when fewer than two can be named, or the user has no tickers", () => {
    const own = ownTickers(config(), tickers, []);
    const allButOne = new Set(["earnings-calls-pane", "scanner-flow-pane", "social-mentions-pane", "jobs-pane", "filing-events-pane"]);
    expect(pickProWelcomeChips(own, allButOne, everyTemplate)).toEqual([]);
    // A function whose plugin is off counts as not there.
    expect(pickProWelcomeChips(own, new Set(["earnings-calls-pane", "scanner-flow-pane", "social-mentions-pane", "jobs-pane"]), (id) => id !== "risk-factors-pane")).toEqual([]);
    expect(pickProWelcomeChips(ownTickers(config({ portfolios: [], watchlists: [] }), new Map(), []), new Set(), everyTemplate)).toEqual([]);
  });
});
