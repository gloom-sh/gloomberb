import { expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import { parseAlertAddArgs } from "./cli";
import { planMoveAlerts, uniqueInputs, MAX_BULK_ALERTS } from "./cli-move";
import { judgeMove, moveReached } from "./move";
import { readLevelAlertStores, saveAlerts, writeLevelAlertStores } from "./storage";
import { deserializeAlerts, editAlert, evaluateAlert, serializeAlerts } from "./alert-engine";
import { parseAlertEdit, parseAlertShortcutValues } from "./command";
import { moveChecksOf, readMoveChecks, withMoveChecks } from "./move-checks";
import { moveQuoteFields } from "./quotes";
import type { AlertRule } from "./types";

const quote = (changePercent: number, previousClose: number, extra: Partial<Quote> = {}): Quote => ({
  symbol: "GBPUSD=X", name: "GBP/USD", price: previousClose * (1 + changePercent / 100), currency: "USD",
  change: previousClose * changePercent / 100, changePercent, previousClose, lastUpdated: Date.parse("2026-11-06T09:00:00Z"),
  marketState: "REGULAR", exchangeName: "CCY", ...extra,
} as Quote);

test("a move is typed with moves, up or down and a percent, on one symbol, several or a watchlist; a signed level is that move", () => {
  const add = (words: string, watchlist = false) => parseAlertAddArgs(words.split(" "), undefined, undefined, undefined, undefined, watchlist);
  expect(add("GBPUSD=X moves 0.5%")).toEqual({ kind: "move", symbols: ["GBPUSD=X"], condition: "crosses", percent: 0.5 });
  expect(add("HSBA.L BARC.L down 3")).toEqual({ kind: "move", symbols: ["HSBA.L", "BARC.L"], condition: "below", percent: 3 });
  expect(add("up 3%", true)).toEqual({ kind: "move", symbols: [], condition: "above", percent: 3 });
  expect(add("AZN.L below -3%")).toMatchObject({ kind: "move", symbols: ["AZN.L"], condition: "below", percent: 3, readAs: 'Read "below -3%" as down 3% from the previous close.' });
  // An unsigned percent on a level is a slip for a move, never a price of 3.
  expect(() => add("AZN.L below 3%")).toThrow('A price level is a price, not "3%". For a move from the previous close: alerts add AZN.L down 3%.');
  expect(() => add("HSBA.L up 3%", true)).toThrow("Name symbols or --watchlist, not both");
  expect(() => add("GBPUSD=X moves 150%")).toThrow("A move is a percent from the previous close, above 0 and up to 100");
  // Other kinds that end in a direction and a percent keep their own reading.
  expect(add("IBIT iv above 50%")).toMatchObject({ kind: "iv_level" });
  expect(add("AAPL news rates up 5%")).toMatchObject({ kind: "news" });
});

test("a move rule goes off once in a session, at the hundredth the quote prints, and arms again in the next", () => {
  const rule: AlertRule = { id: "m", symbol: "GBPUSD=X", condition: "crosses", targetPrice: 0.5, createdAt: 0, status: "active", move: true };
  expect(moveReached(rule, -0.4949)).toBe(false);
  expect(moveReached(rule, -0.4951)).toBe(true);
  expect(moveReached({ ...rule, condition: "above" }, -0.6)).toBe(false);

  const first = judgeMove(rule, quote(-0.6, 1.345), 1);
  expect(first).toMatchObject({ fired: true, alert: { status: "triggered", lastCheckedPrice: -0.6 } });
  // The same session moving further does not go off again.
  expect(judgeMove(first.alert, quote(-0.9, 1.345), 2).fired).toBe(false);
  // The next session's close arms it; a move not there yet leaves it armed, one there goes off for that session.
  const monday = { lastUpdated: Date.parse("2026-11-09T09:00:00Z") };
  const next = judgeMove(first.alert, quote(0.1, 1.337, monday), 3);
  expect(next).toMatchObject({ fired: false, alert: { status: "active", lastMoveBasis: { kind: "close", date: "2026-11-06" } } });
  expect(judgeMove(next.alert, quote(0.7, 1.337, monday), 4).fired).toBe(true);
  // A move rule is never judged as a price of 0.5.
  expect(evaluateAlert(rule, 1.33)).toBe(false);
});

test("move rules keep a synced list of their own, which no price reader sees", () => {
  const price: AlertRule = { id: "p", symbol: "AAPL", condition: "above", targetPrice: 250, createdAt: 0, status: "active" };
  const move: AlertRule = { id: "m", symbol: "AZN.L", condition: "below", targetPrice: 3, createdAt: 0, status: "active", move: true };
  const stores = writeLevelAlertStores([price, move]);
  expect(JSON.parse(stores.alerts!)).toEqual([price]);
  expect(JSON.parse(stores.moveAlerts!)).toEqual([{ ...move, syncsMoveDay: true }]);
  expect(readLevelAlertStores((key) => stores[key]).alerts.map((alert) => alert.id).sort()).toEqual(["m", "p"]);
});

test("a bulk move add makes one alert per listing, once however it was typed, capped, and names what it could not make", () => {
  const request = { kind: "move" as const, symbols: [], condition: "below" as const, percent: 3 };
  const listed = (input: string, symbol: string, exchange: string) => ({ input, listing: { symbol, exchange }, quote: quote(-1, 100) });
  const saved: AlertRule = { id: "old", symbol: "VOD:LSE", exchange: "LSE", condition: "below", targetPrice: 3, createdAt: 0, status: "active", move: true };
  const plan = planMoveAlerts(request, [
    listed("7203.T", "7203.T", "JPX"), listed("7203 JP", "7203:JPX", "JPX"), listed("VOD LN", "VOD:LSE", "LSE"),
    { input: "ZZZQQ", error: "Not a ticker: ZZZQQ." },
  ], [saved]);
  expect(plan.added.map((alert) => [alert.symbol, alert.exchange, alert.move])).toEqual([["7203.T", "JPX", true]]);
  // `7203 JP` is the listing 7203.T made the alert for in the same command, not one set before.
  expect(plan.sameListing.map((entry) => [entry.input, entry.alert.id])).toEqual([["7203 JP", plan.added[0]!.id]]);
  expect(plan.existing.map((entry) => [entry.input, entry.alert.id])).toEqual([["VOD LN", "old"]]);
  expect(plan.failed).toEqual([{ input: "ZZZQQ", error: "Not a ticker: ZZZQQ." }]);

  const many = Array.from({ length: MAX_BULK_ALERTS + 3 }, (_, index) => ({ input: index === 1 ? "s0" : `S${index}` }));
  expect(uniqueInputs(many)).toMatchObject({ repeats: 1, leftOut: 2 });
});

test("a move rule that went off is armed again only by a later dated session: never by a print after the close, a weekend quote or a stream and a poll a day apart", () => {
  const rule: AlertRule = { id: "m", symbol: "GBPUSD=X", condition: "crosses", targetPrice: 0.5, createdAt: 0, status: "active", move: true };
  const at = (time: string, changePercent = -0.8, extra: Partial<Quote> = {}) => quote(changePercent, 1.345, { lastUpdated: Date.parse(time), ...extra });
  const fired = judgeMove(rule, at("2026-11-06T21:50:00Z"), Date.parse("2026-11-06T21:50:00Z"));
  expect(fired).toMatchObject({ fired: true, alert: { moveSession: "2026-11-05" } });
  // A print after the week's close names no session: it never arms the rule again.
  const late = judgeMove(fired.alert, at("2026-11-06T22:10:00Z"), Date.parse("2026-11-06T22:10:00Z"));
  expect(late.reading?.session).toBeNull();
  expect(late).toMatchObject({ fired: false, alert: { status: "triggered" } });
  // Over the weekend the quote is Friday's, or undated: still the session it went off in.
  for (const time of ["2026-11-07T10:00:00Z", "2026-11-08T12:00:00Z"]) {
    const weekend = judgeMove(late.alert, at("2026-11-06T21:59:00Z"), Date.parse(time));
    expect(weekend.fired).toBe(false);
    expect(judgeMove(weekend.alert, at(time), Date.parse(time)).fired).toBe(false);
  }
  // A stream dating the move a session on and a poll still on the one before never set it off twice.
  const monday = judgeMove(late.alert, at("2026-11-09T08:00:00Z"), Date.parse("2026-11-09T08:00:00Z"));
  expect(monday).toMatchObject({ fired: true, alert: { moveSession: "2026-11-06" } });
  expect(judgeMove(monday.alert, at("2026-11-06T21:59:00Z", -0.9), Date.parse("2026-11-09T08:01:00Z")).fired).toBe(false);
  expect(judgeMove(monday.alert, at("2026-11-09T08:02:00Z", -1.2), Date.parse("2026-11-09T08:02:00Z")).fired).toBe(false);
  // An undated reading that sets off an armed rule counts as the session read just before it.
  const armed = judgeMove(rule, at("2026-11-09T08:00:00Z", 0.1), Date.parse("2026-11-09T08:00:00Z")).alert;
  const undated = judgeMove({ ...armed, lastCheckedAt: Date.parse("2026-11-09T08:00:00Z") }, at("2026-11-09T08:05:00Z", -0.7, { lastUpdated: 0 }), Date.parse("2026-11-09T08:05:00Z"));
  expect(undated).toMatchObject({ fired: true, alert: { moveSession: "2026-11-06" } });
  expect(judgeMove(undated.alert, at("2026-11-09T08:06:00Z", -0.9), Date.parse("2026-11-09T08:06:00Z")).fired).toBe(false);
});

test("a move rule's readings stay on the device: the synced list holds the rule and changes only when the rule does or goes off on a dated move", () => {
  const rule: AlertRule = { id: "m", symbol: "GBPUSD=X", condition: "crosses", targetPrice: 0.5, createdAt: 10, status: "active", move: true };
  const judged = judgeMove(rule, quote(-0.6, 1.345), Date.parse("2026-11-06T09:00:00Z")).alert;
  const checked = { ...judged, ...moveQuoteFields(quote(-0.6, 1.345), Date.parse("2026-11-06T09:00:00Z")), status: judged.status };
  // Judged and fired, the rule writes the same synced list as before it was read.
  expect(writeLevelAlertStores([checked]).moveAlerts).toBe(writeLevelAlertStores([rule]).moveAlerts);
  const checks = moveChecksOf([checked]);
  expect(checks.m).toMatchObject({ armedAt: 10, percent: -0.6, fired: true, session: "2026-11-05" });
  // Read back on the device it is the fired rule; a reading from before an edit is not its own.
  const saved = readMoveChecks(JSON.parse(JSON.stringify(checks)));
  expect(withMoveChecks([rule], saved)[0]).toMatchObject({ status: "triggered", lastCheckedPrice: -0.6, moveSession: "2026-11-05" });
  expect(withMoveChecks([{ ...rule, armedAt: 20 }], saved)[0]).toEqual({ ...rule, armedAt: 20, syncsMoveDay: true });
});

test("a move rule that goes off syncs the session of the move, once a session, so Gloom Cloud never alerts on it again", () => {
  const rule: AlertRule = { id: "m", symbol: "AZN.L", exchange: "LSE", condition: "below", targetPrice: 3, createdAt: 10, status: "active", move: true };
  const at = (time: string, changePercent: number, changeSessionDate: string) =>
    quote(changePercent, 120, { lastUpdated: Date.parse(time), changeSessionDate, exchangeName: "LSE" });
  const synced = (alert: AlertRule) => JSON.parse(writeLevelAlertStores([alert]).moveAlerts!)[0];
  // Checked without going off: the synced rule is as it was.
  const quiet = judgeMove(rule, at("2026-11-06T09:00:00Z", -1, "2026-11-06"), Date.parse("2026-11-06T09:00:00Z"));
  expect(synced(quiet.alert)).toEqual({ ...rule, syncsMoveDay: true });
  // Gone off: the move's session goes with the rule, as the quote dates it.
  const fired = judgeMove(quiet.alert, at("2026-11-06T10:00:00Z", -3.2, "2026-11-06"), Date.parse("2026-11-06T10:00:00Z"));
  expect(fired.fired).toBe(true);
  expect(synced(fired.alert)).toEqual({ ...rule, moveDay: "2026-11-06", syncsMoveDay: true });
  // Later checks that session, or an older quote, leave it; the next session's going off moves it on.
  const later = judgeMove(fired.alert, at("2026-11-06T11:00:00Z", -4, "2026-11-06"), Date.parse("2026-11-06T11:00:00Z"));
  expect(writeLevelAlertStores([later.alert]).moveAlerts).toBe(writeLevelAlertStores([fired.alert]).moveAlerts);
  const monday = judgeMove(later.alert, at("2026-11-09T10:00:00Z", -3.5, "2026-11-09"), Date.parse("2026-11-09T10:00:00Z"));
  expect(monday.fired).toBe(true);
  expect(synced(monday.alert).moveDay).toBe("2026-11-09");
  // Read back on the device it keeps the session; an edit starts afresh without it.
  expect(withMoveChecks([synced(monday.alert)], {})[0]?.moveDay).toBe("2026-11-09");
  expect(editAlert(monday.alert, "AZN.L", "below", 2).moveDay).toBeUndefined();
});

test("a move list an older app synced is written once more with the marker Gloom Cloud judges by, then left as written", async () => {
  // An older app alerts on its own and never syncs the session: Gloom Cloud leaves rules without the marker alone.
  const older: AlertRule[] = [
    { id: "a", symbol: "AZN.L", exchange: "LSE", condition: "below", targetPrice: 3, createdAt: 10, status: "active", move: true },
    { id: "g", symbol: "GBPUSD=X", condition: "crosses", targetPrice: 0.5, createdAt: 11, status: "active", move: true },
  ];
  const store = new Map<string, unknown>([["moveAlerts", serializeAlerts(older)]]);
  const writes: string[] = [];
  const ctx = {
    configState: {
      get: (key: string) => store.get(key) ?? null,
      set: async (key: string, value: unknown) => { writes.push(key); store.set(key, value); },
    },
  };
  // Nothing about the rules changed, yet the list is written with the marker on every rule.
  await saveAlerts(ctx as any, deserializeAlerts(store.get("moveAlerts")), "price");
  expect(writes).toEqual(["moveAlerts"]);
  expect(deserializeAlerts(store.get("moveAlerts"))).toEqual(older.map((rule) => ({ ...rule, syncsMoveDay: true })));
  // Once marked, a check that changes no rule writes nothing.
  await saveAlerts(ctx as any, deserializeAlerts(store.get("moveAlerts")), "price");
  expect(writes).toEqual(["moveAlerts"]);
});

test("a move rule is edited as a move, and refused as a price level; a price alert is refused as a move", () => {
  const move = { symbol: "GBPUSD=X", move: true };
  expect(parseAlertEdit(move, "GBPUSD=X moves 0.50%")).toEqual({ symbol: "GBPUSD=X", condition: "crosses", price: 0.5, move: true });
  expect(parseAlertEdit(move, "GBPUSD=X down 1")).toEqual({ symbol: "GBPUSD=X", condition: "below", price: 1, move: true });
  expect(() => parseAlertEdit(move, "GBPUSD=X above 1.35")).toThrow("A price level is its own alert: gloom alerts add GBPUSD=X above 1.35.");
  expect(() => parseAlertEdit({ symbol: "AAPL" }, "AAPL up 3%")).toThrow("A move is its own alert: gloom alerts add AAPL up 3%.");
  expect(() => parseAlertShortcutValues("GBPUSD=X moves 0.5%")).toThrow("Add a move alert with gloom alerts add GBPUSD=X moves 0.5%.");
});
