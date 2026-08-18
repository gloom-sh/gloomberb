import type { ConnectionHealthRegistry } from "../../core/connection-health";
import type { DataProvider } from "../../types/data-provider";

const REQUEST_METHODS = new Set([
  "getQuotesBatch",
  "getTickerFinancialsBatch",
  "getTickerFinancials",
  "getQuote",
  "getExchangeRate",
  "search",
  "getNews",
  "getHolders",
  "getAnalystResearch",
  "getCorporateActions",
  "getEarningsCalendar",
  "getSecFilings",
  "getSecFilingDocuments",
  "getSecFilingContent",
  "getArticleSummary",
  "getPriceHistory",
  "getPriceHistoryForResolution",
  "getDetailedPriceHistory",
  "getOptionsChain",
]);

/** Wraps provider calls without changing the provider object or treating router cache reads as requests. */
export function withProviderConnectionHealth(
  provider: DataProvider,
  health: ConnectionHealthRegistry,
): DataProvider {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(provider, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || typeof value !== "function") return value;
      if (!REQUEST_METHODS.has(property)) return value.bind(target);
      if (!methods.has(property)) {
        methods.set(property, (...args: unknown[]) => health.track(
          `asset-data.${provider.id}`,
          property,
          () => Promise.resolve(value.apply(target, args)),
        ));
      }
      return methods.get(property);
    },
  });
}
