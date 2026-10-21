import { describe, expect, test } from "bun:test";
import type { FinancialStatement } from "../types/financials";
import { cashRunway, offeringNote, offeringsAfter, trailingOperatingCashFlow } from "./cash-runway";

const quarter = (date: string, fields: Partial<FinancialStatement>): FinancialStatement => ({ date, currency: "USD", ...fields });

// Viking Therapeutics' four quarters to 2026-06-30, in USD millions.
const vktx = [
  quarter("2025-09-30", { operatingCashFlow: -94.0e6 }),
  quarter("2025-12-31", { operatingCashFlow: -85.3e6 }),
  quarter("2026-03-31", { operatingCashFlow: -113.97e6 }),
  quarter("2026-06-30", { operatingCashFlow: -125.17e6, cashAndCashEquivalents: 125.75e6, cashCashEquivalentsAndShortTermInvestments: 501.66e6 }),
];

describe("cashRunway", () => {
  test("reads months of cash and ST investments at the quarter's burn and the trailing year's", () => {
    const runway = cashRunway({ quarterlyStatements: vktx, annualStatements: [] })!;
    expect(runway).toMatchObject({ periodEnd: "2026-06-30", liquidity: 501.66e6, includesShortTerm: true });
    // 125.17M over 3 months is 41.72M a month; 418.44M over 12 is 34.87M.
    expect(runway.quarter).toMatchObject({ kind: "months", monthlyBurn: 125.17e6 / 3 });
    expect(runway.quarter?.kind === "months" && runway.quarter.months).toBeCloseTo(12.02, 2);
    expect(runway.trailing?.kind === "months" && runway.trailing.months).toBeCloseTo(14.39, 2);
  });

  test("operating cash coming in is no burn, not a negative runway", () => {
    const profitable = vktx.map((row) => ({ ...row, operatingCashFlow: Math.abs(row.operatingCashFlow!) }));
    const runway = cashRunway({ quarterlyStatements: profitable, annualStatements: [] })!;
    expect(runway.quarter).toEqual({ kind: "no-burn", operatingCashFlow: 125.17e6 });
    expect(runway.trailing?.kind).toBe("no-burn");
  });

  test("without a reported ST investments total the runway is cash alone, and says so", () => {
    const cashOnly = [...vktx.slice(0, 3), quarter("2026-06-30", { operatingCashFlow: -125.17e6, cashAndCashEquivalents: 125.75e6 })];
    const runway = cashRunway({ quarterlyStatements: cashOnly, annualStatements: [] })!;
    expect(runway).toMatchObject({ liquidity: 125.75e6, includesShortTerm: false });
    expect(runway.quarter?.kind === "months" && runway.quarter.months).toBeCloseTo(3.01, 2);
    // A filer reporting the total elsewhere holds investments the quarter's cash alone leaves out: no runway, not 3 months.
    const sparse = [quarter("2025-06-30", { cashCashEquivalentsAndShortTermInvestments: 807.7e6 }), ...cashOnly];
    expect(cashRunway({ quarterlyStatements: sparse, annualStatements: [] })).toBeNull();
  });

  test("a collaboration payment makes the quarter and the year disagree, and both are kept", () => {
    // Arrowhead: three quarters of inflow, then a 177.5M outflow.
    const arwr = [
      quarter("2025-09-30", { operatingCashFlow: 20.49e6 }),
      quarter("2025-12-31", { operatingCashFlow: 13.48e6 }),
      quarter("2026-03-31", { operatingCashFlow: 84.44e6 }),
      quarter("2026-06-30", { operatingCashFlow: -177.47e6, cashCashEquivalentsAndShortTermInvestments: 1.6e9 }),
    ];
    const runway = cashRunway({ quarterlyStatements: arwr, annualStatements: [] })!;
    expect(runway.quarter?.kind === "months" && runway.quarter.months).toBeCloseTo(27.05, 2);
    expect(runway.trailing?.kind === "months" && runway.trailing.months).toBeCloseTo(325.1, 1);
    // An inflow quarter last: the quarter has no burn while the year still burns.
    const lastIn = [...arwr.slice(1), quarter("2026-09-30", { operatingCashFlow: 50e6, cashCashEquivalentsAndShortTermInvestments: 1.65e9 })];
    const later = cashRunway({ quarterlyStatements: lastIn, annualStatements: [] })!;
    expect(later.quarter?.kind).toBe("no-burn");
    expect(later.trailing?.kind === "months" && later.trailing.months).toBeCloseTo(670.05, 2);
  });

  test("no quarter, no cash or no cash flow is no runway", () => {
    expect(cashRunway({ quarterlyStatements: [], annualStatements: [quarter("2025-12-31", { operatingCashFlow: -1, cashAndCashEquivalents: 5 })] })).toBeNull();
    expect(cashRunway({ quarterlyStatements: [quarter("2026-06-30", { operatingCashFlow: -1 })], annualStatements: [] })).toBeNull();
    expect(cashRunway({ quarterlyStatements: [quarter("2026-06-30", { cashAndCashEquivalents: 5 })], annualStatements: [] })).toBeNull();
  });
});

describe("trailingOperatingCashFlow", () => {
  const latest = vktx.at(-1)!;

  test("a fiscal year ending with the quarter is its year; otherwise four consecutive quarters", () => {
    expect(trailingOperatingCashFlow(latest, vktx, [quarter("2026-06-28", { operatingCashFlow: -400e6 })])).toBe(-400e6);
    expect(trailingOperatingCashFlow(latest, vktx, [])).toBeCloseTo(-418.44e6, 0);
  });

  test("a skipped quarter, a half-year report or a missing figure is no trailing year", () => {
    const skipped = [quarter("2025-06-30", { operatingCashFlow: -1 }), ...vktx.filter((row) => row.date !== "2025-12-31")];
    expect(trailingOperatingCashFlow(latest, skipped, [])).toBeNull();
    expect(trailingOperatingCashFlow(latest, [...vktx.slice(0, 2), { ...vktx[2]!, operatingCashFlow: undefined }, latest], [])).toBeNull();
  });
});

describe("offerings after the balance sheet", () => {
  const filings = [
    { form: "424B5", filed: "2026-09-25" },
    { form: "424B5", filed: "2026-09-25" },
    { form: "424B5", filed: "2026-09-23" },
    { form: "424B5", filed: "2024-03-01" },
    // A server without the form filter sends the rest.
    { form: "8-K", filed: "2026-09-28" },
  ];

  test("only prospectuses filed after its date, oldest first, are noted with their dates", () => {
    const after = offeringsAfter(filings, "2026-06-30");
    expect(after.map((filing) => filing.filed)).toEqual(["2026-09-23", "2026-09-25", "2026-09-25"]);
    expect(offeringNote(after, "2026-06-30"))
      .toBe("424B5 offering filed 2026-09-23 and 2026-09-25, after the 2026-06-30 balance sheet; cash and runway predate it.");
    expect(offeringNote(offeringsAfter(filings, "2026-09-30"), "2026-09-30")).toBeNull();
  });
});
