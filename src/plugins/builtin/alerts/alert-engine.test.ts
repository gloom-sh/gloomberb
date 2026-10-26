import { describe, expect, test } from "bun:test";
import { evaluateAlert, createAlert, editAlert, rearmAlert, serializeAlerts, deserializeAlerts, readAlertsStoreError } from "./alert-engine";

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
      lastQuoteProviderId: "gloom",
    };

    const edited = editAlert(alert, "aapl", "crosses", 180);

    expect(edited).toEqual({
      id: alert.id,
      symbol: "AAPL",
      exchange: "NASDAQ",
      condition: "crosses",
      targetPrice: 180,
      createdAt: alert.createdAt,
      armedAt: expect.any(Number),
      status: "active",
      message: "watch this",
    });
    // A stale lastCheckedPrice would make `crosses` fire off the previous symbol's baseline.
    expect(evaluateAlert(edited, 185)).toBe(false);
  });

  test("rearming a crosses alert drops the old quote baseline", () => {
    const alert = {
      ...createAlert("AAPL", "crosses", 180),
      armedAt: 1,
      status: "triggered" as const,
      triggeredAt: 123,
      lastCheckedPrice: 185,
    };

    const rearmed = rearmAlert(alert);

    expect(rearmed.status).toBe("active");
    expect(rearmed.lastCheckedPrice).toBeUndefined();
    expect(evaluateAlert(rearmed, 175)).toBe(false);
    // Same id, new arming: the cloud emails a trigger once per id and armedAt.
    expect(rearmed.id).toBe(alert.id);
    expect(rearmed.armedAt!).toBeGreaterThan(alert.armedAt);
  });

  test("drops the exchange when the symbol changes", () => {
    const alert = createAlert("AAPL", "above", 200, "NASDAQ");
    expect(editAlert(alert, "tsla", "above", 200).exchange).toBeUndefined();
  });
});

test("unreadable members and overflowing JSON numbers cannot be saved as a filtered list", () => {
  const legacy = { id: "old", symbol: "AAPL", condition: "above", targetPrice: 200, custom: { retained: true } };
  for (const raw of [
    JSON.stringify([legacy, null]),
    JSON.stringify([legacy, { id: "unfinished", symbol: "MSFT" }]),
    JSON.stringify([{ ...legacy, symbol: 42 }]),
    JSON.stringify([{ ...legacy, exchange: 42 }]),
    '[{"id":"overflow","symbol":"AAPL","condition":"above","targetPrice":1e400}]',
    JSON.stringify([legacy]).replace('true', '1e400'),
    { alerts: [legacy] },
    "null",
  ]) expect(readAlertsStoreError(raw)).not.toBeNull();
  // Older rows without newer lifecycle fields remain readable and keep unknown data.
  const raw = JSON.stringify([legacy]);
  expect(readAlertsStoreError(raw)).toBeNull();
  expect(serializeAlerts(deserializeAlerts(raw))).toBe(raw);
  for (const unset of [undefined, null, "", "[]"]) expect(readAlertsStoreError(unset)).toBeNull();
});
