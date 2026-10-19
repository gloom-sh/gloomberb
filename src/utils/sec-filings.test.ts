import { expect, test } from "bun:test";
import { currentReportItemsLabel, hiddenFilingsNote, isPricingSupplement, isScheduleAboutAnotherCompany, loadLatestFilings } from "./sec-filings";
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
  expect(currentReportItemsLabel("6.02")).toBe("6.02 Servicer or trustee change");
  // Every item Form 8-K has, the asset-backed 6.0x ones included, has a name of its own.
  const items = ["1.01", "1.02", "1.03", "1.04", "1.05", "2.01", "2.02", "2.03", "2.04", "2.05", "2.06", "3.01", "3.02", "3.03",
    "4.01", "4.02", "5.01", "5.02", "5.03", "5.04", "5.05", "5.06", "5.07", "5.08", "6.01", "6.02", "6.03", "6.04", "6.05", "6.06",
    "6.10", "7.01", "8.01", "9.01"];
  expect(items.filter((code) => currentReportItemsLabel(code)?.includes("Item"))).toEqual([]);
  expect(currentReportItemsLabel("")).toBeNull();
  expect(currentReportItemsLabel(undefined)).toBeNull();
});

test.each([
  // JPM's own 13G/A as a holder: EDGAR lists it with no file number.
  ["SCHEDULE 13G/A", "", true],
  ["SC 13D", "", true],
  ["SCHEDULE 13D/A", "", true],
  // A schedule about the company carries its 005- number (Apple's, JPM's own).
  ["SCHEDULE 13G", "005-34242", false],
  ["SC 13G/A", "005-33632", false],
  // No file number from the source (an older server): kept, never guessed.
  ["SCHEDULE 13G/A", undefined, false],
  ["8-K", "", false],
])("%s with file number %p is about another company: %p", (form, fileNumber, expected) => {
  expect(isScheduleAboutAnotherCompany({ form, fileNumber })).toBe(expected);
});

test("the hidden filings read as one note", () => {
  expect(hiddenFilingsNote({ pricingSupplements: 1_164, ownershipReportsAboutOthers: 0 })).toBe("1,164 pricing supplements hidden, --all to show");
  expect(hiddenFilingsNote({ pricingSupplements: 0, ownershipReportsAboutOthers: 1 })).toBe("1 ownership report about another company hidden, --all to show");
  expect(hiddenFilingsNote({ pricingSupplements: 28, ownershipReportsAboutOthers: 22 }))
    .toBe("28 pricing supplements and 22 ownership reports about other companies hidden, --all to show");
  expect(hiddenFilingsNote({ pricingSupplements: 0, ownershipReportsAboutOthers: 0 })).toBeNull();
});

test("a read that leaves the list short is followed by a larger one, up to the issuer in full; a short list is all there is", async () => {
  const filing = (form: string, index: number, fileNumber?: string): SecFilingItem =>
    ({ form, accessionNumber: String(index), filingDate: new Date(0), cik: "72971", filingUrl: "", fileNumber });
  const reads: number[] = [];
  const issuer = [
    ...Array.from({ length: 250 }, (_, index) => filing("424B2", index)),
    filing("8-K", 900),
    filing("SCHEDULE 13G/A", 901, ""),
    filing("10-Q", 902),
    ...Array.from({ length: 6_000 }, (_, index) => filing("FWP", 1_000 + index)),
    filing("10-K", 9_000),
  ];
  const load = async (count: number) => { reads.push(count); return issuer.slice(0, count); };

  expect(await loadLatestFilings(load, 2)).toMatchObject({
    hidden: { pricingSupplements: 250, ownershipReportsAboutOthers: 0 }, filings: [{ form: "8-K" }, { form: "SCHEDULE 13G/A" }],
  });
  expect(reads).toEqual([200, 1_000]);

  reads.length = 0;
  expect(await loadLatestFilings(load, 3, { schedulesAboutOthers: true })).toMatchObject({
    hidden: { pricingSupplements: 6_250, ownershipReportsAboutOthers: 1 }, filings: [{ form: "8-K" }, { form: "10-Q" }, { form: "10-K" }],
  });
  expect(reads).toEqual([200, 1_000, 5_000, 20_000]);

  reads.length = 0;
  const few = issuer.slice(240, 253);
  expect(await loadLatestFilings(async (count) => { reads.push(count); return few.slice(0, count); }, 5, { schedulesAboutOthers: true }))
    .toMatchObject({ hidden: { pricingSupplements: 10, ownershipReportsAboutOthers: 1 }, filings: [{ form: "8-K" }, { form: "10-Q" }] });
  expect(reads).toEqual([200]);
});
