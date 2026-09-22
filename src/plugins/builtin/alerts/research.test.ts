import { expect, test } from "bun:test";
import { eventAlertTarget, readEventAlerts } from "./events";
import { alertKindLabel, ruleStateText, validateAlertHistory } from "./history";
import { createResearchAlert } from "./research-builder";

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
