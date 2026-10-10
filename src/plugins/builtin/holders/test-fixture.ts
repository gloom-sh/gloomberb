import type { BeneficialOwnerFiling, BeneficialOwnersPayload } from "../../../api-client/beneficial-owners";

/**
 * 13D/13G reports modelled on Avis Budget (CAR): a filer that went from 22.2%
 * to 7.3% in a month, a 13D filed by a group, a new 13G, stakes reported
 * under 5%, a report of zero, and a report only the EDGAR index lists. The
 * figures are illustrative, not what the filings say.
 */
function report(overrides: Partial<BeneficialOwnerFiling> & Pick<BeneficialOwnerFiling, "filerName" | "accessionNumber" | "filingDate">): BeneficialOwnerFiling {
  const amendment = overrides.amendment ?? true;
  return {
    filerCik: null,
    form: amendment ? "SCHEDULE 13G/A" : "SCHEDULE 13G",
    kind: "13G",
    amendment,
    amendmentNo: null,
    percentOfClass: null,
    shares: null,
    classTitle: "Common Stock, $0.01 par value",
    cusip: "053774105",
    eventDate: null,
    filingUrl: `https://www.sec.gov/Archives/edgar/data/723612/${overrides.accessionNumber}-index.htm`,
    previousPercent: null,
    previousFilingDate: null,
    status: "holder",
    source: "xml",
    reportingPersons: [{ name: overrides.filerName, cik: overrides.filerCik ?? null, percentOfClass: overrides.percentOfClass ?? null, shares: overrides.shares ?? null }],
    ...overrides,
  };
}

const PENTWATER = report({
  filerCik: "0001425851", filerName: "Pentwater Capital Management LP", amendmentNo: 3,
  percentOfClass: 7.3, shares: 2_569_000, eventDate: "2026-04-30", filingDate: "2026-05-07",
  accessionNumber: "0000902664-26-002305", previousPercent: 22.2, previousFilingDate: "2026-04-07",
  reportingPersons: [
    { name: "Pentwater Capital Management LP", cik: "0001425851", percentOfClass: 7.3, shares: 2_569_000 },
    { name: "Matthew Halbower", cik: null, percentOfClass: 7.3, shares: 2_569_000 },
  ],
});

const SRS = report({
  filerCik: "0001503174", filerName: "SRS Investment Management, LLC", form: "SC 13D/A", kind: "13D", amendmentNo: 12,
  percentOfClass: 49.3, shares: 17_430_882, eventDate: "2023-08-23", filingDate: "2023-08-25",
  accessionNumber: "0001193125-23-221593", previousPercent: 47.9, previousFilingDate: "2022-12-27", source: "text",
  reportingPersons: [
    { name: "SRS Investment Management, LLC", cik: "0001503174", percentOfClass: 49.3, shares: 17_430_882 },
    { name: "Karthik R. Sarma", cik: null, percentOfClass: 49.3, shares: 17_430_882 },
    { name: "SRS Partners Master Fund LP", cik: null, percentOfClass: 31.0, shares: 10_960_000 },
  ],
});

