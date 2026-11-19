import { afterEach, expect, test } from "bun:test";
import type { PluginRegistry } from "../../registry";
import { setSharedRegistryForTests } from "../../registry/shared";
import { createTestQuote } from "../../../test-support/data-provider";
import { quoteSourceFooterSegment } from "./source-footer";

afterEach(() => setSharedRegistryForTests(undefined));

test("the quotes' footer names each source, a broker by its adapter's name, and leaves the source out when one has no name", () => {
  setSharedRegistryForTests({ getBrokerAdapter: (type: string) => type === "ibkr" ? { name: "Interactive Brokers" } : null } as unknown as PluginRegistry);
  const now = Date.parse("2026-10-12T15:00:00Z");
  const quote = (providerId: string) => createTestQuote({
    providerId, listingExchangeName: "NASDAQ", marketState: "REGULAR", lastUpdated: Date.parse("2026-10-12T14:45:00Z"),
  });
  const footer = (...providerIds: string[]) => quoteSourceFooterSegment(providerIds.map(quote), { now })!.parts.map((part) => part.text).join("");

  expect(footer("gloomberb-cloud")).toStartWith("Gloom Cloud · ");
  expect(footer("gloomberb-cloud", "ibkr")).toStartWith("Gloom Cloud and Interactive Brokers · ");
  for (const providerIds of [["acme-feed"], ["gloomberb-cloud", "acme-feed"]]) {
    expect(footer(...providerIds)).not.toContain("Gloom Cloud");
    expect(footer(...providerIds)).toContain("14:45 UTC");
  }
});
