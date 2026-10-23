import { expect, test } from "bun:test";
import type { OptionContract, OptionsChain } from "../../../types/financials";
import { DEFAULT_OPTION_CALC_DRAFT } from "../options-calculator/model";
import { daysToExpiryFrom, valueOption } from "../shared/volatility";
import { buildSurfaceExpiry, buildSurfaceGrid, type SurfaceSnapshot } from "../vol-surface/model";
import { IV_LEVEL_ALERTS_KEY, readEventAlerts, type EventAlertRule } from "./events";
import { appendFiredAlert, MAX_FIRED_ALERTS, readFiredAlerts, type FiredAlertInput } from "./fired-log";
import {
  checkIvLevelAlertsNow, IV_LEVEL_CHECKS_KEY, ivLevelCheckText, ivLevelReading, readIvLevelChecks, rearmIvLevelAlert,
  startIvLevelAlerts, type IvLevelReading,
} from "./iv-level";
import { createResearchAlert } from "./research-builder";

const NOW = Date.UTC(2026, 9, 22, 18);
const DAY = 86_400;
const curve = [{ maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-10-21" },
  { maturity: "1Y", maturityYears: 1, yield: 4, asOf: "2026-10-21" }];

/** A chain priced off a smile with a put skew: IV rises as the strike falls. */
function skewedChain(expiration: number, level: number): OptionsChain {
  const strikes = [70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130];
  const contract = (strike: number, side: "call" | "put"): OptionContract => {
    const volatility = level + 0.2 * (100 - strike) / 100;
    const price = valueOption({ ...DEFAULT_OPTION_CALC_DRAFT, side, spot: 100, strike,
      daysToExpiry: daysToExpiryFrom(expiration, NOW), rate: 0.04, dividendYield: 0.01, volatility }).price;
    return { contractSymbol: `${side}-${strike}-${expiration}`, strike, currency: "USD", expiration,
      bid: price * 0.99, ask: price * 1.01, lastPrice: price, impliedVolatility: volatility,
      openInterest: 10, volume: 2, lastTradeDate: NOW / 1000 - 1000,
      change: 0, percentChange: 0, inTheMoney: side === "call" ? strike < 100 : strike > 100 };
  };
  return { underlyingSymbol: "IBIT", expirationDates: [expiration], calls: strikes.map((strike) => contract(strike, "call")),
    puts: strikes.map((strike) => contract(strike, "put")), providerId: "test", dataSource: "delayed", delayMinutes: 15,
    asOf: "2026-10-22T17:45:00.000Z" };
}

function surface(days: number[], levels: number[]): SurfaceSnapshot {
  const expirations = days.map((day) => NOW / 1000 + day * DAY);
  return { symbol: "IBIT", spot: 100, phase: "ready", settings: { ivSource: "recomputed", priceSide: "mid", maxRelativeSpread: 0.5, maxStaleSessions: 5 },
    catalogue: expirations, requested: days.length, loaded: days.length, failed: 0, failures: [], warnings: [], rateAsOf: "2026-10-21", fetchedAt: NOW,
    expiries: expirations.map((expiration, index) => buildSurfaceExpiry({ chain: skewedChain(expiration, levels[index]!), expiration, spot: 100, curve, now: NOW })) };
}

test("the 30-day ATM IV and risk reversal are the 1M row OVDV's Table shows on the delta axis", () => {
  const snapshot = surface([22, 45], [0.36, 0.38]);
  const reading = ivLevelReading(snapshot);
  // OVDV's fixed tenors, solved at 30 days on the same fits: 25dP, ATM and 25dC.
  const row = buildSurfaceGrid(snapshot, { axis: "delta", tenors: "fixed", coordinates: [-0.25, 0, 0.25] }).rows.find((entry) => entry.label === "1M")!;
  const [put, atm, call] = row.cells.map((cell) => cell.volatility!);
  expect(reading.atm).toBe(atm!);
  expect(reading.rr).toBe(call! - put!);
  expect(reading.rr!).toBeLessThan(0);
  expect(reading.atm!).toBeGreaterThan(0.36);
  expect(reading).toMatchObject({ quoteAt: "2026-10-22T17:45:00.000Z", source: "15 min delayed" });

  // Only expiries far past 30 days: nothing is carried flat across weeks.
  expect(ivLevelReading(surface([85, 120], [0.38, 0.4]))).toMatchObject({ atm: null, rr: null, error: "No clean option quotes near 30 days" });
});

const rule = (symbol: string, metric: "atm" | "rr", direction: "above" | "below", threshold: string) => createResearchAlert("iv_level", {
  "iv_level:symbol": symbol, "iv_level:exchange": "US", "iv_level:metric": metric, "iv_level:direction": direction, "iv_level:threshold": threshold,
}, NOW - 1000);

/** The plugin's stores in memory: synced config, with each write counted, and this device's state. */
function harness(rules: EventAlertRule[], load: (symbol: string, signal: AbortSignal) => Promise<IvLevelReading>, options: { timeoutMs?: number } = {}) {
  const config = new Map<string, string>([[IV_LEVEL_ALERTS_KEY, JSON.stringify(rules)]]);
  const device = new Map<string, unknown>();
  const state = { writes: 0, failWrites: 0, kept: 0, notified: [] as string[], logged: [] as FiredAlertInput[], loads: [] as string[] };
  const stop = startIvLevelAlerts({
    configState: {
      get: <T,>(key: string) => (config.get(key) ?? null) as T,
      set: async (key: string, value: unknown) => {
        if (state.failWrites > 0) {
          state.failWrites -= 1;
          throw new Error("disk full");
        }
        state.writes += 1;
        config.set(key, String(value));
      },
    } as never,
    resume: { getState: (key: string) => device.get(key) ?? null, setState: (key: string, value: unknown) => { device.set(key, value); state.kept += 1; } } as never,
    notify: (notification: { body?: string }) => { state.notified.push(notification.body ?? ""); },
    showPane() {}, log: { info() {}, warn() {}, error() {}, debug() {} } as never, marketData: {} as never,
  }, (entry) => state.logged.push(entry), {
    load: (config, signal) => { state.loads.push(config.symbol!); return load(config.symbol!, signal); },
    now: () => NOW,
    ...options,
  });
  const rulesNow = () => readEventAlerts(config.get(IV_LEVEL_ALERTS_KEY)!).rules;
  const checks = () => readIvLevelChecks(device.get(IV_LEVEL_CHECKS_KEY));
  /** One check, run to the end: its readings are on the device once it is done. */
  const checkOnce = async () => {
    const before = state.kept;
    checkIvLevelAlertsNow();
    for (let waited = 0; state.kept === before && waited < 2_000; waited += 5) await Bun.sleep(5);
    await Bun.sleep(5);
  };
  return { config, state, stop, rulesNow, checks, checkOnce, setRules: (next: EventAlertRule[]) => config.set(IV_LEVEL_ALERTS_KEY, JSON.stringify(next)) };
}

const READING: IvLevelReading = { atm: 0.3746, rr: -0.0396, quoteAt: "2026-10-22T17:45:00.000Z", source: "15 min delayed" };

test("IV levels go off once, above or below, keep their readings on the device, and write synced config only when one goes off", async () => {
  const above = rule("IBIT", "atm", "above", "35");
  const below = rule("QQQ", "rr", "below", "-3");
  const unread = rule("SPY", "rr", "below", "-6");
  const run = harness([above, below, unread], async (symbol) => {
    if (symbol === "SPY") throw new Error("No option chain for SPY");
    return READING;
  });
  try {
    await run.checkOnce();
    expect(run.state.notified).toEqual(["IBIT 30d ATM IV 37.46% is above 35%", "QQQ 30d 25D RR -3.96 pts is below -3 pts"]);
    expect(run.state.writes).toBe(1);
    const [fired, firedRr, waiting] = run.rulesNow();
    expect(fired!.triggeredAt).toBe(NOW);
    expect(firedRr!.triggeredAt).toBe(NOW);
    expect(waiting!.triggeredAt).toBeUndefined();
    // The readings are this device's, not the synced rule's.
    expect(JSON.stringify(run.rulesNow())).not.toContain("37.46");
    expect(ivLevelCheckText(fired!, run.checks()[fired!.id])).toBe("37.46% · quotes 10-22 17:45 UTC, 15 min delayed");
    expect(ivLevelCheckText(waiting!, run.checks()[waiting!.id])).toBe("No option chain for SPY");
    expect(run.state.logged.map((entry) => [entry.rule, entry.value, entry.unit])).toEqual([
      ["IBIT · 30d ATM IV above 35%", 37.46, "%"],
      ["QQQ · 30d 25D RR below -3 pts", -3.96, "vol pts"],
    ]);

    // Alerted until re-armed: the next check reads only the rule still watching, and writes no synced config.
    run.state.loads.length = 0;
    await run.checkOnce();
    expect(run.state.loads).toEqual(["SPY"]);
    expect(run.state.notified).toHaveLength(2);
    expect(run.state.writes).toBe(1);
    expect(run.checks()[fired!.id]?.value).toBe(37.46);
  } finally {
    run.stop();
  }
});

test("a rule added or re-armed while already past its level goes off at its next check, as a price alert does", async () => {
  const above = rule("IBIT", "atm", "above", "35");
  const run = harness([above], async () => READING);
  try {
    await run.checkOnce();
    expect(run.state.notified).toHaveLength(1);
    run.setRules(run.rulesNow().map(rearmIvLevelAlert));
    await run.checkOnce();
    expect(run.state.notified).toEqual(["IBIT 30d ATM IV 37.46% is above 35%", "IBIT 30d ATM IV 37.46% is above 35%"]);
    expect(run.rulesNow()[0]!.triggeredAt).toBe(NOW);
  } finally {
    run.stop();
  }
});

test("an alert whose save fails is not sent, so the next check sends it once", async () => {
  const run = harness([rule("IBIT", "atm", "above", "35")], async () => READING);
  run.state.failWrites = 1;
  try {
    await run.checkOnce();
    expect(run.state.notified).toEqual([]);
    expect(run.state.logged).toEqual([]);
    expect(run.rulesNow()[0]!.triggeredAt).toBeUndefined();
    await run.checkOnce();
    expect(run.state.notified).toHaveLength(1);
    await run.checkOnce();
    expect(run.state.notified).toHaveLength(1);
    expect(run.state.logged).toHaveLength(1);
  } finally {
    run.stop();
  }
});

test("a reading that never arrives is given up on after the timeout, and the checks go on", async () => {
  let hang = true;
  let aborted = false;
  const run = harness([rule("IBIT", "atm", "above", "35")], (_symbol, signal) => {
    if (!hang) return Promise.resolve(READING);
    signal.addEventListener("abort", () => { aborted = true; });
    return new Promise<IvLevelReading>(() => {});
  }, { timeoutMs: 30 });
  try {
    await run.checkOnce();
    expect(aborted).toBe(true);
    const id = run.rulesNow()[0]!.id;
    expect(run.checks()[id]).toMatchObject({ value: null, error: "Option quotes for IBIT did not arrive within 30 ms" });
    hang = false;
    await run.checkOnce();
    expect(run.state.notified).toEqual(["IBIT 30d ATM IV 37.46% is above 35%"]);
  } finally {
    run.stop();
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
