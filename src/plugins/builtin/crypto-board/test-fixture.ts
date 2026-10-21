import type { CryptoMarketAsset, CryptoMarketsPayload, StablecoinSupplyPayload } from "../../../api-client/crypto-markets";

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
    dayChangeBasis: "utc-day",
    asOf: "2026-09-23T11:59:00.000Z",
    status: "available",
    source: {
      name: "Gloom",
      url: "https://gloom.sh",
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
        peg: { currency: "USD", accrues: false, price: 1, asOf: null },
        range24h: {
          low: 0.9983, lowAt: "2026-09-22T23:30:00.000Z", high: 1.0004, highAt: "2026-09-23T03:05:00.000Z",
          start: "2026-09-22T11:59:00.000Z", end: "2026-09-23T11:59:00.000Z",
        },
      }),
    ],
    warnings: [],
  };
}

/**
 * Supply for the fixture's USDT and one coin the board does not list, over
 * five days from 2026-09-19: the total, USDT and USDC charted, the rest Other.
 */
export function stablecoinSupplyFixture(): StablecoinSupplyPayload {
  return {
    version: 1,
    generatedAt: "2026-09-23T11:00:00.000Z",
    fetchedAt: "2026-09-23T00:10:00.000Z",
    asOf: "2026-09-23",
    status: "available",
    source: { name: "Gloom Cloud", url: "https://gloom.sh" },
    total: { supply: 300e9, change7d: -1.5e9, change7dPercent: -0.5, change30d: 1.8e9, change30dPercent: 0.6 },
    coins: [
      {
        symbol: "USDT", name: "Tether", pegType: "peggedUSD", pegMechanism: "fiat-backed", price: 0.9998, supply: 180e9,
        change7d: -0.6e9, change7dPercent: -0.33, change30d: 0.2e9, change30dPercent: 0.11, share: 60,
      },
      {
        symbol: "USDC", name: "USD Coin", pegType: "peggedUSD", pegMechanism: "fiat-backed", price: 1, supply: 72e9,
        change7d: -0.6e9, change7dPercent: -0.87, change30d: -1.4e9, change30dPercent: -1.92, share: 24,
      },
    ],
    history: {
      start: "2026-09-19",
      total: [296e9, 297e9, null, 299e9, 300e9],
      coins: [
        { symbol: "USDT", name: "Tether", values: [178e9, 179e9, null, 180e9, 180e9] },
        // Before a coin existed its days are null.
        { symbol: "USDC", name: "USD Coin", values: [null, 70e9, 71e9, 72e9, 72e9] },
      ],
    },
    warnings: [],
  };
}
