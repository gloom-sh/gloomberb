# Bring your own licensed market data

Connect your entitled, documented feed API through Gloom's existing `assetDataProvider` capability. Panes and the CLI use the shared router, not per-pane adapters.

## Rights and a clean profile

Use a fresh, signed-out local profile. Confirm API, storage, sync, export and sharing rights. Keep credentials in your environment or credential store. Keep secrets and licensed data out of repositories, logs and screenshots.

Generic providers are **not** covered by `BrokerAdapter.localMarketData` and may sync if signed in. This guide does not enforce non-redistribution.

This guide does not implement or endorse a TradingView bridge; a subscription does not establish external API/reuse permission. Confirm [current terms](https://www.tradingview.com/policies/) and permissions before any separate community bridge.

## One quote adapter

Create `licensed-feed-demo/` outside the checkout with these files. For dependencies, see [Developing a plugin](../PLUGINS.md#developing-a-plugin). The fixture is synthetic, never live.

`gloom.json`:

```json
{ "id": "licensed-feed-demo", "name": "Licensed feed demo", "minGloom": "0.20.14" }
```

`index.ts`:

```typescript
import { assetDataProvider } from "gloomberb/capabilities";
import { createProviderMiss } from "gloomberb/market-data";
import type { AssetDataProvider } from "gloomberb/types/data-provider";
import type { QuoteDataSource } from "gloomberb/types/financials";
import type { GloomPlugin } from "gloomberb/types/plugin";

const listing = { symbol: "ESZ26", exchange: "CME" };
const providerId = "licensed-feed-demo";
const supports = (symbol: string, exchange?: string) =>
  exchange === listing.exchange
  && (symbol === listing.symbol || symbol === `${listing.symbol}:${listing.exchange}`);

type FeedQuote = {
  symbol: string;
  exchange: string;
  price: number;
  previousClose: number;
  tradeTimeMs: number;
  retrievedAtMs: number;
  dataSource: QuoteDataSource;
};
type ReadQuote = (request: typeof listing) => Promise<FeedQuote | null>;

function unavailable(subject: string): never {
  const reason = `No entitled data for ${subject} from this adapter.`;
  throw createProviderMiss(reason, reason);
}

export function createProvider(readQuote: ReadQuote): AssetDataProvider {
  return {
    id: providerId,
    name: "Synthetic snapshot demo",
    priority: 50,
    canProvide: supports,
    async getQuote(symbol, exchange) {
      if (!supports(symbol, exchange)) return unavailable(`${symbol}:${exchange ?? "?"}`);
      const value = await readQuote(listing);
      if (!value) return unavailable(`${symbol}:${exchange}`);
      if (value.symbol !== listing.symbol || value.exchange !== listing.exchange) {
        throw new Error("Feed returned a different contract or venue.");
      }
      if (![value.price, value.previousClose, value.tradeTimeMs, value.retrievedAtMs].every(Number.isFinite)
        || value.previousClose <= 0 || value.tradeTimeMs <= 0 || value.retrievedAtMs <= 0) {
        throw new Error("Feed returned an invalid price, reference close or timestamp.");
      }
      return {
        symbol: listing.symbol,
        name: "Synthetic ES December 2026 snapshot",
        instrumentType: "FUTURE",
        providerId,
        exchangeName: listing.exchange,
        listingExchangeName: listing.exchange,
        currency: "USD",
        price: value.price,
        previousClose: value.previousClose,
        change: value.price - value.previousClose,
        changePercent: (value.price / value.previousClose - 1) * 100,
        lastUpdated: value.tradeTimeMs,
        lastTradePrice: value.price,
        lastTradeTime: value.tradeTimeMs,
        retrievedAt: value.retrievedAtMs,
        dataSource: value.dataSource,
        delivery: "poll",
      };
    },
    getTickerFinancials: async (symbol) => unavailable(`financials for ${symbol}`),
    getExchangeRate: async (currency) => unavailable(`FX ${currency}`),
    search: async () => [],
    getArticleSummary: async () => null,
    getPriceHistory: async (symbol) => unavailable(`history for ${symbol}`),
  };
}

const provider = createProvider(async (request) => ({
  ...request,
  price: 6251.25,
  previousClose: 6240,
  tradeTimeMs: Date.parse("2026-11-13T20:00:00Z"),
  retrievedAtMs: Date.parse("2026-11-13T20:00:02Z"),
  dataSource: "snapshot",
}));

export default {
  id: providerId,
  name: "Licensed feed demo",
  version: "1.0.0",
  capabilities: [assetDataProvider(provider)],
} satisfies GloomPlugin;
```

- Map `ESZ26:CME` to your feed's documented December 2026 E-mini S&P 500 contract on CME. Never substitute a continuous future, another expiry or venue.

- **Replace the callback passed to `createProvider` with your licensed feed API call.** The request shape is adapter-owned, not a vendor API. Return `null` for unavailable/unentitled data; surface authentication, transport and malformed-response errors. Rename synthetic labels. Declare fetched hosts in the plugin's `hosts` and `gloom.json` ([Network access](../PLUGINS.md#network-access)).

- Use a genuine reference close for the same contract, currency and units. Return a miss if unavailable; never invent financials.

- Preserve source trade time in `lastUpdated`/`lastTradeTime` and retrieval completion time in `retrievedAt`, in epoch milliseconds. Cached observations retain original timestamps. Set `dataSource` to `"live"`, `"delayed"` or `"snapshot"` from actual entitlement/response metadata. Polling real-time observations is still `delivery: "poll"`, not tick-by-tick streaming. Omit `subscribeQuotes`.

## Link, check and read

With Gloom installed, run from the parent directory in a fresh shell. Choose a profile path that does not exist:

```bash
export GLOOMBERB_HOME="$HOME/.cache/gloom-smoke/licensed-feed-demo"
export GLOOMBERB_NO_TELEMETRY=1 DO_NOT_TRACK=1
unset GLOOMBERB_SESSION_TOKEN
gloom plugin link ./licensed-feed-demo
gloom plugin doctor licensed-feed-demo
gloom api invoke asset-data.licensed-feed-demo.getQuote '{"ticker":"ESZ26","exchange":"CME"}' --json
gloom api invoke asset-data.licensed-feed-demo.canProvide '{"ticker":"ESZ26","exchange":"NYMEX"}' --json
gloom api invoke asset-data.licensed-feed-demo.getQuote '{"ticker":"ESZ26","exchange":"NYMEX"}' --json
gloom quote ESZ26:CME --json
```

Expect `6251.25`, `snapshot`, `poll` and distinct trade/retrieval timestamps. The wrong venue returns `false`, then a deliberate provider miss.

In `quote --json`, check each row's `quote.providerId`, `dataSource`, `lastTradeTime` and `retrievedAt`. Restart running Gloom apps after linking or editing. Doctor checks compatibility/builds, not feed access.

Ascending priority puts `50` before Gloom Cloud's `100`, not an exclusive override. `createProviderMiss` permits fallback; routed reads may contact other sources or return stale cached data, and financials may merge across sources.

Test missing/wrong venues, another expiry, unavailable entitlement and delayed/cached observations before real use. Remove your throwaway profile and close the shell.
