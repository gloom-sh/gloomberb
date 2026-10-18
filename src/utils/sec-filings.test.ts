import { expect, test } from "bun:test";
import { currentReportItemsLabel, isPricingSupplement, loadWithoutPricingSupplements } from "./sec-filings";
import type { SecFilingItem } from "../types/data-provider";

test.each([
  ["424B2", "PRELIMINARY PRICING SUPPLEMENT NO. 303", true],
  ["FWP", "FREE WRITING PROSPECTUS", true],
  ["424B2/A", "", true],
  // JPM files its note term sheets as 424B3 too; a 424B3 that does not say so is a merger or resale prospectus.
  ["424B3", "TERM SHEET NO. 12", true],
  ["424B3", "FORM 424B3", false],
  ["424B5", "PROSPECTUS SUPPLEMENT", false],
  ["8-K", "PRICING SUPPLEMENT", false],
])("%s (%s) is a pricing supplement: %p", (form, primaryDocDescription, expected) => {
  expect(isPricingSupplement({ form, primaryDocDescription })).toBe(expected);
});

test("an 8-K's items read by number and name, exhibits only when alone", () => {
  expect(currentReportItemsLabel("2.02,7.01,9.01")).toBe("2.02 Results of operations; 7.01 Regulation FD disclosure");
  expect(currentReportItemsLabel("9.01")).toBe("9.01 Exhibits");
  expect(currentReportItemsLabel(" 5.02 , 9.01 ")).toBe("5.02 Officer or director change");
  expect(currentReportItemsLabel("")).toBeNull();
  expect(currentReportItemsLabel(undefined)).toBeNull();
});

test("an issuer the first read leaves short is read in full; a short list is all there is", async () => {
  const filing = (form: string, index: number): SecFilingItem => ({ form, accessionNumber: String(index), filingDate: new Date(0), cik: "72971", filingUrl: "" });
  const reads: number[] = [];
  const issuer = [...Array.from({ length: 250 }, (_, index) => filing("424B2", index)), filing("8-K", 900), filing("10-Q", 901)];
  const load = async (count: number) => { reads.push(count); return issuer.slice(0, count); };

  expect(await loadWithoutPricingSupplements(load, 2)).toMatchObject({ hidden: 250, filings: [{ form: "8-K" }, { form: "10-Q" }] });
  expect(reads).toEqual([200, 20_000]);

  reads.length = 0;
  const few = issuer.slice(240);
  expect(await loadWithoutPricingSupplements(async (count) => { reads.push(count); return few.slice(0, count); }, 5))
    .toMatchObject({ hidden: 10, filings: [{ form: "8-K" }, { form: "10-Q" }] });
  expect(reads).toEqual([200]);
});
