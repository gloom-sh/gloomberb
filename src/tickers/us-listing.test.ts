import { expect, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import { findUsListingOfCompany } from "./us-listing";

test("a company's US line by its name: an exchange listing first, one over the counter only when asked for", async () => {
  const line = (symbol: string, exchange: string, name = "Roche Holding AG") =>
    ({ providerId: "test", symbol, name, exchange, type: "Common Stock", currency: "USD" });
  const listed = { roche: [line("RHHBY", "PNK"), line("RHHVF", "OTC")], sanofi: [line("SNYNF", "OTC", "Sanofi"), line("SNY", "NASDAQ", "Sanofi")] };
  const dataProvider = createTestDataProvider({ search: async (query) => listed[query.toLowerCase() as keyof typeof listed] ?? [] });
  // Roche has no US exchange listing: its OTC receipt only for data that covers one.
  expect(await findUsListingOfCompany(dataProvider, "Roche")).toBeNull();
  expect(await findUsListingOfCompany(dataProvider, "Roche", { otc: true })).toEqual({ symbol: "RHHBY", exchange: "PNK", name: "Roche Holding AG" });
  // Sanofi's NASDAQ line outranks its OTC ordinary shares, listed first.
  expect((await findUsListingOfCompany(dataProvider, "Sanofi", { otc: true }))?.symbol).toBe("SNY");
});
