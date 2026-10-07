import { describe, expect, test } from "bun:test";
import type { SecFilingItem } from "../../../types/data-provider";
import type { HeadlessPaneLoadArgs } from "../../../types/plugin";
import { ETF_FILING_FORMS, SEC_FILING_FETCH_LIMIT } from "./forms";
import { createSecHeadless } from "./headless";
import { buildSecFilingRows, getFilingColumnText, secAcceptanceTimestamp } from "./model";
import { createTestHeadlessContext } from "../../../test-support/headless";

const filings: SecFilingItem[] = [
  {
    accessionNumber: "0000320193-26-000100",
    form: "8-K",
    filingDate: new Date("2026-08-25T00:00:00.000Z"),
    primaryDocDescription: "8-K Results of Operations",
    items: "2.02,9.01",
    cik: "0000320193",
    filingUrl: "https://www.sec.gov/filing/one",
  },
  {
    accessionNumber: "0000320193-26-000099",
    form: "10-Q",
    filingDate: new Date("2026-08-20T00:00:00.000Z"),
    cik: "0000320193",
    filingUrl: "https://www.sec.gov/filing/two",
  },
];

function args(limit: number): HeadlessPaneLoadArgs {
  return {
    rawArgument: "AAPL",
    argument: "AAPL",
    symbols: ["AAPL"],
    options: { limit },
  };
}

describe("SEC headless model", () => {
  test("projects filing rows and honors the page limit", async () => {
    const requestedLimits: number[] = [];
    const headless = createSecHeadless({
      loadFilings: async (_symbol, limit) => {
        requestedLimits.push(limit);
        return filings;
      },
    });

    const first = await headless.load(args(1), createTestHeadlessContext());
    expect(first.rows).toEqual([{
      filedAt: "2026-08-25T00:00:00.000Z",
      acceptedAt: null,
      acceptedAtRaw: null,
      acceptanceReported: null,
      form: "8-K",
      filing: "Results of Operations | Current Report",
      items: "2.02,9.01",
      accessionNumber: "0000320193-26-000100",
      primaryDocument: null,
      cik: "0000320193",
      companyName: null,
      url: "https://www.sec.gov/filing/one",
    }]);

    const both = await headless.load(args(2), createTestHeadlessContext());
    expect(both.rows).toHaveLength(2);
    expect(requestedLimits).toEqual([1, 2]);
  });
});

test.each([
  ["144", "FORM 144", "Notice of proposed sale of securities"],
  ["144/A", "144/A", "Notice of proposed sale of securities (Amended)"],
  ["4", "FORM 4 — Insider Transaction", "Insider Transaction"],
  ["4", "4 - Insider Transaction", "Insider Transaction"],
  ["8-K", "FORM 8-K – Results of Operations", "Results of Operations | Current Report"],
  ["S-4", "S-4: Merger terms", "Merger terms | Business Combination or Exchange Offer Registration"],
  ["4", "4/A amendment document", "4/A amendment document | Insider Transaction"],
])("FILING describes %s without repeating its FORM column (%s)", (form, description, expected) => {
  const entry = { ...filings[0]!, form, primaryDocDescription: description };
  expect(getFilingColumnText(entry)).toBe(expected);
  expect(buildSecFilingRows([entry])[0]).toMatchObject({ form, filing: expected });
});

test("ticker reuse preserves the actual filing issuer rather than the requested ticker's former company", async () => {
  const headless = createSecHeadless({ loadFilings: async () => [{
    ...filings[0]!, cik: "0001826011", companyName: "Banzai International, Inc."
  }] });
  const result = await headless.load({ ...args(1), argument: "PARA", symbols: ["PARA"] }, createTestHeadlessContext());
  expect(result.rows[0]).toMatchObject({ cik: "0001826011", companyName: "Banzai International, Inc." });
  expect(result.metadata?.issuers).toEqual([{ cik: "0001826011", companyName: "Banzai International, Inc." }]);
});

test("accepted timestamps survive persisted JSON rows and invalid cached values remain unknown", () => {
  const filing = { ...filings[0]!, acceptedAt: new Date("2025-03-20T20:10:11.000Z") };
  const restored = JSON.parse(JSON.stringify(filing)) as SecFilingItem;
  expect(secAcceptanceTimestamp(restored.acceptedAt)).toBe("2025-03-20T20:10:11.000Z");
  expect(buildSecFilingRows([restored])[0]?.acceptedAt).toBe("2025-03-20T20:10:11.000Z");
  const compact = { ...restored, acceptedAt: undefined, acceptedAtRaw: "20250320161011" };
  expect(buildSecFilingRows([compact])[0]).toMatchObject({ acceptedAt: null, acceptedAtRaw: "20250320161011", acceptanceReported: "20250320161011 (timezone unspecified)" });
  expect(secAcceptanceTimestamp("2025-03-20T16:10:11")).toBeNull();
  const naive = JSON.parse(JSON.stringify({ ...filing, acceptedAt: "2025-03-20T16:10:11" })) as SecFilingItem;
  expect(buildSecFilingRows([naive])[0]).toMatchObject({ acceptedAt: null, acceptanceReported: "2025-03-20T16:10:11 (timezone unspecified)" });
  expect(secAcceptanceTimestamp("invalid")).toBeNull();
  expect(secAcceptanceTimestamp(undefined)).toBeNull();
});

test("the fund view filters every issuer filing it loaded, amendments included, and says when that list was capped", async () => {
  const fund = (form: string, index: number): SecFilingItem => ({ ...filings[1]!, form, accessionNumber: `0000884394-26-${String(index).padStart(6, "0")}` });
  const issuerFilings = [fund("8-K", 1), fund("N-CSR/A", 2), fund("SC 13G", 3), fund("485BPOS", 4), fund("NPORT-P", 5)];
  const requested: number[] = [];
  const headless = createSecHeadless({
    loadFilings: async (_symbol, limit) => {
      requested.push(limit);
      return issuerFilings;
    },
  }, { forms: ETF_FILING_FORMS });

  const result = await headless.load(args(2), createTestHeadlessContext());
  expect(requested).toEqual([SEC_FILING_FETCH_LIMIT]);
  expect(result.rows.map((row) => row.form)).toEqual(["N-CSR/A", "485BPOS"]);
  expect(result.complete).toBe(true);

  issuerFilings.push(...Array.from({ length: SEC_FILING_FETCH_LIMIT - issuerFilings.length }, (_, index) => fund("4", 100 + index)));
  expect((await headless.load(args(2), createTestHeadlessContext())).complete).toBe(false);
});
