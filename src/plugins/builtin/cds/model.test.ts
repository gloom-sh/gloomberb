import { describe, expect, test } from "bun:test";
import type { CloudCdsHistoryPointPayload, CloudCdsTradePayload } from "../../../api-client";
import {
  formatNotional,
  formatPoints,
  formatPointsMove,
  quotedPoints,
  issuerGroupKey,
  issuerListSort,
  noLevelMessage,
  normalizeCdsTrades,
  sortIssuers,
  spreadLevelsOf,
  resolveIssuerQuery,
  spreadChartPoints,
  spreadFigures,
  spreadSummary,
  spreadToBasisPoints,
  summarizeIssuers,
  tradesForIssuer,
  withSpreadLevels,
  type IssuerSortPreference,
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

  test("reads a print without a coupon whose upfront is the quote in points as points, never a spread", () => {
    // Whirlpool, 27 Oct 2026: 6.5 and 15.25 in the spread field beside 6.4 and 15.1 points of upfront.
    const whirlpool = { issuerName: "Whirlpool Corp", fixedRate: null, spreadNotation: "3", notionalCapped: true };
    const [dec28, dec29, small, coupon, bare] = normalizeCdsTrades([
      payload({ ...whirlpool, reportedSpread: 0.00065, upfrontAmount: 319_861 }),
      payload({ ...whirlpool, disseminationId: "2", reportedSpread: 0.001525, upfrontAmount: 757_361 }),
      payload({ ...whirlpool, disseminationId: "3", reportedSpread: 0.00065, notionalAmount: 3_000_000, upfrontAmount: 191_917 }),
      // With a coupon, or without an upfront that reads as the same points, the field is a spread.
      payload({ disseminationId: "4", fixedRate: 0.01, reportedSpread: 0.0949, spreadNotation: "3", upfrontAmount: 1_232_374 }),
      payload({ ...whirlpool, disseminationId: "5", reportedSpread: 0.0949, upfrontAmount: 1_232_374 }),
    ]);
    expect([dec28, dec29, small].map((trade) => [trade!.pointsUpfront, trade!.spreadBp])).toEqual([[6.5, null], [15.25, null], [6.5, null]]);
    expect(coupon).toMatchObject({ pointsUpfront: null, couponBp: 100 });
    expect(coupon!.spreadBp).toBeCloseTo(949, 6);
    expect(bare!.pointsUpfront).toBeNull();
    expect(bare!.spreadBp).toBeCloseTo(949, 6);
    // A points print never stands in for the issuer's latest spread.
    expect(summarizeIssuers([dec28!, dec29!])[0]!.latestSpreadBp).toBeNull();
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

  test("ranks by the 5Y level or its 1W or 1M move, widest first, names without one last", () => {
    const levels = spreadLevelsOf([
      { issuer: "Oracle Corporation", spreadBp: 160, date: "2026-08-25", change1W: 28.1, change1M: 75.4 },
      { issuer: "Ford Motor Company", spreadBp: 157, date: "2026-08-25", change1W: 0.9, change1M: null },
    ]);
    const rows = withSpreadLevels(summarizeIssuers([
      ...trades,
      ...normalizeCdsTrades([payload({ disseminationId: "e", executionTimestamp: "2026-08-25T08:00:00Z", issuerName: "Acme Corp" })]),
    ]), levels);
    const order = (sort: string) => sortIssuers(rows, issuerListSort(sort)).map((row) => row.issuer);
    expect(order("1w")).toEqual(["Oracle Corporation", "Ford Motor Company", "Acme Corp"]);
    expect(order("1m")[0]).toBe("Oracle Corporation");
    expect(order("1m").slice(1).toSorted()).toEqual(["Acme Corp", "Ford Motor Company"]);
    expect(order("spread")).toEqual(["Oracle Corporation", "Ford Motor Company", "Acme Corp"]);
    // Most active stays the list's own order, and an unknown sort keeps it.
    expect(issuerListSort("trades")).toEqual({ columnId: "trades", direction: "desc" });

    // Names quoted in points rank as their own group after the bp names, in either direction, and without one last.
    const quoted = withSpreadLevels(summarizeIssuers([
      ...trades,
      ...normalizeCdsTrades([
        payload({ disseminationId: "e", executionTimestamp: "2026-08-25T08:00:00Z", issuerName: "Acme Corp" }),
        payload({ disseminationId: "v", executionTimestamp: "2026-08-25T08:00:00Z", issuerName: "VIRGIN MEDIA FINANCE PLC" }),
        payload({ disseminationId: "s", executionTimestamp: "2026-08-25T08:00:00Z", issuerName: "Staples, Inc." }),
      ]),
    ]), spreadLevelsOf([
      { issuer: "Oracle Corporation", spreadBp: 160, date: "2026-08-25", change1W: 28.1, change1M: 75.4 },
      { issuer: "Ford Motor Company", spreadBp: 157, date: "2026-08-25", change1W: 0.9, change1M: null },
      {
        issuer: "VIRGIN MEDIA FINANCE PLC", spreadBp: 18654.4, date: "2026-08-25", change1W: 15266.3, change1M: 17418.4,
        quote: "upfront", couponBp: 500, upfrontPts: 57.65, change1WPts: 10.9, change1MPts: 36.1,
      },
      // A stale level: no moves, in bp or points.
      { issuer: "Staples, Inc.", spreadBp: 2252.5, date: "2026-08-14", quote: "upfront", couponBp: 500, upfrontPts: 36.66 },
    ]));
    const quotedOrder = (sort: IssuerSortPreference) => sortIssuers(quoted, sort).map((row) => row.issuer);
    expect(quotedOrder(issuerListSort("spread")))
      .toEqual(["Oracle Corporation", "Ford Motor Company", "VIRGIN MEDIA FINANCE PLC", "Staples, Inc.", "Acme Corp"]);
    expect(quotedOrder({ columnId: "spread", direction: "asc" }))
      .toEqual(["Ford Motor Company", "Oracle Corporation", "Staples, Inc.", "VIRGIN MEDIA FINANCE PLC", "Acme Corp"]);
    expect(quotedOrder(issuerListSort("1m")))
      .toEqual(["Oracle Corporation", "VIRGIN MEDIA FINANCE PLC", "Acme Corp", "Ford Motor Company", "Staples, Inc."]);
    expect(quotedOrder(issuerListSort("1w")).slice(0, 3)).toEqual(["Oracle Corporation", "Ford Motor Company", "VIRGIN MEDIA FINANCE PLC"]);
    expect(issuerListSort("bogus")).toEqual({ columnId: "trades", direction: "desc" });
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

  test("reads DTCC's `;` as the comma it stands for, in the name shown and the name matched", () => {
    const amazon = summarizeIssuers(normalizeCdsTrades(["Amazon.com;Inc.", "AMAZON.COM INC", "Amazon.com, Inc."].map((issuerName, index) => (
      payload({ disseminationId: `a${index}`, issuerName })
    ))));
    expect(amazon.map((row) => [row.issuer, row.trades])).toEqual([["Amazon.com, Inc.", 3]]);
    expect(normalizeCdsTrades([payload({ issuerName: "CCO Holdings;LLC" })])[0]!.issuer).toBe("CCO Holdings, LLC");
  });

  test("drills down on the key so aliases open together, each print under the one spelling", () => {
    expect(tradesForIssuer(aliasTrades, "oracle").map((row) => row.issuer)).toEqual(ORACLE.map(() => "Oracle Corporation"));
    expect(tradesForIssuer(aliasTrades, "boeing").map((row) => row.issuer)).toEqual(BOEING.map(() => "The Boeing Company"));
  });
});

describe("resolveIssuerQuery", () => {
  const ticker = { metadata: { ticker: "ORCL", name: "Oracle Corporation" } } as never;

  test("prefers tracked metadata and otherwise hands the loader a bare symbol", () => {
    expect(resolveIssuerQuery("ORCL", ticker)).toBe("Oracle Corporation");
    // Untracked: the loader expands this through instrument search.
    expect(resolveIssuerQuery("orcl", null)).toBe("ORCL");
    expect(resolveIssuerQuery(null, null)).toBeNull();
    // Charter's CDS trades as CCO Holdings: the tracked name would match nothing, so the loader maps the symbol.
    const charter = { metadata: { ticker: "CHTR", name: "Charter Communications, Inc." } } as never;
    expect(resolveIssuerQuery("CHTR", charter)).toBe("CHTR");
  });
});

const inBp = { quote: "spread", couponBp: null, upfrontPts: null, change1WPts: null, change1MPts: null } as const;

function level(date: string, spreadBp: number): CloudCdsHistoryPointPayload {
  return { date, spreadBp, prints: 5, reported: 1, maturity: "2031-12-20" };
}

describe("5Y spread chart", () => {
  test("breaks the line across three weeks without a level", () => {
    const points = spreadChartPoints([
      { date: "2026-06-01", value: 157 },
      { date: "2026-06-19", value: 158 },
      { date: "2026-07-13", value: 187 },
    ]);
    expect(points.map((point) => [point.date.toISOString().slice(0, 10), point.value])).toEqual([
      ["2026-06-01", 157],
      ["2026-06-19", 158],
      ["2026-06-20", null],
      ["2026-07-13", 187],
    ]);
  });

  test("sums up the latest level, its 1W and 1M moves, and the charted range", () => {
    const line = (points: CloudCdsHistoryPointPayload[], change1W: number | null = null, change1M: number | null = null) => (
      { points, change1W, change1M, ...inBp }
    );
    expect(spreadFigures(line([]))).toEqual([]);
    // The moves are the server's, chained through the Sep 20 roll: the level a month back is the Jun contract's.
    expect(spreadSummary(line([{ ...level("2026-08-24", 222.2), maturity: "2031-06-20" }, level("2026-09-25", 234.9)], 4.04, 12.7)))
      .toEqual({
        unit: "bp",
        level: 234.9,
        spreadBp: 234.9,
        date: "2026-09-25",
        couponBp: null,
        change1w: 4.04,
        change1m: 12.7,
        range: { low: 222.2, high: 234.9, since: "2026-08-24" },
      });
    // Moves as the index board prints them, to a tenth of a basis point; the level and range in whole ones.
    expect(spreadFigures(line([
      level("2026-07-24", 214.6),
      level("2026-08-24", 222),
      level("2026-09-11", 181),
      level("2026-09-25", 235),
    ], -0.04, 13))).toEqual([
      { id: "spread", label: "5Y spread", value: "235bp", detail: "2026-09-25" },
      { id: "1w", label: "1W", value: "0.0bp" },
      { id: "1m", label: "1M", value: "+13.0bp" },
      { id: "range", label: "Range", value: "181 to 235bp", detail: "since 2026-07-24" },
    ]);
    // Without a comparable level the move is left out, not shown as zero.
    expect(spreadFigures(line([level("2026-06-01", 72.5), level("2026-09-25", 60)])).map((item) => item.id))
      .toEqual(["spread", "range"]);
    // Below 100bp the range keeps the level's precision, so the level never falls outside it.
    expect(spreadFigures(line([level("2026-09-01", 52.1), level("2026-09-10", 44), level("2026-09-25", 38.6)]))
      .find((item) => item.id === "range")?.value).toBe("38.6 to 52.1bp");
  });

  test("past 2,000bp heads, charts and ranges the line in points upfront on its coupon", () => {
    // Virgin Media Finance on 2026-10-15: 18,654bp reads 57.65 points on the 500bp coupon.
    const virgin = {
      points: [
        { ...level("2026-09-15", 1236), upfrontPts: 21.55 },
        // A day the server could not convert is left out of the points.
        level("2026-09-16", 1240),
        { ...level("2026-10-15", 18654.4), upfrontPts: 57.65 },
      ],
      change1W: 15266.3,
      change1M: 17418.4,
      quote: "upfront" as const,
      couponBp: 500,
      upfrontPts: 57.65,
      change1WPts: 10.9,
      change1MPts: 36.1,
    };
    expect(quotedPoints(virgin)).toEqual([{ date: "2026-09-15", value: 21.55 }, { date: "2026-10-15", value: 57.65 }]);
    expect(spreadSummary(virgin)).toEqual({
      unit: "pts",
      level: 57.65,
      spreadBp: 18654.4,
      date: "2026-10-15",
      couponBp: 500,
      change1w: 10.9,
      change1m: 36.1,
      range: { low: 21.55, high: 57.65, since: "2026-09-15" },
    });
    expect(spreadFigures(virgin)).toEqual([
      { id: "spread", label: "5Y upfront", value: "57.6 pts", detail: "2026-10-15 · 500bp coupon" },
      { id: "1w", label: "1W", value: "+10.9 pts" },
      { id: "1m", label: "1M", value: "+36.1 pts" },
      { id: "range", label: "Range", value: "21.6 to 57.6 pts", detail: "since 2026-09-15" },
    ]);
    expect([formatPoints(58.2), formatPointsMove(-0.04), formatPointsMove(null)]).toEqual(["58.2 pts", "0.0 pts", "--"]);
  });

  test("says why there is no level only for the cause the server names", () => {
    expect(noLevelMessage("upfront-side-unknown", null))
      .toBe("5Y level not derivable: DTCC prints carry upfront without payer side");
    expect(noLevelMessage("upfront-side-unknown", "2025-10-17"))
      .toBe("5Y level not derivable after 2025-10-17: DTCC prints carry upfront without payer side");
    expect(noLevelMessage(null, "2025-10-17")).toBeNull();
  });
});
