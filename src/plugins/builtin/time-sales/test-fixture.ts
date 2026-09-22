import type { TapeSnapshot } from "../../../api-client/tape";

export function tapeFixture(): TapeSnapshot {
  return { source: "Alpaca", symbol: "AAPL", exchange: "NASDAQ", access: "realtime", feed: "sip", delaySeconds: 0,
    status: "partial", generatedAt: "2026-09-22T16:00:00.000Z", asOf: "2026-09-22T15:59:59.000000009Z", observedFrom: "2026-09-22T15:59:59.000000001Z",
    trades: [1, 9].map((ns, index) => ({ id: `900719925474099${index + 2}`, timestamp: `2026-09-22T15:59:59.00000000${ns}Z`, price: index ? 102 : 100,
      size: index ? 30 : 10, exchange: "D", conditions: ["@", "I"], tape: "C" })),
    quotes: [{ timestamp: "2026-09-22T15:59:59.100Z", bid: 102, ask: 101, bidSize: 1, askSize: 3, bidExchange: "Q", askExchange: "P", conditions: ["R"], tape: "C" }],
    session: { date: null, high: null, low: null, asOf: null }, capacity: { trades: 1000, quotes: 500 }, dropped: { trades: 0, quotes: 0 },
    corrections: 0, cancels: 0, connected: true, gaps: ["Observed window only"] };
}

