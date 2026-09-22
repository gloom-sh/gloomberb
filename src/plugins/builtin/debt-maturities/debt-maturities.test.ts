import { describe, expect, test } from "bun:test";
import type {
  DebtMaturitiesPayload,
  DebtMetric,
} from "../../../api-client/debt-maturities";
import { ApiRequestError } from "../../../api-client/errors";
import {
  BUCKET_IDS,
  fetchDebtMaturities,
  validateDebtMaturities,
} from "./client";
import {
  bucketCursor,
  bucketPoints,
  bucketShare,
  sortedBuckets,
  sortedDebtHistory,
} from "./model";

function fixture(): DebtMaturitiesPayload {
  const asOf = "2025-06-30",
    filed = "2025-07-25",
    accession = "0000000001-25-000001",
    currency = "EUR";
  const metric = (value: number | null, unit = currency): DebtMetric => ({
    value,
    unit,
    asOf,
    filed,
    percentile: {
      value: null,
      rank: null,
      sampleCount: value === null ? 0 : 1,
      minimumSamples: 5,
      windowStart: "2015-06-30",
      windowEnd: asOf,
      historyStart: value === null ? null : asOf,
      historyEnd: value === null ? null : asOf,
      min: value,
      max: value,
      mean: value,
    },
  });
  const buckets = BUCKET_IDS.map((id, index) => ({
    id,
    label: id,
    year: index === 5 ? null : 2026 + index,
    value: index * 10,
    fact: {
      value: index * 10,
      tag: `LongTermDebtMaturitiesRepaymentsOfPrincipal${id}`,
      unit: currency,
      start: null,
      end: asOf,
      accession,
      filed,
      form: "20-F",
    },
  }));
  return {
    version: 1,
    symbol: "TEST",
    cik: "0000000001",
    entityName: "Example",
    taxonomy: "us-gaap",
    status: "partial",
    fetchedAt: "2025-07-26T00:00:00.000Z",
    asOf,
    source: { name: "SEC", url: "https://data.sec.gov/one", cadence: "Annual" },
    warnings: [],
    latest: {
      asOf,
      filed,
      accession,
      form: "20-F",
      currency,
      filingUrl: "https://www.sec.gov/one",
      complete: true,
      buckets,
      totalPrincipal: metric(150),
      next12Months: metric(0),
      next12MonthsShare: metric(0, "%"),
      next3Years: metric(30),
      next3YearsShare: metric(20, "%"),
      interestExpense: metric(null),
      borrowingCostPercent: metric(null, "%"),
      interestExpenseFact: null,
      borrowingCostEvidence: null,
    },
    history: [
      {
        asOf,
        filed,
        accession,
        currency,
        complete: true,
        totalPrincipal: 150,
        next12Months: 0,
        next12MonthsShare: 0,
        next3Years: 30,
        next3YearsShare: 20,
        interestExpense: null,
        borrowingCostPercent: null,
        interestExpenseTag: null,
        borrowingCostDebtTags: null,
      },
    ],
  };
}

