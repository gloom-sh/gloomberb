import { expect, test } from "bun:test";
import { quoteMetadataMatchesTarget } from "./metadata";

test("an index saved from search matches its quote whatever the quote calls its venue; a stock still needs its own", () => {
  // Search files ^VIX under CXI and ^RUT under WCB; their quotes name CBOE INDICES and CHICAGO OPTIONS.
  expect(quoteMetadataMatchesTarget({ symbol: "^VIX", listingExchangeName: "CBOE INDICES", source: {} }, "^VIX", "CXI")).toBe(true);
  expect(quoteMetadataMatchesTarget({ symbol: "^RUT", listingExchangeName: "CHICAGO OPTIONS", source: {} }, "^RUT:WCB")).toBe(true);
  expect(quoteMetadataMatchesTarget({ symbol: "^VIX3M", listingExchangeName: "CBOE INDICES", source: {} }, "^VIX", "CXI")).toBe(false);
  expect(quoteMetadataMatchesTarget({ symbol: "SAN", listingExchangeName: "NYSE", source: {} }, "SAN", "EPA")).toBe(false);
});
