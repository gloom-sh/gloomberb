import { describe, expect, test } from "bun:test";
import type { CloudCdsHistoryPointPayload, CloudCdsTradePayload } from "../../../api-client";
import {
  formatNotional,
  issuerGroupKey,
  normalizeCdsTrades,
  resolveIssuerQuery,
  spreadChartPoints,
  spreadFigures,
  spreadToBasisPoints,
  summarizeIssuers,
  tradesForIssuer,
} from "./model";

function payload(overrides: Partial<CloudCdsTradePayload> = {}): CloudCdsTradePayload {
  return {
    disseminationId: "1",
    originalDisseminationId: null,
    actionType: "NEWT",
    eventTimestamp: "2026-08-25T14:30:00Z",
    executionTimestamp: "2026-08-25T14:30:00Z",
    effectiveDate: null,
    expirationDate: null,
    maturityDate: "2031-06-20",
    issuerName: "Oracle Corporation",
    underlierId: null,
    underlierIdSource: null,
    upi: null,
    upiFisn: null,
    upiUnderlierName: null,
    notionalAmount: 5_000_000,
    notionalCapped: false,
    notionalCurrency: "USD",
    // Raw DTCC decimals: 0.01 is a 100bp coupon.
    fixedRate: 0.01,
    reportedSpread: null,
    spreadNotation: null,
    upfrontAmount: null,
    upfrontCurrency: null,
    ...overrides,
  };
}

describe("CDS spread units", () => {
  test("converts reported spreads to basis points by notation", () => {
    // Notation code "3" is what the raw DTCC feed carries for a decimal spread.
    expect(spreadToBasisPoints(0.00256, "3")).toBeCloseTo(25.6, 6);
    expect(spreadToBasisPoints(0.00256, "Decimal")).toBeCloseTo(25.6, 6);
    // Unlabelled raw values are decimals too, not percent.
    expect(spreadToBasisPoints(0.00256, null)).toBeCloseTo(25.6, 6);
    expect(spreadToBasisPoints(25.6, "BPS")).toBe(25.6);
    expect(spreadToBasisPoints(250, "4")).toBe(250);
    expect(spreadToBasisPoints(25.6, "Basis points")).toBe(25.6);
    expect(spreadToBasisPoints(0.256, "Percentage")).toBeCloseTo(25.6, 6);
    expect(spreadToBasisPoints(null, "3")).toBeNull();
  });

  test("withholds unsupported notation without confusing known zero or negative spreads", () => {
    expect(["1", "Monetary amount", "Other", "basis unknown", "percent of price", "-4", "3-"].map((unit) =>
      spreadToBasisPoints(2.5, unit))).toEqual([null, null, null, null, null, null, null]);
    expect([0, -25].map((value) => spreadToBasisPoints(value, "4"))).toEqual([0, -25]);
    expect(spreadToBasisPoints(Number.MAX_VALUE, "3")).toBeNull();
    const [monetary] = normalizeCdsTrades([payload({ reportedSpread: 2.5, spreadNotation: "1" })]);
    expect(monetary).toMatchObject({ reportedSpread: 2.5, spreadNotation: "1", spreadBp: null, couponBp: 100 });
  });
});

describe("normalizeCdsTrades", () => {
  test("keeps the reported spread only, and falls back through issuer names", () => {
    const [withSpread, withoutName] = normalizeCdsTrades([
      payload({ reportedSpread: 0.00256, spreadNotation: "3", fixedRate: 0.05 }),
      payload({ disseminationId: "2", issuerName: null, upiUnderlierName: "ACME INC" }),
    ]);
    expect(withSpread!.spreadBp).toBeCloseTo(25.6, 6);
    expect(withSpread!.couponBp).toBeCloseTo(500, 6);
    // A missing spread is never back-solved from coupon or upfront.
    expect(withoutName!.spreadBp).toBeNull();
    expect(withoutName!.couponBp).toBeCloseTo(100, 6);
    expect(withoutName!.issuer).toBe("ACME INC");
  });

  test("dates a trade by execution time so a late correction is not a new print", () => {
    const [corrected, noExecution, unusableExecution] = normalizeCdsTrades([
      payload({
        actionType: "CORR",
        originalDisseminationId: "9",
        executionTimestamp: "2026-08-18T09:15:00Z",
        eventTimestamp: "2026-08-25T14:30:00Z",
      }),
      payload({ disseminationId: "2", executionTimestamp: null }),
      payload({ disseminationId: "3", executionTimestamp: "not-a-date" }),
    ]);
    expect(corrected!.eventAt).toBe(Date.parse("2026-08-18T09:15:00Z"));
    expect(noExecution!.eventAt).toBe(Date.parse("2026-08-25T14:30:00Z"));
    expect(unusableExecution!.eventAt).toBe(Date.parse("2026-08-25T14:30:00Z"));
  });

  test("drops reports with an unusable timestamp instead of dating them to 1970", () => {
    expect(normalizeCdsTrades([
      payload({ executionTimestamp: null, eventTimestamp: "not-a-date" }),
    ])).toHaveLength(0);
  });

  test("marks capped notionals so a floor is not read as the trade size", () => {
    expect(formatNotional({ notional: 5_000_000, notionalCapped: true })).toBe("5M+");
    expect(formatNotional({ notional: 5_000_000, notionalCapped: false })).toBe("5M");
    expect(formatNotional({ notional: null, notionalCapped: false })).toBe("--");
  });
});

