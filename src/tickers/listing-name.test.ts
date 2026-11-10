import { expect, test } from "bun:test";
import { quotedListingName } from "./listing-name";

test("a quote keyed on the venue asked for names that listing only when it is an index's", () => {
  // ^NDX:NIM's quote names its venue by its publisher, NASDAQ GIDS: it is still the Nasdaq-100 on NIM.
  const index = { symbol: "^NDX:NIM", name: "NASDAQ-100", listingExchangeName: "NASDAQ GIDS", exchangeName: "NASDAQ GIDS" };
  expect(quotedListingName("NIM", { ...index, instrumentType: "INDEX" })).toBe("NASDAQ-100");
  // A security's quote that prices another venue is another listing's company, whatever its key says.
  expect(quotedListingName("LSE", {
    symbol: "VOD:LSE", name: "Vodafone Group Public Limited Company ADR", listingExchangeName: "NASDAQ", exchangeName: "NASDAQ", instrumentType: "EQUITY",
  })).toBeNull();
});
