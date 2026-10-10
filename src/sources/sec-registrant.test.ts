import { afterEach, expect, test } from "bun:test";
import { apiClient } from "../api-client";
import { GloomberbCloudProvider } from "./gloomberb-cloud";
import { areDifferentCompanies, SecRegistrantMismatchError } from "./sec-registrant";

const originalGetCloudSecFilings = apiClient.getCloudSecFilings.bind(apiClient);
const originalGetCloudQuote = apiClient.getCloudQuote.bind(apiClient);

afterEach(() => {
  apiClient.getCloudSecFilings = originalGetCloudSecFilings;
  apiClient.getCloudQuote = originalGetCloudQuote;
});

test("a listing's company and the SEC registrant differ only when their distinctive first words do", () => {
  // SAN on Euronext Paris against the SEC's SAN.
  expect(areDifferentCompanies("Sanofi", "Banco Santander, S.A.")).toBe(true);
  for (const [listing, registrant] of [
    ["BP p.l.c.", "BP P.L.C."],
    ["BHP Group Limited", "BHP Group Ltd"],
    ["ASML Holding N.V.", "ASML HOLDING NV"],
    ["Toyota Motor Corporation", "TOYOTA MOTOR CORP/"],
    ["The Toronto-Dominion Bank", "TORONTO DOMINION BANK"],
    ["Amazon.com, Inc.", "AMAZON COM INC"],
    ["Nestlé S.A.", "NESTLE SA"],
    // Nothing to compare is not a conflict.
    ["Sanofi", ""],
    ["S.A.", "Banco Santander, S.A."],
  ]) {
    expect(areDifferentCompanies(listing, registrant)).toBe(false);
  }
});

test("a non-US listing refuses filings an old backend served for the symbol's US registrant", async () => {
  const requests: unknown[] = [];
  const filing = (companyName: string) => ({
    accessionNumber: "1", form: "6-K", filingDate: "2026-10-08", cik: "891478", companyName, filingUrl: "https://www.sec.gov/filing",
  });
  let registrant = "Banco Santander, S.A.";
  apiClient.getCloudSecFilings = async (params) => {
    requests.push(params);
    return { filings: [filing(registrant)], hasMore: false, nextOffset: 1 };
  };
  apiClient.getCloudQuote = async () => ({
    status: "success", data: { symbol: "SAN", name: "Sanofi", price: 71.6, currency: "EUR", change: 0, changePercent: 0, lastUpdated: 1, listingExchangeName: "EPA" },
  }) as never;
  const provider = new GloomberbCloudProvider();

  const refused = await provider.getSecFilings("SAN:EPA", 5).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(SecRegistrantMismatchError);
  expect((refused as Error).message).toBe("No SEC filings found for Sanofi (EPA). The SEC lists SAN as Banco Santander, S.A.");
  // The caller's name saves the quote lookup; the venue and name reach the backend.
  await expect(provider.getSecFilings("SAN", 5, "EPA", { listingName: "Sanofi" })).rejects.toBeInstanceOf(SecRegistrantMismatchError);
  expect(requests.at(-1)).toMatchObject({ ticker: "SAN", exchange: "EPA", name: "Sanofi" });

  registrant = "Sanofi";
  expect((await provider.getSecFilings("SAN:EPA", 5)).map((row) => row.companyName)).toEqual(["Sanofi"]);
  // A US listing is the SEC's own ticker and is never second-guessed.
  registrant = "Banco Santander, S.A.";
  expect(await provider.getSecFilings("SAN", 5, "NYSE", { listingName: "Sanofi" })).toHaveLength(1);
});
