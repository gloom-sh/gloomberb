import { expect, test } from "bun:test";
import { eventAlertTarget, readEventAlerts } from "./events";
import { alertKindLabel, ruleStateText, validateAlertHistory } from "./history";
import { createResearchAlert, parseAmount } from "./research-builder";

test("wizard values become a normalized synced rule that reads back with its description", () => {
  const rule = createResearchAlert("unusual_volume", {
    "unusual_volume:symbol": " nvda ",
    "unusual_volume:exchange": "NASDAQ",
    "unusual_volume:threshold": "2.5",
    "filing_type:form": "10-K",
  }, 1_000);
  expect(JSON.parse(rule.value)).toEqual({ version: 1, symbol: "NVDA", exchange: "NASDAQ", threshold: 2.5 });
  const { rules, error } = readEventAlerts(JSON.stringify([rule]));
  expect(error).toBeNull();
  expect(eventAlertTarget(rules[0]!)).toBe("NVDA · ≥2.5× 20d");
  expect(alertKindLabel(rules[0]!.kind)).toBe("Unusual volume");
});

test("invalid contracts, exchanges and thresholds are refused before sync", () => {
  expect(() => createResearchAlert("iv_spike", { "iv_spike:contract": "AAPL" })).toThrow("OCC contract");
  expect(() => createResearchAlert("fifty_two_week", { "fifty_two_week:symbol": "SAP", "fifty_two_week:exchange": "XETRA" })).toThrow();
  expect(() => createResearchAlert("unusual_volume", { "unusual_volume:symbol": "AAPL", "unusual_volume:threshold": "0.5" })).toThrow();
  const option = createResearchAlert("iv_spike", { "iv_spike:contract": "O:AAPL261016C00300000", "iv_spike:threshold": "5" });
  expect(JSON.parse(option.value)).toMatchObject({ symbol: "AAPL", contract: "AAPL261016C00300000" });
});

test("rule state text keeps value, percentile and date, and says why a reading is missing", () => {
  const base = { ruleId: "r", conditionMet: false, samples: 240, warning: null, checkedAt: "2026-09-22T12:00:00Z" };
  expect(ruleStateText({ ...base, asOf: "2026-09-21T00:00:00Z", value: 1.842, unit: "times prior 20-session volume", percentile: 96.6 }))
    .toBe("1.84 times prior 20-session volume · 97 pctl · 2026-09-21");
  expect(ruleStateText({ ...base, asOf: null, value: null, unit: null, percentile: null, warning: "Completed daily history is missing or stale." }))
    .toBe("Completed daily history is missing or stale.");
  expect(ruleStateText(undefined)).toBe("--");
});

test("history responses need dated items", () => {
  const ok = { status: "ready", warning: null, asOf: "2026-09-22T12:00:00Z", items: [{ id: "1", kind: "filing_type", title: "AAPL 8-K", body: "Accepted 2026-09-22", deliveredAt: "2026-09-22T11:00:00Z" }], states: [], hasMore: false, nextOffset: null, deviceEnabled: true, syncAsOf: null };
  expect(validateAlertHistory(ok).items).toHaveLength(1);
  expect(() => validateAlertHistory({ ...ok, items: [{ ...ok.items[0], deliveredAt: "yesterday" }] })).toThrow("Invalid alert history");
});

test("options flow rules read premiums the way people type them and match Cloud's canonical form", () => {
  const named = createResearchAlert("options_flow", {
    "options_flow:symbol": "nvda",
    "options_flow:exchange": "US",
    "options_flow:threshold": "1,000,000",
  }, 1_000);
  // Byte-identical to the Cloud normalizer, so both sides key the rule the same way.
  expect(named.value).toBe('{"version":1,"symbol":"NVDA","exchange":"US","threshold":1000000,"direction":"any","print":"any"}');
  const { rules } = readEventAlerts(JSON.stringify([named]));
  expect(eventAlertTarget(rules[0]!)).toBe("NVDA · ≥$1M");
  expect(alertKindLabel("options_flow")).toBe("Options flow");

  const watched = createResearchAlert("options_flow", {
    "options_flow:symbol": "",
    "options_flow:threshold": "$250k",
    "options_flow:direction": "puts",
    "options_flow:print": "sweep",
  });
  expect(JSON.parse(watched.value)).toEqual({ version: 1, threshold: 250_000, direction: "puts", print: "sweep" });
  expect(eventAlertTarget(readEventAlerts(JSON.stringify([watched])).rules[0]!)).toBe("Portfolio and watchlists · ≥$250K · puts · sweeps");

  expect(parseAmount("1.5m")).toBe(1_500_000);
  expect(Number.isNaN(parseAmount("lots"))).toBe(true);
  expect(() => createResearchAlert("options_flow", { "options_flow:threshold": "10k" })).toThrow("$50,000");
});

test("a flow rule's state shows its latest matching print", () => {
  const base = { ruleId: "r", conditionMet: null, samples: 0, percentile: null, warning: null, checkedAt: "2026-09-23T16:00:00Z" };
  expect(ruleStateText({ ...base, asOf: "2026-09-23T15:42:10Z", value: 2_400_000, unit: "USD" }))
    .toBe("last $2.4M print · 2026-09-23 11:42 ET");
  expect(ruleStateText({ ...base, asOf: null, value: null, unit: null, warning: "Watching 12 NVDA contracts; no qualifying print yet." }))
    .toBe("Watching 12 NVDA contracts; no qualifying print yet.");
});
