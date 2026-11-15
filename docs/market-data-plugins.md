# Bring your own licensed market data

Connect a documented feed API you are entitled to use through Gloom's existing `assetDataProvider` plugin capability. It takes an `AssetDataProvider` from `gloomberb/types/data-provider`; panes and the CLI use the shared market-data router, not a separate per-pane data path. This guide adds no feed or bridge.

## Rights and a clean profile

Confirm your feed licence permits the API access, venues, instruments, display, processing and local storage you intend. Keep credentials in your process environment or credential store, never in plugin source. Keep licensed payloads, quotes, caches and exports out of the repository, logs, issues and screenshots; the fixture below is synthetic.

Use a new, signed-out local profile for this CLI-only demonstration. Do not sign it into Gloom Cloud or copy an existing profile into it. This is isolation for the demonstration, **not enforcement of non-redistribution**. A generic asset-data provider is not protected by `BrokerAdapter.localMarketData`: the sync filter checks the broker registry/config, not arbitrary providers. Do not assume its data is excluded from Cloud sync. Before using a real feed in a signed-in profile, exporting, sharing panes or sending screenshots, confirm the applicable sync/export/sharing rights and what those paths carry.

This guide does not implement or endorse a TradingView bridge. A subscription is not an assumption of external API or reuse permission. Review the [current TradingView terms](https://www.tradingview.com/policies/), especially sections 3 and 12, and confirm applicable terms and permissions before attempting any separate community bridge.

## One quote adapter

Create a directory outside the Gloom checkout, `licensed-feed-demo/`, containing these two files. For editor/type-check setup, use the dependencies described in [Developing a plugin](../PLUGINS.md#developing-a-plugin).

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

The request shape is adapter-owned, **not a vendor API**. `ESZ26:CME` explicitly means the December 2026 E-mini S&P 500 futures contract on CME here. The guard accepts both the bare symbol and Gloom's venue-qualified spelling, always with the matching exchange argument. In the callback, map that pair to your feed's documented contract identifier, expiry and venue, and validate the response identity. Never silently substitute a continuous future, another expiry, a CFD or another venue. Missing venues and unsupported symbols are rejected, including when a quote read calls the method without first calling `canProvide`.

**Replace the callback passed to `createProvider` with your licensed feed API call.** Check entitlement before returning a quote; return `null` for unavailable/not-entitled data. Let authentication, transport and malformed-response errors surface rather than disguising every failure as a miss. Declare the actual fetched hosts in both the plugin's `hosts` and `gloom.json` ([Network access](../PLUGINS.md#network-access)); the synthetic example fetches nothing. Rename the synthetic labels for a real adapter, and keep secrets out of browser bundles.

All required provider methods are present: unsupported financials, FX and history throw a provider miss, search has no results, and article summaries are absent. Do not fabricate zero financials to satisfy the interface. The quote requires a genuine reference close for the same contract, currency and units to compute its move; if unavailable, return a miss rather than inventing one. Add real history or other methods only when licensed and correctly mapped.

Preserve the source trade time in `lastUpdated`/`lastTradeTime`, and its original retrieval time in `retrievedAt` (epoch milliseconds). If your API retrieves a fresh observation directly, record when that retrieval completes; a cached observation retains its original retrieval time. Do not replace the trade time with `Date.now()` or re-date a saved copy. Map actual feed entitlement/response metadata to `dataSource: "live"`, `"delayed"` or `"snapshot"`; polling a real-time observation is still `delivery: "poll"`, not tick-by-tick streaming. A paid account alone does not establish live entitlement. This fixture is a fixed, dated synthetic snapshot, never live; an absent stale flag is not evidence of freshness. No `subscribeQuotes` implementation is needed here.

## Link, check and read

With Gloom installed, run from the parent of `licensed-feed-demo/` in a fresh shell. Pick a profile path that does not already exist:

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

The first invocation must return `6251.25`, `dataSource: "snapshot"`, `delivery: "poll"` and the two distinct fixture timestamps. The wrong venue returns `false` from `canProvide`; its direct quote invocation deliberately fails with a provider miss. Direct capability invocation isolates the adapter; `quote` exercises the normal router and can answer from another source or mark the old snapshot stale. It may contact other configured sources, including Gloom Cloud.

In `quote --json`, inspect each row's `quote.providerId`, `quote.dataSource`, `quote.delivery`, `quote.lastTradeTime` and `quote.retrievedAt`, not just the price. The command-level source/freshness summary currently defaults to Gloom Cloud for this generic provider and dates the export separately; it does not establish your feed's identity or entitlement. Each CLI command is a fresh process; restart any running Gloom app after linking or editing the plugin. Doctor validates plugin compatibility/builds, not your feed licence or live data access.

Sources sort by ascending priority: this example's `50` precedes the Gloom Cloud market provider's `100`. Priority is not an exclusive override: quotes are checked for listing identity and freshness, caches and broker routes also participate, and financials can be enriched/merged across sources. A `createProviderMiss` lets the router try another source without logging a provider failure; a miss is not an entitlement firewall for other sources. Verify each source's permissions separately. With no usable answer, expect a reason/no-provider error or a dated stale last-known quote, not an invented price.

After the demonstration, remove only the throwaway profile you created and close that shell. Keep real-feed verification local and within your licence: test a supported contract, wrong/missing venue, another expiry, unavailable entitlement, and delayed/cached observations before using the adapter for decisions.
