import { expect, test } from "bun:test";
import { createTestQuote } from "../../../test-support/data-provider";
import { bookSource } from "./report-freshness";

test("a book cites the sources of the quotes it is valued at, and leaves the prices' source out when one has no name", () => {
  const quote = (providerId: string) => createTestQuote({ providerId });
  const names: Record<string, string> = { ibkr: "Interactive Brokers", "acme-feed": "Acme Feed" };
  const nameOf = (providerId: string) => names[providerId];

  expect(bookSource("Local portfolio", [quote("gloomberb-cloud"), quote("gloomberb-cloud")])).toBe("Local portfolio and Gloom Cloud");
  expect(bookSource("Your broker account", [quote("gloomberb-cloud"), quote("ibkr")], nameOf)).toBe("Your broker account and Gloom Cloud and Interactive Brokers");
  expect(bookSource("Local watchlist", [quote("acme-feed")], nameOf)).toBe("Local watchlist and Acme Feed");
  expect(bookSource("Local watchlist", [quote("gloomberb-cloud"), quote("acme-feed")])).toBe("Local watchlist");
  // Nothing priced: as before, Gloom Cloud is who was asked.
  expect(bookSource("Local watchlist", [null, undefined])).toBe("Local watchlist and Gloom Cloud");
});
