import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { tapeFixture } from "./test-fixture";
import { fetchTape, validateTape } from "./client";
import { newestFirst, quoteKey, quoteSpread, tapeClock, tapeClockMs, tapeStatistics, tradeKey } from "./model";


test("lossless IDs and nanosecond order determine latest print and weighted observed statistics", () => {
  const data = validateTape(tapeFixture(), "AAPL", "NASDAQ");
  const reverse = newestFirst(data.trades);
  expect(reverse.map((row) => row.id)).toEqual(["9007199254740993", "9007199254740992"]);
  expect(tradeKey(reverse[0]!)).not.toBe(tradeKey(reverse[1]!));
  const midnight = { ...data.trades[0]!, timestamp: "2026-09-23T00:01:00Z" };
  expect(tradeKey(midnight)).toBe(tradeKey({ ...midnight, timestamp: "2026-09-22T23:59:00Z" }));
  expect(tradeKey(midnight)).not.toBe(tradeKey({ ...midnight, timestamp: "2026-09-23T14:00:00Z" }));
  expect(tapeStatistics(data)).toMatchObject({ count: 2, volume: 40, vwap: 101.5, low: 100, high: 102, pricePercentile: null });
  const many = { trades: Array.from({ length: 20 }, (_, i) => ({ ...data.trades[0]!, id: String(i), price: 100, size: 10 })) };
  expect(tapeStatistics(many).pricePercentile).toBe(50);
  expect(tapeStatistics({ trades: [] }).vwap).toBeNull();
});

test("one-sided, locked and crossed quotes retain source lots and never invent a positive spread", () => {
  const quote = tapeFixture().quotes[0]!;
  expect(quoteSpread(quote)).toMatchObject({ spread: -1, state: "crossed" });
  expect(quoteSpread({ ...quote, bid: null })).toEqual({ spread: null, bps: null, state: "one-sided" });
  expect(quoteSpread({ ...quote, ask: 102 })).toEqual({ spread: 0, bps: 0, state: "locked" });
  expect(validateTape(tapeFixture(), "AAPL", "NASDAQ").quotes[0]?.bidSize).toBe(1);
  expect(quoteKey(quote)).not.toBe(quoteKey({ ...quote, conditions: ["R", "Y"] }));
  expect(quoteKey(quote)).not.toBe(quoteKey({ ...quote, tape: "B" }));
});

test("snapshot boundary rejects cross-ticker data, oversize buffers, malformed IDs and delayed-feed leaks", () => {
  expect(() => validateTape(tapeFixture(), "MSFT", "NASDAQ")).toThrow("invalid tape snapshot");
  const over = tapeFixture(); over.capacity.trades = 1001;
  expect(() => validateTape(over, "AAPL", "NASDAQ")).toThrow("invalid tape snapshot");
  const duplicate = tapeFixture(); duplicate.trades.push(duplicate.trades[0]!);
  expect(() => validateTape(duplicate, "AAPL", "NASDAQ")).toThrow("invalid tape trades");
  const bad = tapeFixture(); bad.trades[0]!.id = 9007199254740992 as unknown as string;
  expect(() => validateTape(bad, "AAPL", "NASDAQ")).toThrow("invalid tape trades");
  const delayed = { ...tapeFixture(), access: "delayed" as const, feed: "delayed_sip" as const, delaySeconds: 900 as const };
  expect(() => validateTape(delayed, "AAPL", "NASDAQ")).toThrow("invalid tape trades");
  delayed.generatedAt = "2026-09-22T16:15:00.000Z";
  expect(validateTape(delayed, "AAPL", "NASDAQ").delaySeconds).toBe(900);
  delayed.session = { date: "2026-09-22", high: 103, low: 100, asOf: "2026-09-22T16:15:00.000Z" };
  expect(() => validateTape(delayed, "AAPL", "NASDAQ")).toThrow("invalid session context");
  delayed.session.asOf = "2026-09-22T16:00:00.000Z";
  expect(validateTape(delayed, "AAPL", "NASDAQ").session.high).toBe(103);
  delayed.generatedAt = "2026-09-22T16:15:00.123456788Z";
  delayed.trades[0]!.timestamp = "2026-09-22T16:00:00.123456789Z";
  expect(() => validateTape(delayed, "AAPL", "NASDAQ")).toThrow("invalid tape trades");
  delayed.trades[0]!.timestamp = "2026-09-22T16:00:00.123456788Z";
  expect(validateTape(delayed, "AAPL", "NASDAQ").trades.at(-1)?.timestamp).toBe(delayed.trades[0]!.timestamp);
  delayed.session = { date: null, high: 103, low: null, asOf: null };
  expect(() => validateTape(delayed, "AAPL", "NASDAQ")).toThrow("invalid session context");
});

test("absent endpoint is recoverable and access errors remain access errors", async () => {
  await expect(fetchTape("AAPL", "NASDAQ", undefined, { getCloudTape: async () => { throw new ApiRequestError("missing", 404); } })).rejects.toThrow("not available on this Gloom Cloud server yet");
  const denied = new ApiRequestError("Forbidden", 403);
  await expect(fetchTape("AAPL", "NASDAQ", undefined, { getCloudTape: async () => { throw denied; } })).rejects.toBe(denied);
});

test("tape rows read at millisecond precision while the exact stamp survives for the detail", () => {
  expect(tapeClockMs("2026-09-22T16:59:58.545074403Z")).toBe("16:59:58.545");
  expect(tapeClockMs("2026-09-22T16:59:58Z")).toBe("16:59:58");
  expect(tapeClock("2026-09-22T16:59:58.545074403Z")).toBe("16:59:58.545074403");
});