describe("summarizeIssuers", () => {
  const trades = normalizeCdsTrades([
    payload({ disseminationId: "a", executionTimestamp: "2026-08-25T10:00:00Z", reportedSpread: 0.009, spreadNotation: "3" }),
    payload({ disseminationId: "b", executionTimestamp: "2026-08-25T14:00:00Z", reportedSpread: null }),
    payload({ disseminationId: "c", executionTimestamp: "2026-08-25T12:00:00Z", reportedSpread: 0.011, spreadNotation: "3" }),
    payload({ disseminationId: "d", executionTimestamp: "2026-08-25T09:00:00Z", issuerName: "Ford Motor Company" }),
  ]);

  test("groups by issuer with count, last trade, and the newest available spread", () => {
    const summaries = summarizeIssuers(trades);
    const oracle = summaries.find((row) => row.issuer === "Oracle Corporation")!;
    expect(oracle.trades).toBe(3);
    expect(oracle.lastTradeAt).toBe(Date.parse("2026-08-25T14:00:00Z"));
    // The newest print carried no spread, so the last quoted level survives.
    expect(oracle.latestSpreadBp).toBeCloseTo(110, 6);
    expect(summaries.find((row) => row.issuer === "Ford Motor Company")!.latestSpreadBp).toBeNull();
  });
});

describe("generic obligation names", () => {
  // Verbatim `UPI Underlier Name` values seen dominating the live market view.
  const GENERIC = [
    "SR NT",
    "SR NT 144A",
    "NT",
    "SR GTD NT 144A",
    "No name obtainable",
    "MEDIUM TERM NOTES EUR 2.3750 S.10/CALL",
    "MEDIUM TERM NOTES EUR 0.6250 S.001STLA/CALL",
    "GLOBAL BD",
  ];

  function unnamed(id: string, upiUnderlierName: string | null) {
    return payload({ disseminationId: id, issuerName: null, upiUnderlierName });
  }

  test("drops records whose only name is a generic obligation label", () => {
    const rows = normalizeCdsTrades([
      ...GENERIC.map((name, index) => unnamed(`g${index}`, name)),
      unnamed("empty", ""),
      unnamed("missing", null),
    ]);
    expect(rows).toEqual([]);
  });

  test("accepts UPI underlier names that identify an issuer", () => {
    const rows = normalizeCdsTrades([
      unnamed("t", "Tencent Holdings Limited"),
      unnamed("d", "DT.BANK MTN 17/20"),
    ]);
    expect(rows.map((row) => row.issuer)).toEqual(["Tencent Holdings Limited", "DT.BANK MTN 17/20"]);
  });

  test("keeps a reported issuer name and never falls back to an underlier id", () => {
    const rows = normalizeCdsTrades([
      payload({ disseminationId: "b", issuerName: "Broadcom Inc", upiUnderlierName: "SR NT 144A" }),
      payload({ disseminationId: "x", issuerName: null, upiUnderlierName: null, underlierId: "US11135FAX50" }),
    ]);
    expect(rows.map((row) => row.issuer)).toEqual(["Broadcom Inc"]);
  });

  test("leaves the summary to real issuers when fake ones outnumber them", () => {
    const summaries = summarizeIssuers(normalizeCdsTrades([
      ...GENERIC.map((name, index) => unnamed(`g${index}`, name)),
      payload({ disseminationId: "b", issuerName: "Broadcom Inc", upiUnderlierName: "SR GTD NT 144A" }),
      payload({ disseminationId: "o", issuerName: "Oracle Corporation", upiUnderlierName: "SR NT" }),
    ]));
    expect(summaries.map((row) => row.issuer).sort()).toEqual(["Broadcom Inc", "Oracle Corporation"]);
  });
});

