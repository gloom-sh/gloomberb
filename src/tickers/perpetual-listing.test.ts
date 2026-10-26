import { describe, expect, test } from "bun:test";
import { resolveTickerInstrumentKind } from "./instrument-kind";
import {
  perpetualDisplaySymbol,
  perpetualListing,
  perpetualListingOfMarket,
  perpetualMarketIds,
  typedPerpetualListing,
} from "./perpetual-listing";
import { createTestTicker } from "../test-support/ticker";

describe("perpetual listings", () => {
  test("a market id and its listing name the same contract both ways, the venue as the exchange", () => {
    const cases = [
      ["binance:BZUSDT", "BZUSDT:BINANCE"],
      ["hyperliquid:default:BTC", "BTC:HYPERLIQUID"],
      ["hyperliquid:xyz:BRENTOIL", "XYZ-BRENTOIL:HYPERLIQUID"],
      ["okx:BTC-USDT-SWAP", "BTC-USDT-SWAP:OKX"],
      ["bybit:BTCUSDT", "BTCUSDT:BYBIT"],
    ] as const;
    for (const [marketId, key] of cases) {
      expect(perpetualListingOfMarket(marketId)?.key).toBe(key);
      // A saved key is upper case and may arrive split into symbol and exchange.
      const [symbol, exchange] = [key.slice(0, key.lastIndexOf(":")), key.slice(key.lastIndexOf(":") + 1)];
      expect(perpetualListing(key)?.marketId).toBe(marketId);
      expect(perpetualListing(symbol, exchange)?.marketId).toBe(marketId);
    }
  });

  test("the same contract name on two venues is two listings, and a venue's spot pair is not a perpetual", () => {
    expect(perpetualListingOfMarket("binance:BTCUSDT")?.key).not.toBe(perpetualListingOfMarket("bybit:BTCUSDT")?.key);
    // Search lists spot pairs on the same venues with a slash: ETH/USD on BINANCE is the coin, not a contract.
    expect(perpetualListing("ETH/USD", "BINANCE")).toBeNull();
    expect(perpetualListing("BTC-USD:BINANCE")).toBeNull();
    expect(perpetualListing("BTC-USD", "CCC")).toBeNull();
    // dYdX has no spot market: its pairs are its perpetuals, and a market PERP opens is quoted as one.
    expect(perpetualListing("BTC-USD", "DYDX")?.marketId).toBe("dydx:BTC-USD");
    expect(perpetualListing(perpetualListingOfMarket("dydx:ETH-USD")!.key)?.marketId).toBe("dydx:ETH-USD");
    expect(perpetualListing("AAPL", "NASDAQ")).toBeNull();
    // Kraken and Coinbase are spot venues in search; their perpetual adapters are off.
    expect(perpetualListing("ETH", "KRAKEN")).toBeNull();
  });

  test("a saved Hyperliquid coin with a small k is also asked for that way", () => {
    expect(perpetualMarketIds(perpetualListing("KPEPE:HYPERLIQUID")!)).toEqual(["hyperliquid:default:KPEPE", "hyperliquid:default:kPEPE"]);
    expect(perpetualMarketIds(perpetualListing("BZUSDT:BINANCE")!)).toEqual(["binance:BZUSDT"]);
  });

  test("typed market ids and Hyperliquid's dex names read as listings; a symbol on an exchange does not", () => {
    expect(typedPerpetualListing("binance:BZUSDT")?.key).toBe("BZUSDT:BINANCE");
    expect(typedPerpetualListing("BINANCE:BZUSDT")?.key).toBe("BZUSDT:BINANCE");
    expect(typedPerpetualListing("HYPERLIQUID:XYZ:BRENTOIL")?.marketId).toBe("hyperliquid:xyz:BRENTOIL");
    expect(typedPerpetualListing("xyz:BRENTOIL")?.key).toBe("XYZ-BRENTOIL:HYPERLIQUID");
    expect(typedPerpetualListing("OKX:NYSE")).toBeNull();
    expect(typedPerpetualListing("san:EPA")).toBeNull();
    expect(typedPerpetualListing("BZUSDT:BINANCE")).toBeNull();
    expect(typedPerpetualListing("AAPL")).toBeNull();
  });

  test("a narrow column shows the contract as its venue writes it", () => {
    expect(perpetualDisplaySymbol(perpetualListing("XYZ-BRENTOIL:HYPERLIQUID")!)).toBe("xyz:BRENTOIL");
    expect(perpetualDisplaySymbol(perpetualListing("BZUSDT:BINANCE")!)).toBe("BZUSDT");
    expect(perpetualDisplaySymbol(perpetualListing("BTC:HYPERLIQUID")!)).toBe("BTC");
  });

  test("a perpetual listing is its own instrument kind, so company research stays off it", () => {
    expect(resolveTickerInstrumentKind(createTestTicker("BZUSDT:BINANCE", "Brent crude oil perpetual", { exchange: "BINANCE" }))).toBe("perpetual");
    expect(resolveTickerInstrumentKind(createTestTicker("ETH/USD", "Ethereum", { exchange: "BINANCE" }))).toBe("equity");
  });
});
