import { describe, expect, test } from "bun:test";
import { evaluateAlert, createAlert, editAlert, serializeAlerts, deserializeAlerts } from "./alert-engine";

describe("evaluateAlert", () => {
  test("above: triggers when price exceeds target", () => {
    const alert = createAlert("AAPL", "above", 200);
    expect(evaluateAlert(alert, 199)).toBe(false);
    expect(evaluateAlert(alert, 200)).toBe(false);
    expect(evaluateAlert(alert, 201)).toBe(true);
  });

  test("below: triggers when price drops below target", () => {
    const alert = createAlert("AAPL", "below", 150);
    expect(evaluateAlert(alert, 151)).toBe(false);
    expect(evaluateAlert(alert, 150)).toBe(false);
    expect(evaluateAlert(alert, 149)).toBe(true);
  });

  test("crosses: triggers when price crosses target in either direction", () => {
    const alert = createAlert("AAPL", "crosses", 180);
    expect(evaluateAlert(alert, 175)).toBe(false);
    alert.lastCheckedPrice = 175;
    expect(evaluateAlert(alert, 185)).toBe(true);
  });

  test("crosses: triggers downward crossing", () => {
    const alert = createAlert("AAPL", "crosses", 180);
    alert.lastCheckedPrice = 185;
    expect(evaluateAlert(alert, 175)).toBe(true);
  });

  test("crosses: does not trigger without prior price", () => {
    const alert = createAlert("AAPL", "crosses", 180);
    expect(evaluateAlert(alert, 185)).toBe(false);
  });

  test("does not evaluate triggered alerts", () => {
    const alert = createAlert("AAPL", "above", 200);
    alert.status = "triggered";
    expect(evaluateAlert(alert, 999)).toBe(false);
  });
});

describe("editAlert", () => {
  test("keeps identity, re-arms, and clears trigger/quote lifecycle state", () => {
    const alert = {
      ...createAlert("aapl", "above", 200, "NASDAQ"),
      message: "watch this",
      status: "triggered" as const,
      triggeredAt: 123,
      lastCheckedPrice: 205,
      lastCheckedAt: 124,
      lastCheckError: "boom",
      lastQuoteUpdatedAt: 125,
      lastQuoteSource: "live" as const,
      lastQuoteProviderId: "yahoo",
    };

    const edited = editAlert(alert, "aapl", "crosses", 180);

    expect(edited).toEqual({
      id: alert.id,
      symbol: "AAPL",
      exchange: "NASDAQ",
      condition: "crosses",
      targetPrice: 180,
      createdAt: alert.createdAt,
      status: "active",
      message: "watch this",
    });
    // A stale lastCheckedPrice would make `crosses` fire off the previous symbol's baseline.
    expect(evaluateAlert(edited, 185)).toBe(false);
  });

  test("drops the exchange when the symbol changes", () => {
    const alert = createAlert("AAPL", "above", 200, "NASDAQ");
    expect(editAlert(alert, "tsla", "above", 200).exchange).toBeUndefined();
  });
});

describe("serializeAlerts / deserializeAlerts", () => {
  test("roundtrips alerts", () => {
    const alerts = [createAlert("AAPL", "above", 200), createAlert("TSLA", "below", 100)];
    const json = serializeAlerts(alerts);
    const restored = deserializeAlerts(json);
    expect(restored).toHaveLength(2);
    expect(restored[0]!.symbol).toBe("AAPL");
    expect(restored[1]!.symbol).toBe("TSLA");
  });
});
