import { describe, expect, test } from "bun:test";
import type { ScreenDefinition, ScreenPayload } from "../../../api-client/equity-screener";
import type { HeadlessPaneContext } from "../../../types/headless";
import type { TickerFinancials } from "../../../types/financials";
import { screenFixture } from "../equity-screener/test-fixture";
import { peerGroupOf, pickPeers, rankPeerCandidates, selectPeers } from "./relative-valuation-peers";

const LEARNING = "Duolingo, Inc. is a technology company focused on language learning and digital education. It serves schools.";
const ENTERPRISE = "Workday, Inc. is an enterprise software company focused on finance and human resources. Its customers include educational institutions and higher education.";

describe("peer groups", () => {
  test("a software-filed company whose profile opens on education is compared with education companies", () => {
    expect(peerGroupOf({ symbol: "DUOL", industry: "Software - Application", description: LEARNING })?.industry).toBe("Education & Training Services");
    // Education named after the first sentence is a customer, not the business.
    expect(peerGroupOf({ symbol: "WDAY", industry: "Software - Application", description: ENTERPRISE })).toEqual({ industry: "Software - Application", related: null });
    expect(peerGroupOf({ symbol: "XYZ", industry: null, description: LEARNING })).toBeNull();
  });
});

describe("peer ranking", () => {
  const candidate = (symbol: string, cap: number | null, reportsOperations = true) => ({ symbol, marketCapUsd: cap, reportsOperations });

  test("closest market caps by ratio, without the subject, shells or repeats, six at most", () => {
    const peers = rankPeerCandidates({ symbol: "DUOL", marketCapUsd: 6e9 }, [
      candidate("DUOL", 6e9), candidate("HALF", 3e9), candidate("DOUBLE", 12.5e9), candidate("NEAR", 5.5e9),
      candidate("SHELL", 6e9, false), candidate("NEAR", 5.5e9), candidate("TINY", 1e7), candidate("A", 2e9),
      candidate("B", 2e10), candidate("C", 1e9), candidate("NOCAP", null),
    ]);
    // Half the size and twice the size are equally far; ties go to the larger.
    expect(peers).toEqual(["NEAR", "HALF", "DOUBLE", "A", "B", "C"]);
  });

  test("too few covered names fall back to the related industry's curated list, and nothing else to null", () => {
    const subject = { symbol: "DUOL", industry: "Software - Application", description: LEARNING, marketCapUsd: 6e9 };
    const group = peerGroupOf(subject)!;
    const curated = selectPeers(subject, group, [candidate("LRN", 3e9)]);
    expect(curated?.method).toBe("curated");
    expect(curated?.peers).not.toContain("DUOL");
    expect(curated?.peers.length).toBeGreaterThanOrEqual(4);
    const plain = { symbol: "AAA", industry: "Airlines", description: null, marketCapUsd: 1e9 };
    expect(selectPeers(plain, peerGroupOf(plain)!, [])).toBeNull();
    expect(selectPeers(plain, peerGroupOf(plain)!, [candidate("BBB", 2e9)])).toMatchObject({ method: "industry", peers: ["BBB"] });
  });
});

function screenRow(symbol: string, industry: string, cap: number, operating = true): ScreenPayload["rows"][number] {
  const row = structuredClone(screenFixture().rows[0]!);
  const set = (field: keyof typeof row.metrics, value: number) => {
    row.metrics[field] = { ...row.metrics[field], value, state: "available", asOf: "2026-10-13" };
  };
  set("marketCap", cap);
  if (operating) set("revenueGrowthPercent", 10);
  return { ...row, symbol, exchange: "NYSE", name: symbol, industry };
}

test("--peers reads the related industry and its members from the screener, labelled as a related-industry pick", async () => {
  const asked: ScreenDefinition[] = [];
  const apiClient = {
    async equityScreener(_path: string, init: RequestInit) {
      const query = JSON.parse(String(init.body)) as ScreenDefinition & { limit: number; cursor: null };
      asked.push(query);
      const criterion = query.criteria[0]!;
      const rows = criterion.field === "industry"
        ? [screenRow("LAUR", "Education & Training Services", 5.4e9), screenRow("XXI", "Education & Training Services", 4.2e9, false),
          screenRow("LRN", "Education & Training Services", 3.4e9), screenRow("COUR", "Education & Training Services", 1.4e9),
          screenRow("CHGG", "Education & Training Services", 8e7)]
        : [screenRow("NRDY", "Software - Application", 4.4e8), screenRow("DUOL", "Software - Application", 6.5e9)];
      const { limit: _limit, cursor: _cursor, ...definition } = query;
      return { ...screenFixture(), definition, rows, universe: { ...screenFixture().universe, covered: rows.length, matched: rows.length } };
    },
  } as unknown as HeadlessPaneContext["apiClient"];
  const financials = {
    annualStatements: [], quarterlyStatements: [], priceHistory: [],
    quote: { symbol: "DUOL", price: 140, change: 0, changePercent: 0, currency: "USD", lastUpdated: 1, marketCap: 6.5e9 },
    profile: { industry: "Software - Application", description: LEARNING },
  } satisfies TickerFinancials;
  const ctx = { apiClient, signal: new AbortController().signal } as HeadlessPaneContext;

  const selection = await pickPeers("DUOL", financials, ctx);
  expect(asked.map((query) => query.criteria[0])).toEqual([
    { field: "industry", op: "in", value: ["Education & Training Services"] },
    { field: "symbol", op: "in", value: ["DUOL", "NRDY", "UDMY"] },
  ]);
  expect(selection).toMatchObject({ method: "related-industry", industry: "Education & Training Services", subjectIndustry: "Software - Application" });
  expect(selection.peers).toEqual(["LAUR", "LRN", "COUR", "NRDY", "CHGG"]);
  expect(selection.basis).toContain("files it under Software - Application");
});
