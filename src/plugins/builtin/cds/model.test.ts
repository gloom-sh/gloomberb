import { describe, expect, test } from "bun:test";
import type { CloudCdsTradePayload } from "../../../api-client";
import {
  formatNotional,
  normalizeCdsTrades,
  resolveIssuerQuery,
  spreadToBasisPoints,
  summarizeIssuers,
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
    expect(spreadToBasisPoints(25.6, "Basis points")).toBe(25.6);
    expect(spreadToBasisPoints(0.256, "Percentage")).toBeCloseTo(25.6, 6);
    expect(spreadToBasisPoints(null, "3")).toBeNull();
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

describe("resolveIssuerQuery", () => {
  const ticker = { metadata: { ticker: "ORCL", name: "Oracle Corporation" } } as never;
  const quoted = { quote: { name: "Oracle Corporation" } } as never;

  test("prefers metadata, then the quote name, then the raw symbol", () => {
    expect(resolveIssuerQuery("ORCL", ticker, null)).toBe("Oracle Corporation");
    // ORCL is not in the ticker map, so the loaded quote resolves the issuer.
    expect(resolveIssuerQuery("ORCL", null, quoted)).toBe("Oracle Corporation");
    // Before the quote lands the raw symbol is still queried.
    expect(resolveIssuerQuery("orcl", null, null)).toBe("ORCL");
    expect(resolveIssuerQuery(null, null, null)).toBeNull();
  });
});
