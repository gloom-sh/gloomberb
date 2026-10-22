import { expect, test } from "bun:test";
import type { SurfaceExpiry } from "../vol-surface/model";
import { readEventAlerts } from "./events";
import { appendFiredAlert, MAX_FIRED_ALERTS, readFiredAlerts, type FiredAlertInput } from "./fired-log";
import { checkIvLevelAlertsNow, ivLevelCheckText, ivLevelExpiries, ivLevelReading, rearmIvLevelAlert, startIvLevelAlerts, type IvLevelReading } from "./iv-level";
import { createResearchAlert } from "./research-builder";

const DAY = 86_400;
const NOW = Date.UTC(2026, 9, 22, 18);

/** An expiry as OVDV fits it: its days out, ATM IV and 25-delta wings, from quotes observed at `asOf`. */
function expiry(days: number, atm: number, put25: number | null, call25: number | null, extra: Partial<SurfaceExpiry> = {}): SurfaceExpiry {
  return {
    expiration: NOW / 1000 + days * DAY, years: days / 365, state: "ready", asOf: "2026-10-22T17:45:00.000Z", source: "test",
    dataSource: "delayed", delayMinutes: 15, fit: { method: "svi" }, atmIV: atm, error: null,
    skew: { atm, put25, call25, putCallSkew: null, riskReversal: null, butterfly: null, moneynessSkew: null },
    ...extra,
  } as unknown as SurfaceExpiry;
}

test("a 30-day reading uses the listed expiries either side of 30 days, a week out or more", () => {
  const expirations = [1, 4, 15, 22, 29, 36, 57, 85].map((days) => NOW / 1000 + days * DAY);
  const picked = ivLevelExpiries(expirations, NOW).map((expiration) => Math.round((expiration - NOW / 1000) / DAY));
  expect(picked).toEqual([22, 29, 36, 57]);
});

test("30-day ATM IV and 25-delta risk reversal interpolate OVDV's per-expiry figures in total variance", () => {
  // IBIT, 22 Oct 2026: 29 days ATM 37.50%, 25D put 40.76%, call 36.78%; 36 days 37.25%, 40.18%, 36.38%.
  const reading = ivLevelReading([expiry(29, 0.375, 0.4076, 0.3678), expiry(36, 0.3725, 0.4018, 0.3638)]);
  expect(reading.atm).toBeCloseTo(0.3746, 4);
  expect(reading.rr).toBeCloseTo(-0.0395, 4);
  expect(reading).toMatchObject({ quoteAt: "2026-10-22T17:45:00.000Z", source: "15 min delayed" });

  // No 25-delta quotes: the ATM level still reads, the risk reversal does not.
  const noWings = ivLevelReading([expiry(29, 0.375, null, null), expiry(36, 0.3725, null, 0.36)]);
  expect(noWings.atm).toBeCloseTo(0.3746, 4);
  expect(noWings.rr).toBeNull();

  // Only expiries far from 30 days: nothing is carried flat across weeks.
  const far = ivLevelReading([expiry(85, 0.38, 0.4, 0.37)]);
  expect(far).toMatchObject({ atm: null, rr: null, error: "No clean option quotes near 30 days" });
});

test("an IV level rule goes off once when its level is reached, logs it, and says why on its row when there is no reading", async () => {
  const atm = createResearchAlert("iv_level", { "iv_level:symbol": "IBIT", "iv_level:exchange": "US", "iv_level:metric": "atm", "iv_level:direction": "above", "iv_level:threshold": "35" }, NOW - 1000);
  const rr = createResearchAlert("iv_level", { "iv_level:symbol": "SPY", "iv_level:exchange": "US", "iv_level:metric": "rr", "iv_level:direction": "below", "iv_level:threshold": "-6" }, NOW - 1000);
  let json = JSON.stringify([atm, rr]);
  const notified: string[] = [];
  const logged: FiredAlertInput[] = [];
  let loads = 0;
  const reading: IvLevelReading = { atm: 0.3746, rr: -0.0396, quoteAt: "2026-10-22T17:45:00.000Z", source: "15 min delayed" };
  const stop = startIvLevelAlerts({
    configState: { get: <T,>() => json as T, set: async (_key: string, value: unknown) => { json = String(value); } } as never,
    notify: (notification: { body?: string }) => { notified.push(notification.body ?? ""); },
    showPane() {}, log: { info() {}, warn() {}, error() {}, debug() {} } as never, marketData: {} as never,
  }, (entry) => logged.push(entry), async (config) => {
    loads += 1;
    if (config.symbol === "SPY") throw new Error("No option chain for SPY");
    return reading;
  }, () => NOW);
  try {
    checkIvLevelAlertsNow();
    await Bun.sleep(5);
    const [fired, unread] = readEventAlerts(json).rules;
    expect(notified).toEqual(["IBIT 30d ATM IV 37.46% is above 35%"]);
    expect(fired).toMatchObject({ triggeredAt: NOW, check: { value: 37.46, quoteAt: reading.quoteAt, source: "15 min delayed" } });
    expect(ivLevelCheckText(fired!)).toBe("37.46% · quotes 10-22 17:45 UTC, 15 min delayed");
    expect(unread!.check).toMatchObject({ value: null, error: "No option chain for SPY" });
    expect(ivLevelCheckText(unread!)).toBe("No option chain for SPY");
    expect(logged).toEqual([expect.objectContaining({ kind: "iv_level", rule: "IBIT · 30d ATM IV above 35%", value: 37.46, unit: "%", quoteAt: reading.quoteAt, source: "15 min delayed" })]);

    // Alerted until re-armed: the next check reads only the rule still watching.
    loads = 0;
    checkIvLevelAlertsNow();
    await Bun.sleep(5);
    expect(loads).toBe(1);
    expect(notified).toHaveLength(1);
    expect(rearmIvLevelAlert(readEventAlerts(json).rules[0]!).triggeredAt).toBeUndefined();
  } finally {
    stop();
  }
});

test("the fired-alert log keeps the newest entries and drops what does not read", () => {
  let log = readFiredAlerts([{ id: "x" }, null, "junk"]);
  expect(log).toEqual([]);
  for (let index = 0; index <= MAX_FIRED_ALERTS; index += 1) {
    log = appendFiredAlert(log, { kind: "price", ruleId: "a", rule: `AAPL above ${index}`, firedAt: NOW + index, value: index, quoteAt: null, source: null }, `id-${index}`);
  }
  expect(log).toHaveLength(MAX_FIRED_ALERTS);
  expect(log[0]!.rule).toBe("AAPL above 1");
  expect(readFiredAlerts(log)).toHaveLength(MAX_FIRED_ALERTS);
});
