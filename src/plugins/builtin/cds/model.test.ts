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
    executionTimestamp: null,
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
    fixedRate: 1,
    reportedSpread: null,
    spreadNotation: null,
    upfrontAmount: null,
    upfrontCurrency: null,
    ...overrides,
  };
}

describe("CDS spread units", () => {
  test("converts reported spreads to basis points by notation", () => {
    expect(spreadToBasisPoints(85, "BPS")).toBe(85);
    expect(spreadToBasisPoints(85, "Basis points")).toBe(85);
    expect(spreadToBasisPoints(0.85, "Percentage")).toBeCloseTo(85, 6);
    expect(spreadToBasisPoints(0.0085, "Decimal")).toBeCloseTo(85, 6);
    // Unlabelled reports follow the percent convention used for the fixed rate.
    expect(spreadToBasisPoints(0.85, null)).toBeCloseTo(85, 6);
    expect(spreadToBasisPoints(null, "BPS")).toBeNull();
  });
});

describe("normalizeCdsTrades", () => {
  test("keeps the reported spread only, and falls back through issuer names", () => {
    const [withSpread, withoutName] = normalizeCdsTrades([
      payload({ reportedSpread: 1.23, spreadNotation: "Percentage", fixedRate: 5 }),
      payload({ disseminationId: "2", issuerName: null, upiUnderlierName: "ACME INC" }),
    ]);
    expect(withSpread!.spreadBp).toBeCloseTo(123, 6);
    expect(withSpread!.couponBp).toBeCloseTo(500, 6);
    // A missing spread is never back-solved from coupon or upfront.
    expect(withoutName!.spreadBp).toBeNull();
    expect(withoutName!.issuer).toBe("ACME INC");
  });

  test("drops reports with an unusable timestamp instead of dating them to 1970", () => {
    expect(normalizeCdsTrades([payload({ eventTimestamp: "not-a-date" })])).toHaveLength(0);
  });

  test("marks capped notionals so a floor is not read as the trade size", () => {
    expect(formatNotional({ notional: 5_000_000, notionalCapped: true })).toBe("5M+");
    expect(formatNotional({ notional: 5_000_000, notionalCapped: false })).toBe("5M");
    expect(formatNotional({ notional: null, notionalCapped: false })).toBe("--");
  });
});

describe("summarizeIssuers", () => {
  const trades = normalizeCdsTrades([
    payload({ disseminationId: "a", eventTimestamp: "2026-08-25T10:00:00Z", reportedSpread: 0.9, spreadNotation: "Percentage" }),
    payload({ disseminationId: "b", eventTimestamp: "2026-08-25T14:00:00Z", reportedSpread: null }),
    payload({ disseminationId: "c", eventTimestamp: "2026-08-25T12:00:00Z", reportedSpread: 1.1, spreadNotation: "Percentage" }),
    payload({ disseminationId: "d", eventTimestamp: "2026-08-25T09:00:00Z", issuerName: "Ford Motor Company" }),
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
  test("prefers the tracked company name and falls back to the raw symbol", () => {
    const ticker = { metadata: { ticker: "ORCL", name: "Oracle Corporation" } } as never;
    expect(resolveIssuerQuery("ORCL", ticker)).toBe("Oracle Corporation");
    expect(resolveIssuerQuery("orcl", null)).toBe("ORCL");
    expect(resolveIssuerQuery(null, null)).toBeNull();
  });
});
