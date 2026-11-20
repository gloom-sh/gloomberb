import { expect, test } from "bun:test";
import { createTestQuote } from "../../../test-support/data-provider";
import { quoteSourceFooterSegment } from "./source-footer";

test("the quotes' footer names each source, a broker by its adapter's name, and leaves the source out when one has no name", () => {
  const now = Date.parse("2026-10-12T15:00:00Z");
  const brokerName = (providerId: string) => providerId === "ibkr" ? "Interactive Brokers" : null;
  const quote = (providerId: string) => createTestQuote({
    providerId, listingExchangeName: "NASDAQ", marketState: "REGULAR", lastUpdated: Date.parse("2026-10-12T14:45:00Z"),
  });
  const footer = (...providerIds: string[]) => quoteSourceFooterSegment(providerIds.map(quote), { now, brokerName })!.parts.map((part) => part.text).join("");

  expect(footer("gloomberb-cloud")).toStartWith("Gloom Cloud · ");
  expect(footer("gloomberb-cloud", "ibkr")).toStartWith("Gloom Cloud and Interactive Brokers · ");
  for (const providerIds of [["acme-feed"], ["gloomberb-cloud", "acme-feed"]]) {
    expect(footer(...providerIds)).not.toContain("Gloom Cloud");
    expect(footer(...providerIds)).toContain("14:45 UTC");
  }
});
