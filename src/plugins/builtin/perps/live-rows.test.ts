import { expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import { isLivePerpQuote, withLiveReading } from "./live-rows";
import { perpRow } from "./test-fixture";

const quote = (perpetual: Quote["perpetual"]): Quote => ({ symbol: "BTC", price: 1, currency: "USDC", change: 0, changePercent: 0, lastUpdated: 0, perpetual });

test("a fetched row takes a streamed reading of its market only when the reading is newer", () => {
  const fetched = perpRow({ marketId: "hyperliquid:default:BTC", markPrice: 81_700, observedAt: "2026-10-20T02:00:00.000Z" });
  const newer = { ...fetched, marketId: "HYPERLIQUID:default:BTC", markPrice: 81_750, observedAt: "2026-10-20T02:00:02.000Z" };
  // The quote's casing of the id is the venue's; the view keeps its own.
  expect(withLiveReading(fetched, quote(newer))).toEqual({ ...newer, marketId: fetched.marketId });
  // A refetch that landed after the last tick is not rolled back by it.
  const refetched = { ...fetched, markPrice: 81_760, observedAt: "2026-10-20T02:00:03.000Z" };
  expect(withLiveReading(refetched, quote(newer))).toBe(refetched);
  // Another market's quote, or a quote with no row, changes nothing.
  expect(withLiveReading(fetched, quote({ ...newer, marketId: "bybit:BTCUSDT" }))).toBe(fetched);
  expect(withLiveReading(fetched, quote(undefined))).toBe(fetched);
});

test("a streamed quote reads live only while its venue has priced it within the last minute", () => {
  const now = Date.parse("2026-10-20T02:01:00.000Z");
  const streamed = { ...quote(undefined), dataSource: "live" as const, stale: false, lastUpdated: now - 30_000 };
  expect(isLivePerpQuote(streamed, now)).toBe(true);
  // The socket went quiet: no word from the server, yet the row is no longer live.
  expect(isLivePerpQuote({ ...streamed, lastUpdated: now - 61_000 }, now)).toBe(false);
  expect(isLivePerpQuote({ ...streamed, stale: true }, now)).toBe(false);
  expect(isLivePerpQuote({ ...streamed, dataSource: "delayed" }, now)).toBe(false);
});