export const CAR_BENEFICIAL_OWNERS: BeneficialOwnerFiling[] = [
  PENTWATER,
  SRS,
  report({
    filerCik: "0001595888", filerName: "Jane Street Group, LLC", amendmentNo: 2, percentOfClass: 5.6, shares: 1_975_000,
    eventDate: "2026-04-30", filingDate: "2026-05-11", accessionNumber: "0001595888-26-000039",
    previousPercent: 6.1, previousFilingDate: "2026-02-12",
  }),
  report({
    filerCik: "0000895421", filerName: "Morgan Stanley", amendment: false, percentOfClass: 5.8, shares: 2_029_978,
    eventDate: "2025-12-31", filingDate: "2026-02-11", accessionNumber: "0000895421-26-000025",
    reportingPersons: [
      { name: "Morgan Stanley", cik: "0000895421", percentOfClass: 5.8, shares: 2_029_978 },
      { name: "Morgan Stanley & Co. LLC", cik: null, percentOfClass: 5.1, shares: 1_790_000 },
    ],
  }),
  report({
    filerCik: "0002012383", filerName: "BlackRock, Inc.", percentOfClass: 6.6, shares: 2_330_000,
    eventDate: "2025-03-31", filingDate: "2025-04-23", accessionNumber: "0002052113-25-000432",
    previousPercent: 7.9, previousFilingDate: "2025-02-04",
  }),
  report({
    filerCik: "0000886982", filerName: "Goldman Sachs Group Inc", filingDate: "2025-11-10",
    accessionNumber: "0000886982-25-001416", classTitle: null, cusip: null, source: "index", reportingPersons: [],
  }),
  report({
    filerCik: "0000102909", filerName: "Vanguard Group Inc", form: "SC 13G/A", percentOfClass: 9.9, shares: 3_480_000,
    eventDate: "2024-09-30", filingDate: "2024-11-12", accessionNumber: "0000932471-24-000865",
    previousPercent: 10.4, previousFilingDate: "2024-02-13", source: "text",
  }),
  report({
    filerCik: "0001163653", filerName: "Nomura Holdings Inc", percentOfClass: 3.9, shares: 1_380_000,
    eventDate: "2026-01-30", filingDate: "2026-02-17", accessionNumber: "0000905148-26-000826",
    previousPercent: 6.4, previousFilingDate: "2025-11-14", status: "below-threshold",
  }),
  report({
    filerCik: "0001446580", filerName: "Susquehanna Securities, LLC", percentOfClass: 0.8, shares: 280_000,
    eventDate: "2026-01-31", filingDate: "2026-02-13", accessionNumber: "0001446580-26-000028",
    previousPercent: 5.4, previousFilingDate: "2025-11-13", status: "below-threshold",
  }),
  report({
    filerCik: "0000315066", filerName: "FMR LLC", percentOfClass: 0, shares: 0,
    eventDate: "2025-07-31", filingDate: "2025-08-06", accessionNumber: "0000315066-25-001975",
    previousPercent: 5.6, previousFilingDate: "2025-05-12", status: "exited",
  }),
];

/** Earlier reports the history adds, newest first once merged with the latest ones. */
const EARLIER_REPORTS: BeneficialOwnerFiling[] = [
  report({
    filerCik: "0001425851", filerName: "Pentwater Capital Management LP", amendmentNo: 2, percentOfClass: 22.2, shares: 7_820_000,
    eventDate: "2026-03-31", filingDate: "2026-04-07", accessionNumber: "0000902664-26-001913",
    previousPercent: 14.8, previousFilingDate: "2026-03-06",
  }),
  report({
    filerCik: "0001425851", filerName: "Pentwater Capital Management LP", amendmentNo: 1, percentOfClass: 14.8, shares: 5_210_000,
    eventDate: "2026-02-27", filingDate: "2026-03-06", accessionNumber: "0000902664-26-001513",
    previousPercent: 9.1, previousFilingDate: "2025-08-14",
  }),
  report({
    filerCik: "0001595888", filerName: "Jane Street Group, LLC", amendmentNo: 1, percentOfClass: 6.1, shares: 2_150_000,
    eventDate: "2025-12-31", filingDate: "2026-02-12", accessionNumber: "0001595888-26-000020",
    previousPercent: 5.3, previousFilingDate: "2025-11-13",
  }),
];

/** History reports come without the previous report and status, as the route sends them. */
function historyReport({ previousPercent: _percent, previousFilingDate: _date, status: _status, ...filing }: BeneficialOwnerFiling): BeneficialOwnerFiling {
  return filing;
}

export function carBeneficialOwnersPayload({ history = false }: { history?: boolean } = {}): BeneficialOwnersPayload {
  return {
    ticker: "CAR",
    cik: "0000723612",
    companyName: "AVIS BUDGET GROUP, INC.",
    asOf: "2026-10-09T08:30:00.000Z",
    owners: CAR_BENEFICIAL_OWNERS,
    ...(history ? {
      filings: [...CAR_BENEFICIAL_OWNERS, ...EARLIER_REPORTS]
        .map(historyReport)
        .sort((left, right) => right.filingDate.localeCompare(left.filingDate)),
    } : {}),
    hasMore: false,
    nextOffset: null,
    coverage: { from: "2022-10-09", filings: 31, parsed: 30, unparsed: 1, unavailable: 0 },
  };
}
