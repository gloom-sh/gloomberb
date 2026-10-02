import { describe, expect, test } from "bun:test";
import { createAlert, deserializeAlerts, serializeAlerts } from "./alert-engine";
import { activePriceAlertsFor, addLevelAlert, levelAlertCondition } from "./levels";

describe("chart levels as price alerts", () => {
  test("a level overhead fires above, one underneath fires below, one at the price crosses", () => {
    expect(levelAlertCondition(235, 228.38)).toBe("above");
    expect(levelAlertCondition(220, 228.38)).toBe("below");
    expect(levelAlertCondition(228.38, 228.38)).toBe("crosses");
    expect(levelAlertCondition(228.38, null)).toBe("crosses");
  });

  test("adds an alert on the charted listing and never a second one at the same price", () => {
    const first = addLevelAlert("[]", { symbol: "nvda", exchange: "NASDAQ" }, 235.5, 228.38);
    if ("error" in first) throw new Error(first.error);
    expect(first.created).toBe(true);
    expect(first.alert).toMatchObject({ symbol: "NVDA", exchange: "NASDAQ", condition: "above", targetPrice: 235.5, status: "active" });
    expect(deserializeAlerts(first.json)).toHaveLength(1);

    const again = addLevelAlert(first.json, { symbol: "NVDA", exchange: "NASDAQ" }, 235.5, 240);
    if ("error" in again) throw new Error(again.error);
    expect(again.created).toBe(false);
    expect(again.alert.id).toBe(first.alert.id);
    expect(again.json).toBe(first.json);
  });

  test("leaves a store it cannot read untouched", () => {
    expect(addLevelAlert("{not json", { symbol: "NVDA" }, 230, 228)).toHaveProperty("error");
  });

  test("a chart draws the active alerts on its listing, and ones set without an exchange", () => {
    const alerts = [
      createAlert("NVDA", "above", 235, "NASDAQ"),
      createAlert("NVDA", "below", 220),
      { ...createAlert("NVDA", "above", 250, "NASDAQ"), status: "triggered" as const },
      createAlert("NVDA", "above", 240, "XETRA"),
      createAlert("AMD", "above", 180, "NASDAQ"),
    ];
    const shown = activePriceAlertsFor(serializeAlerts(alerts), { symbol: "NVDA", exchange: "NASDAQ" });
    expect(shown.map((alert) => alert.targetPrice)).toEqual([235, 220]);
    expect(activePriceAlertsFor(undefined, { symbol: "NVDA" })).toEqual([]);
  });
});
