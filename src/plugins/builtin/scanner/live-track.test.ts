import { describe, expect, test } from "bun:test";
import type { LiveScanMatch, LiveScanPayload } from "../../../api-client/live-scan";
import { LOUD_ALERT_EVERY_MS, liveScanFiredAlert, liveScanRowNote, trackLiveScan, type LiveScanTrack } from "./live-track";

// 2026-10-26 14:00 New York, a Monday in the session.
const OPEN = Date.UTC(2026, 9, 26, 18, 0, 0);

const match = (symbol: string, extra: Partial<LiveScanMatch> = {}): LiveScanMatch => ({
  symbol, name: symbol, price: 10, changePercent: 1, volume: 1_000, relativeVolume: 2,
  vwapPercent: 0.5, gapPercent: 0, values: [2.5], signalAt: null, at: OPEN, ...extra,
});

const payload = (symbols: string[], takenAt: number, extra: Partial<LiveScanPayload> = {}): LiveScanPayload => ({
  status: "live", access: "realtime", delayMinutes: 0, asOf: takenAt, takenAt, refreshMs: 15_000,
  scanned: 500, matched: symbols.length, matches: symbols.map((symbol) => match(symbol, { at: takenAt })),
  warmingWindows: [], warnings: [], ...extra,
});

function run(steps: Array<{ symbols: string[]; alerts?: boolean; key?: string; at?: number; status?: LiveScanPayload["status"] }>) {
  let track: LiveScanTrack | null = null;
  const alerted: string[][] = [];
  const loud: boolean[] = [];
  steps.forEach((step, index) => {
    const at = step.at ?? OPEN + index * 15_000;
    // A scanner that is starting has no snapshot yet.
    const extra: Partial<LiveScanPayload> = step.status === "starting" ? { status: "starting", asOf: null, takenAt: null }
      : step.status ? { status: step.status } : {};
    const result = trackLiveScan(track, payload(step.symbols, at, extra), step.key ?? "scan", { alerts: step.alerts ?? true, now: at });
    track = result.track;
    alerted.push(result.alert.map((row) => row.symbol));
    loud.push(result.loud);
  });
  return { track: track!, alerted, loud };
}

describe("live scan tracking", () => {
  test("the first answer only records what matches, then each new symbol alerts once a session", () => {
    const { alerted, track } = run([
      { symbols: ["AAPL", "MSFT"] },
      { symbols: ["AAPL", "MSFT", "NVDA"] },
      // NVDA leaves and comes back: it reads as new again, but does not alert twice.
      { symbols: ["AAPL"] },
      { symbols: ["AAPL", "NVDA", "AMD"] },
    ]);
    expect(alerted).toEqual([[], ["NVDA"], [], ["AMD"]]);
    expect([...track.fresh]).toEqual(["NVDA", "AMD"]);
    expect(track.seen.get("NVDA")!.alertedAt).toBe(OPEN + 15_000);
    expect(track.seen.get("AAPL")!.alertedAt).toBeNull();
  });

  test("a cold start is no baseline: the scanner starting with nothing is skipped, and its first answer with data is the baseline", () => {
    const { alerted } = run([
      { symbols: [], status: "starting" },
      { symbols: ["AAPL", "MSFT", "AMD"] },
      { symbols: ["AAPL", "MSFT", "AMD", "NVDA"] },
    ]);
    expect(alerted).toEqual([[], [], ["NVDA"]]);
    // A restart of the scanner in the session does not make the list that follows it new either.
    expect(run([
      { symbols: ["AAPL"] },
      { symbols: [], status: "starting" },
      { symbols: ["AAPL", "NVDA"] },
    ]).alerted).toEqual([[], [], ["NVDA"]]);
  });

  test("a scan that brings new symbols on every refresh tells each one, but sounds at most once a minute", () => {
    const { alerted, loud } = run([
      { symbols: ["A"] },
      { symbols: ["A", "B"] },
      { symbols: ["A", "B", "C"] },
      { symbols: ["A", "B", "C", "D"] },
      { symbols: ["A", "B", "C", "D", "E"] },
      { symbols: ["A", "B", "C", "D", "E", "F"] },
    ]);
    expect(alerted).toEqual([[], ["B"], ["C"], ["D"], ["E"], ["F"]]);
    // Refreshes every 15 seconds: B sounds, and the next to sound is F, a minute after it.
    expect(LOUD_ALERT_EVERY_MS).toBe(60_000);
    expect(loud).toEqual([false, true, false, false, false, true]);
  });

  test("turning alerts on later does not alert on symbols that matched while they were off", () => {
    const { alerted } = run([
      { symbols: ["AAPL"], alerts: false },
      { symbols: ["AAPL", "NVDA"], alerts: false },
      { symbols: ["AAPL", "NVDA", "AMD"], alerts: true },
    ]);
    expect(alerted).toEqual([[], [], ["AMD"]]);
  });

  test("a new scan or a new session starts over without alerting on its first answer", () => {
    expect(run([
      { symbols: ["AAPL"] },
      { symbols: ["AAPL", "NVDA"], key: "other scan" },
    ]).alerted).toEqual([[], []]);
    expect(run([
      { symbols: ["AAPL"] },
      { symbols: ["AAPL", "NVDA"], at: OPEN + 24 * 3_600_000 },
    ]).alerted).toEqual([[], []]);
  });

  test("nothing alerts at the close or while the scanner starts, and a repeated answer changes nothing", () => {
    const { alerted } = run([
      { symbols: ["AAPL"] },
      { symbols: ["AAPL", "NVDA"], status: "closed" },
      { symbols: ["AAPL", "NVDA", "AMD"], status: "starting" },
    ]);
    expect(alerted).toEqual([[], [], []]);
    const first = trackLiveScan(null, payload(["AAPL"], OPEN), "scan", { alerts: true, now: OPEN }).track;
    const again = trackLiveScan(first, payload(["AAPL", "NVDA"], OPEN), "scan", { alerts: true, now: OPEN + 1 });
    expect(again.track).toBe(first);
    expect(again.alert).toEqual([]);
  });
});

