import type { CryptoMarketAsset, CryptoMarketsPayload } from "../../../api-client/crypto-markets";

/** 2026-09-23 12:00 UTC; closes run 2026-08-24 through 2026-09-22. */
export const CRYPTO_FIXTURE_NOW = Date.parse("2026-09-23T12:00:00Z");

function asset(overrides: Partial<CryptoMarketAsset> & Pick<CryptoMarketAsset, "symbol" | "code" | "name">): CryptoMarketAsset {
  return {
    kind: "coin",
    rank: 1,
    price: 100,
    previousClose: 98,
    change: 2,
    changePercent: 2.0408,
    dayHigh: 101,
    dayLow: 97,
    volume24h: 5_000_000_000,
    marketCap: 1_000_000_000_000,
    circulatingSupply: 10_000_000_000,
    maxSupply: null,
    high52w: 150,
    low52w: 60,
    yearAgoPrice: 80,
    quoteTime: "2026-09-23T11:59:00.000Z",
    // Close n is 70 + n: 30 days ago 70, 7 days ago 93, yesterday 99.
    history: { start: "2026-08-24", closes: Array.from({ length: 30 }, (_, index) => 70 + index) },
    ...overrides,
  };
}

export function cryptoFixture(): CryptoMarketsPayload {
  return {
    version: 1,
    generatedAt: "2026-09-23T11:59:30.000Z",
    asOf: "2026-09-23T11:59:00.000Z",
    status: "available",
    source: {
      name: "Yahoo Finance",
      url: "https://finance.yahoo.com/markets/crypto/all/",
      screenerFetchedAt: "2026-09-23T11:59:30.000Z",
      historyFetchedAt: "2026-09-23T00:05:00.000Z",
    },
    assets: [
      asset({ symbol: "BTC-USD", code: "BTC", name: "Bitcoin" }),
      asset({
        symbol: "HYPE32196-USD",
        code: "HYPE",
        name: "Hyperliquid",
        rank: 2,
        price: 40,
        previousClose: 42,
        change: -2,
        changePercent: -4.7619,
        marketCap: 20_000_000_000,
        circulatingSupply: 500_000_000,
        volume24h: 900_000_000,
        yearAgoPrice: null,
        history: null,
      }),
      asset({
        symbol: "USDT-USD",
        code: "USDT",
        name: "Tether USDt",
        kind: "stablecoin",
        rank: 1,
        price: 0.9998,
        previousClose: 1,
        change: -0.0002,
        changePercent: -0.02,
        marketCap: 180_000_000_000,
        circulatingSupply: 180_036_000_000,
        volume24h: 100_000_000_000,
        high52w: 1.001,
        low52w: 0.998,
        yearAgoPrice: 1,
        history: { start: "2026-08-24", closes: Array.from({ length: 30 }, () => 1) },
      }),
    ],
    warnings: [],
  };
}