describe("debt maturity Cloud boundary", () => {
  test("cost proxy requires annual debt interest and comparable debt at both period boundaries", () => {
    const data = fixture(),
      latest = data.latest!,
      seed = latest.buckets[0]!.fact!;
    const interest = {
      ...seed,
      tag: "InterestExpenseDebt",
      value: 6,
      start: "2024-07-01",
    };
    const balances = (end: string) => [
      { ...seed, tag: "LongTermDebt", value: 100, end },
      { ...seed, tag: "CommercialPaper", value: 20, end },
    ];
    latest.interestExpenseFact = interest;
    latest.interestExpense.value = 6;
    latest.borrowingCostPercent.value = 5;
    latest.borrowingCostEvidence = {
      value: 5,
      interest,
      periodStart: interest.start,
      periodEnd: seed.end,
      opening: balances("2024-06-30"),
      closing: balances("2025-06-30"),
    };
    Object.assign(data.history[0]!, {
      interestExpense: 6,
      borrowingCostPercent: 5,
      interestExpenseTag: "InterestExpenseDebt",
      borrowingCostDebtTags: "LongTermDebt+CommercialPaper",
    });
    expect(
      validateDebtMaturities(data, "TEST").latest?.borrowingCostPercent.value,
    ).toBe(5);
    for (const change of [
      (p: DebtMaturitiesPayload) => {
        p.latest!.borrowingCostEvidence!.opening[1]!.unit = "USD";
      },
      (p: DebtMaturitiesPayload) => {
        p.latest!.borrowingCostEvidence!.closing[1]!.tag =
          "ShortTermBorrowings";
      },
      (p: DebtMaturitiesPayload) => {
        p.latest!.borrowingCostEvidence!.interest.tag = "InterestExpense";
      },
      (p: DebtMaturitiesPayload) => {
        p.latest!.borrowingCostEvidence!.value = 10;
      },
      (p: DebtMaturitiesPayload) => {
        p.latest!.interestExpenseFact!.start = "2025-04-01";
        const evidence = p.latest!.borrowingCostEvidence!;
        evidence.periodStart = "2025-04-01";
        evidence.interest.start = "2025-04-01";
        evidence.opening.forEach((fact) => {
          fact.end = "2025-03-31";
        });
      },
    ]) {
      const copy = structuredClone(data);
      change(copy);
      expect(() => validateDebtMaturities(copy, "TEST")).toThrow();
    }
  });
  test("keeps native currency and genuine zero principal; rejects mixed cohorts and unsupported ranks", () => {
    const data = fixture();
    expect(
      validateDebtMaturities(data, "TEST").latest?.next12MonthsShare.value,
    ).toBe(0);
    for (const change of [
      (p: DebtMaturitiesPayload) => {
        p.symbol = "OTHER";
      },
      (p: DebtMaturitiesPayload) => {
        p.latest!.buckets[0]!.fact!.unit = "USD";
      },
      (p: DebtMaturitiesPayload) => {
        p.latest!.buckets[0]!.fact!.accession = "0000000001-24-000001";
      },
      (p: DebtMaturitiesPayload) => {
        p.latest!.buckets[0]!.fact!.end = "2024-06-30";
      },
      (p: DebtMaturitiesPayload) => {
        p.latest!.totalPrincipal.percentile.value = 50;
      },
      (p: DebtMaturitiesPayload) => {
        p.latest!.borrowingCostPercent.value = 3;
      },
      (p: DebtMaturitiesPayload) => {
        p.latest!.buckets[5]!.year = 2031;
      },
      (p: DebtMaturitiesPayload) => {
        p.latest!.next12MonthsShare.value = 1;
      },
      (p: DebtMaturitiesPayload) => {
        p.latest!.filed = "2025-02-30";
      },
    ]) {
      const copy = structuredClone(data);
      change(copy);
      expect(() => validateDebtMaturities(copy, "TEST")).toThrow(
        "invalid debt maturity",
      );
    }
  });

  test("missing bucket stays a chart gap and prevents a total and concentration denominator", () => {
    const data = fixture(),
      latest = data.latest!;
    latest.buckets[5]!.value = null;
    latest.buckets[5]!.fact = null;
    expect(() => validateDebtMaturities(data, "TEST")).toThrow();
    latest.complete = false;
    for (const key of [
      "totalPrincipal",
      "next12MonthsShare",
      "next3YearsShare",
    ] as const) {
      latest[key].value = null;
      latest[key].percentile.value = null;
      data.history[0]![key] = null;
    }
    data.history[0]!.complete = false;
    expect(
      validateDebtMaturities(data, "TEST").latest!.next12Months.value,
    ).toBe(0);
    expect(
      bucketPoints(latest)
        .slice(1, -1)
        .map((row) => row.value),
    ).toEqual([0, 10, 20, 30, 40, null]);
    expect(bucketShare(latest.buckets[0]!, latest)).toBeNull();
    expect(bucketCursor(1)).toBe("Thereafter");
  });

  test("structured unsupported issuers and absent endpoints do not masquerade as zero debt", async () => {
    const unavailable = {
      ...fixture(),
      status: "unavailable" as const,
      taxonomy: null,
      asOf: null,
      latest: null,
      history: [],
    };
    expect(validateDebtMaturities(unavailable, "TEST").latest).toBeNull();
    expect(() =>
      validateDebtMaturities(
        { ...unavailable, history: fixture().history },
        "TEST",
      ),
    ).toThrow();
    await expect(
      fetchDebtMaturities("TEST", {
        getCloudDebtMaturities: async () => {
          throw new ApiRequestError("missing", 404);
        },
      }),
    ).rejects.toThrow("not available on this Gloom Cloud server yet");
    const denied = new ApiRequestError("Denied", 403);
    await expect(
      fetchDebtMaturities("TEST", {
        getCloudDebtMaturities: async () => {
          throw denied;
        },
      }),
    ).rejects.toBe(denied);
  });
});

test("maturity sorting follows fiscal order; numeric sorts preserve missing values last", () => {
  const latest = fixture().latest!;
  latest.buckets[1]!.value = null;
  expect(
    sortedBuckets(latest, { column: "label", direction: "asc" }).map(
      (row) => row.id,
    ),
  ).toEqual([...BUCKET_IDS]);
  for (const direction of ["asc", "desc"] as const) {
    const rows = sortedBuckets(latest, { column: "value", direction });
    expect(rows.at(-1)?.value).toBeNull();
    expect(rows[0]?.value).toBe(direction === "asc" ? 0 : 50);
  }
});

test("historical view is bounded by the comparable ten-year window and sorts nulls last", () => {
  const data = fixture(),
    current = data.history[0]!;
  data.history.unshift(
    { ...current, asOf: "2010-06-30" },
    { ...current, asOf: "2020-06-30", totalPrincipal: null },
  );
  for (const direction of ["asc", "desc"] as const) {
    const rows = sortedDebtHistory(data, {
      column: "totalPrincipal",
      direction,
    });
    expect(rows.map((row) => row.asOf)).toEqual(["2025-06-30", "2020-06-30"]);
  }
});