describe("a match's row note", () => {
  test("a stale print outranks an alert, and an alert outranks new", () => {
    const { track } = run([{ symbols: ["AAPL"] }, { symbols: ["AAPL", "NVDA", "AMD"] }]);
    const live = payload([], OPEN + 15_000);
    expect(liveScanRowNote(match("NVDA", { at: OPEN + 15_000 }), live, track)).toEqual({ kind: "alerted", at: OPEN + 15_000 });
    expect(liveScanRowNote(match("NVDA", { at: OPEN - 6 * 60_000 }), live, track)).toEqual({ kind: "stale", at: OPEN - 6 * 60_000 });
    const quiet = run([{ symbols: ["AAPL"] }, { symbols: ["AAPL", "NVDA"], alerts: false }]).track;
    expect(liveScanRowNote(match("NVDA", { at: OPEN }), live, quiet)).toEqual({ kind: "new" });
    expect(liveScanRowNote(match("AAPL", { at: OPEN }), live, quiet)).toBeNull();
    // At the close every print is old: nothing reads as stale.
    expect(liveScanRowNote(match("AAPL", { at: OPEN - 3_600_000 }), { ...live, status: "closed" }, quiet)).toBeNull();
  });
});

test("one alert is one history entry: it names its symbols and the figure the scan ranks by, or the price for an event", () => {
  const conditions = [{ kind: "move" as const, window: 5 as const, direction: "up" as const, percent: 2 }];
  const six = ["NVDA", "AMD", "MU", "INTC", "SMCI", "ARM"].map((symbol) => match(symbol));
  expect(liveScanFiredAlert([six[0]!, ...six.slice(1)], { ruleId: "pane", rule: "Breakouts", conditions, delayMinutes: 15, firedAt: OPEN })).toMatchObject({
    kind: "live_scan", symbol: "NVDA", rule: "NVDA, AMD, MU, INTC and 2 more · Breakouts", value: 2.5, unit: "%", source: "15 min delayed", detail: "Up 2% or more in 5 min",
  });
  const events = [{ kind: "new_high" as const, within: 5 as const }];
  expect(liveScanFiredAlert([match("NVDA", { values: [OPEN] })], { ruleId: "pane", rule: "Highs", conditions: events, delayMinutes: 0, firedAt: OPEN })).toMatchObject({
    value: 10, unit: "USD", source: "real-time",
  });
});
