import { expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import { withLiveReading } from "./live-rows";
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
