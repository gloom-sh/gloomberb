import { expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import { parseAlertAddArgs } from "./cli";
import { planMoveAlerts, uniqueInputs, MAX_BULK_ALERTS } from "./cli-move";
import { judgeMove, moveReached } from "./move";
import { readLevelAlertStores, writeLevelAlertStores } from "./storage";
import { evaluateAlert } from "./alert-engine";
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
  expect(JSON.parse(stores.moveAlerts!)).toEqual([move]);
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
  expect(plan.existing.map((entry) => [entry.input, entry.alert.id])).toEqual([["7203 JP", plan.added[0]!.id], ["VOD LN", "old"]]);
  expect(plan.failed).toEqual([{ input: "ZZZQQ", error: "Not a ticker: ZZZQQ." }]);

  const many = Array.from({ length: MAX_BULK_ALERTS + 3 }, (_, index) => ({ input: index === 1 ? "s0" : `S${index}` }));
  expect(uniqueInputs(many)).toMatchObject({ repeats: 1, leftOut: 2 });
});