describe("issuer aliases", () => {
  // Spellings the deployed backend actually returns for one reference entity,
  // deliberately in an order where the best one is not the first seen.
  const ORACLE = ["ORACLE CORPORATION", "Oracle Cop", "Oracle Corporation"];
  const BOEING = ["THE BOEING COMPANY", "Boeing Co/The", "The Boeing Company"];

  const aliasTrades = normalizeCdsTrades([
    ...ORACLE.map((issuerName, index) => payload({
      disseminationId: `o${index}`,
      issuerName,
      executionTimestamp: `2026-08-25T1${index}:00:00Z`,
      reportedSpread: 0.009,
      spreadNotation: "3",
    })),
    ...BOEING.map((issuerName, index) => payload({
      disseminationId: `b${index}`,
      issuerName,
      executionTimestamp: `2026-08-25T0${index}:00:00Z`,
    })),
  ]);

  test("collapses case, punctuation, and legal-suffix aliases onto one key", () => {
    expect(new Set(ORACLE.map(issuerGroupKey))).toEqual(new Set(["oracle"]));
    expect(new Set(BOEING.map(issuerGroupKey))).toEqual(new Set(["boeing"]));
  });

  test("keeps meaningful words that distinguish real entities", () => {
    expect(issuerGroupKey("Oracle Holdings Corp")).not.toBe(issuerGroupKey("Oracle Corporation"));
    expect(issuerGroupKey("Boeing Capital Group")).not.toBe(issuerGroupKey("The Boeing Company"));
    expect(issuerGroupKey("Acme 2031 Ltd")).not.toBe(issuerGroupKey("Acme 2026 Ltd"));
    // A name that is only noise keeps its own row instead of an empty key.
    expect(issuerGroupKey("The Company")).toBe("the company");
  });

  test("counts every alias in one row and displays the best spelling", () => {
    const summaries = summarizeIssuers(aliasTrades);
    expect(summaries).toHaveLength(2);

    const oracle = summaries.find((row) => row.key === "oracle")!;
    expect(oracle.trades).toBe(3);
    expect(oracle.issuer).toBe("Oracle Corporation");

    const boeing = summaries.find((row) => row.key === "boeing")!;
    expect(boeing.trades).toBe(3);
    expect(boeing.issuer).toBe("The Boeing Company");
  });

  test("drills down on the key so aliases open together", () => {
    expect(tradesForIssuer(aliasTrades, "oracle").map((row) => row.issuer)).toEqual(ORACLE);
    expect(tradesForIssuer(aliasTrades, "boeing").map((row) => row.issuer)).toEqual(BOEING);
  });
});

describe("resolveIssuerQuery", () => {
  const ticker = { metadata: { ticker: "ORCL", name: "Oracle Corporation" } } as never;

  test("prefers tracked metadata and otherwise hands the loader a bare symbol", () => {
    expect(resolveIssuerQuery("ORCL", ticker)).toBe("Oracle Corporation");
    // Untracked: the loader expands this through instrument search.
    expect(resolveIssuerQuery("orcl", null)).toBe("ORCL");
    expect(resolveIssuerQuery(null, null)).toBeNull();
  });
});

function level(date: string, spreadBp: number): CloudCdsHistoryPointPayload {
  return { date, spreadBp, prints: 5, reported: 1, maturity: "2031-12-20" };
}

describe("5Y spread chart", () => {
  test("breaks the line across three weeks without a level", () => {
    const points = spreadChartPoints([
      level("2026-06-01", 157),
      level("2026-06-19", 158),
      level("2026-07-13", 187),
    ]);
    expect(points.map((point) => [point.date.toISOString().slice(0, 10), point.value])).toEqual([
      ["2026-06-01", 157],
      ["2026-06-19", 158],
      ["2026-06-20", null],
      ["2026-07-13", 187],
    ]);
  });

  test("sums up the latest level, its month, and the charted range", () => {
    expect(spreadFigures([])).toEqual([]);
    expect(spreadFigures([
      level("2026-07-24", 214.6),
      level("2026-08-24", 222),
      level("2026-09-11", 181),
      level("2026-09-25", 235),
    ])).toEqual([
      { id: "spread", label: "5Y spread", value: "235bp", detail: "2026-09-25" },
      { id: "change", label: "1M", value: "+13bp" },
      { id: "range", label: "Range", value: "181 to 235bp", detail: "since 2026-07-24" },
    ]);
    // No level 30 to 45 days back: a gap is not a month's move.
    expect(spreadFigures([level("2026-06-01", 72.5), level("2026-09-25", 60)]).map((item) => item.id))
      .toEqual(["spread", "range"]);
    // Nor is the Sep 20 roll to a contract that trades wider.
    expect(spreadFigures([
      { ...level("2026-08-24", 222), maturity: "2031-06-20" },
      level("2026-09-25", 235),
    ]).map((item) => item.id)).toEqual(["spread", "range"]);
    // Below 100bp the range keeps the level's precision, so the level never falls outside it.
    expect(spreadFigures([level("2026-09-01", 52.1), level("2026-09-10", 44), level("2026-09-25", 38.6)])
      .find((item) => item.id === "range")?.value).toBe("38.6 to 52.1bp");
  });
});
