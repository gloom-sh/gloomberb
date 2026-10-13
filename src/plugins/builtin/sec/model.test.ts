import { expect, test } from "bun:test";
import type { SecFilingItem } from "../../../types/data-provider";
import { COMPANY_FORM_GROUPS, filingTone, filterFilingsByGroup, FUND_FORM_GROUPS, getFilingColumnText } from "./model";
import { rowSummary, rowSummaryTarget } from "./row-summaries";

const filing = (form: string, extra: Partial<SecFilingItem> = {}): SecFilingItem => ({
  accessionNumber: `0000320193-26-${form}`,
  form,
  filingDate: new Date("2026-07-31T00:00:00Z"),
  cik: "0000320193",
  filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/index.htm",
  ...extra,
});

test("a row says what the filing reports: 8-K items in words, a periodic report's period, else the form's meaning", () => {
  expect(getFilingColumnText(filing("8-K", { items: "2.02,9.01" }))).toBe("Results of operations");
  expect(getFilingColumnText(filing("8-K/A", { items: "5.02" }))).toBe("Officer or director change (amended)");
  expect(getFilingColumnText(filing("8-K", { items: "9.01" }))).toBe("Exhibits");
  expect(getFilingColumnText(filing("10-Q", { primaryDocument: "aapl-20260627.htm" }))).toBe("Quarterly Report, period ended 2026-06-27");
  // A document date after the filing is not a period end.
  expect(getFilingColumnText(filing("10-Q", { primaryDocument: "aapl-20261231.htm" }))).toBe("Quarterly Report");
  expect(getFilingColumnText(filing("SD"))).toBe("Conflict Minerals Report");
});

test("a filing is toned by what it means for the company, the form text unchanged", () => {
  expect(filingTone(filing("8-K", { items: "1.03,9.01" }))).toBe("negative");
  expect(filingTone(filing("8-K", { items: "5.02" }))).toBe("warning");
  expect(filingTone(filing("8-K", { items: "2.02,9.01" }))).toBe("accent");
  expect(filingTone(filing("NT 10-K"))).toBe("negative");
  expect(filingTone(filing("10-K/A"))).toBe("accent");
  expect(filingTone(filing("4"), "sell")).toBe("negative");
  expect(filingTone(filing("4"), "buy")).toBe("positive");
  expect(filingTone(filing("4"))).toBe("text");
  expect(filingTone(filing("144"))).toBe("warning");
  expect(filingTone(filing("SCHEDULE 13D/A"))).toBe("warning");
  expect(filingTone(filing("24F-2NT"), "sell")).toBe("negative");
  expect(filingTone(filing("NPORT-P"))).toBe("muted");
});

test("form groups match amendments and both spellings of a schedule", () => {
  const rows = ["10-K", "10-Q/A", "8-K", "4", "144", "SC 13G/A", "SCHEDULE 13D", "DEF 14A", "S-8"].map((form) => filing(form));
  const forms = (value: string) => filterFilingsByGroup(rows, COMPANY_FORM_GROUPS, value).map((row) => row.form);
  expect(forms("periodic")).toEqual(["10-K", "10-Q/A"]);
  expect(forms("insider")).toEqual(["4", "144"]);
  expect(forms("ownership")).toEqual(["SC 13G/A", "SCHEDULE 13D"]);
  expect(forms("proxy")).toEqual(["DEF 14A"]);
  expect(forms("all")).toHaveLength(rows.length);
  expect(filterFilingsByGroup([filing("NPORT-P"), filing("N-CSR/A"), filing("497K")], FUND_FORM_GROUPS, "reports").map((row) => row.form)).toEqual(["N-CSR/A"]);
});

// Trimmed from SPY's 24F-2NT for the year to 2025-09-30.
const FUND_FLOWS = `<edgarSubmission><formData><annualFilingInfo><item4><lastDayOfFiscalYear>09/30/2025</lastDayOfFiscalYear></item4>
<item5><aggregateSalePriceOfSecuritiesSold>992586667258</aggregateSalePriceOfSecuritiesSold>
<aggregatePriceOfSecuritiesRedeemedOrRepurchasedInFiscalYear>996386735956</aggregatePriceOfSecuritiesRedeemedOrRepurchasedInFiscalYear></item5>
</annualFilingInfo></formData></edgarSubmission>`;

// Trimmed from an Apple Form 144.
const PROPOSED_SALE = `<ns2:edgarSubmission xmlns:ns2="http://www.sec.gov/edgar/ownership"><ns2:formData><ns2:issuerInfo>
<ns2:nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold>John Ternus</ns2:nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold></ns2:issuerInfo>
<ns2:securitiesInformation><ns2:noOfUnitsSold>25412</ns2:noOfUnitsSold><ns2:aggregateMarketValue>8479730.28</ns2:aggregateMarketValue></ns2:securitiesInformation>
</ns2:formData></ns2:edgarSubmission>`;

test("XML filings read for their rows: a 144 names the seller and size, a 24F-2NT the year's net flow", () => {
  expect(rowSummary("144", PROPOSED_SALE)).toEqual({ title: "John Ternus: proposed sale of 25.4k shares ($8.48M)", direction: null });
  expect(rowSummary("24F-2NT", FUND_FLOWS)).toEqual({
    title: "Year to 2025-09-30: net flow -$3.8B (sold $992.59B, redeemed $996.39B)",
    direction: "sell",
  });
  expect(rowSummary("8-K", PROPOSED_SALE)).toBeNull();
  expect(rowSummary("144", null)).toBeNull();
});

test("a 144 and a 24F-2NT are read from their XML under their own key, never the rendered page the detail shows", () => {
  const notice = filing("144", { primaryDocumentUrl: "https://www.sec.gov/Archives/edgar/data/320193/000195824426000636/xsl144X01/primary_doc.xml" });
  expect(rowSummaryTarget(notice)).toMatchObject({
    accessionNumber: `${notice.accessionNumber}:primary_doc.xml`,
    primaryDocumentUrl: "https://www.sec.gov/Archives/edgar/data/320193/000195824426000636/primary_doc.xml",
  });
  // Form 4s come back as XML already.
  const form4 = filing("4");
  expect(rowSummaryTarget(form4)).toBe(form4);
  expect(rowSummaryTarget(filing("10-K"))).toBeNull();
});
