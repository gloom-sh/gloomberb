import { describe, expect, test } from "bun:test";
import type { ScreenDefinition, ScreenPayload } from "../../../api-client/equity-screener";
import type { HeadlessPaneContext } from "../../../types/headless";
import type { TickerFinancials } from "../../../types/financials";
import { screenFixture } from "../equity-screener/test-fixture";
import { peerGroupOf, pickPeers, rankPeerCandidates, selectPeers } from "./relative-valuation-peers";

// Profiles open on the listing's name, `Inc.` and all, before they say what the company does.
const LEARNING = "Duolingo, Inc. Class A Common Stock represents ownership in Duolingo, a technology company focused on language learning and digital education. It serves schools.";
const TUTORING = "Acme Tutors Inc. Class A Common Stock represents equity in Acme Tutors Inc., which operates an online learning platform for tutoring. It also sells software.";
const ENTERPRISE = "Workday, Inc. is an enterprise software company focused on finance and human resources. Its customers include educational institutions and higher education.";

describe("peer groups", () => {
  test("a curated core member is placed by its symbol; a software-filed company whose profile opens on education by its profile", () => {
    expect(peerGroupOf({ symbol: "DUOL", industry: "Software - Application", description: LEARNING })).toMatchObject({ industry: "Education & Training Services", inCore: true });
    expect(peerGroupOf({ symbol: "DUOL", industry: null, description: null })).toMatchObject({ inCore: true });
    expect(peerGroupOf({ symbol: "ACME", industry: "Software - Application", description: TUTORING })).toMatchObject({ industry: "Education & Training Services", inCore: false });
    // Education named after the first sentence is a customer, not the business.
    expect(peerGroupOf({ symbol: "WDAY", industry: "Software - Application", description: ENTERPRISE })).toEqual({ industry: "Software - Application", related: null, inCore: false });
    expect(peerGroupOf({ symbol: "XYZ", industry: null, description: LEARNING })).toBeNull();
  });
});

const candidate = (symbol: string, cap: number | null, reportsOperations = true) => ({ symbol, marketCapUsd: cap, reportsOperations });

describe("peer ranking", () => {
  test("closest market caps by ratio, without the subject, shells or repeats, six at most", () => {
    const peers = rankPeerCandidates({ symbol: "DUOL", marketCapUsd: 6e9 }, [
      candidate("DUOL", 6e9), candidate("HALF", 3e9), candidate("DOUBLE", 12.5e9), candidate("NEAR", 5.5e9),
      candidate("SHELL", 6e9, false), candidate("NEAR", 5.5e9), candidate("TINY", 1e7), candidate("A", 2e9),
      candidate("B", 2e10), candidate("C", 1e9), candidate("NOCAP", null),
    ]);
    // Half the size and twice the size are equally far; ties go to the larger.
    expect(peers).toEqual(["NEAR", "HALF", "DOUBLE", "A", "B", "C"]);
  });
});

describe("peer selection", () => {
  const industry = [candidate("LAUR", 5.4e9), candidate("CVSA", 4.4e9), candidate("LOPE", 4.2e9), candidate("LRN", 3.4e9),
    candidate("COUR", 1.4e9), candidate("CHGG", 8e7)];
  const core = [candidate("COUR", 1.4e9), candidate("CHGG", 8e7), candidate("NRDY", 4.4e8), candidate("LRN", 3.4e9), candidate("DUOL", 6.5e9)];

  test("a core member gets the rest of its curated core first, then the industry's closest to six, and says which is which", () => {
    const duolingo = { symbol: "DUOL", industry: "Software - Application", description: LEARNING, marketCapUsd: 6.5e9 };
    const selection = selectPeers(duolingo, peerGroupOf(duolingo)!, { industry, core })!;
    expect(selection).toMatchObject({ method: "curated-core", curatedPeers: ["LRN", "COUR", "NRDY", "CHGG"], peers: ["LRN", "COUR", "NRDY", "CHGG", "LAUR", "CVSA"] });
    expect(selection.basis).toBe("LRN, COUR, NRDY and CHGG from the online learning curated core; "
      + "LAUR and CVSA, the 2 covered equities in Education & Training Services closest to DUOL in market cap");
  });

  test("a subject outside the core keeps industry first, with the core only among the candidates", () => {
    const acme = { symbol: "ACME", industry: "Software - Application", description: TUTORING, marketCapUsd: 5e9 };
    const selection = selectPeers(acme, peerGroupOf(acme)!, { industry, core })!;
    expect(selection).toMatchObject({ method: "related-industry", peers: ["LAUR", "CVSA", "LOPE", "DUOL", "LRN", "COUR"] });
    expect(selection.curatedPeers).toBeUndefined();
    const plain = { symbol: "AAA", industry: "Airlines", description: null, marketCapUsd: 1e9 };
    expect(selectPeers(plain, peerGroupOf(plain)!, { industry: [], core: [] })).toBeNull();
    expect(selectPeers(plain, peerGroupOf(plain)!, { industry: [candidate("BBB", 2e9)], core: [] })).toMatchObject({ method: "industry", peers: ["BBB"] });
  });

  test("too few covered names, or no screener, fall back to the labelled curated list", () => {
    const duolingo = { symbol: "DUOL", industry: "Software - Application", description: LEARNING, marketCapUsd: 6.5e9 };
    for (const candidates of [{ industry: [], core: [candidate("LRN", 3.4e9)] }, null]) {
      const curated = selectPeers(duolingo, peerGroupOf(duolingo)!, candidates);
      expect(curated).toMatchObject({ method: "curated", peers: ["COUR", "CHGG", "NRDY", "LRN", "UDMY"] });
    }
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

test("--peers asks the screener for the related industry and the curated core, and ranks the core first", async () => {
  const asked: ScreenDefinition[] = [];
  const apiClient = {
    async equityScreener(_path: string, init: RequestInit) {
      const query = JSON.parse(String(init.body)) as ScreenDefinition & { limit: number; cursor: null };
      asked.push(query);
      const criterion = query.criteria[0]!;
      const rows = criterion.field === "industry"
        ? [screenRow("LAUR", "Education & Training Services", 5.4e9), screenRow("XXI", "Education & Training Services", 4.2e9, false),
          screenRow("CVSA", "Education & Training Services", 4.4e9), screenRow("LRN", "Education & Training Services", 3.4e9),
          screenRow("COUR", "Education & Training Services", 1.4e9), screenRow("CHGG", "Education & Training Services", 8e7)]
        : [screenRow("DUOL", "Software - Application", 6.5e9), screenRow("COUR", "Education & Training Services", 1.4e9),
          screenRow("CHGG", "Education & Training Services", 8e7), screenRow("NRDY", "Software - Application", 4.4e8),
          screenRow("LRN", "Education & Training Services", 3.4e9)];
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
    { field: "symbol", op: "in", value: ["DUOL", "COUR", "CHGG", "NRDY", "LRN", "UDMY"] },
  ]);
  expect(selection).toMatchObject({ method: "curated-core", industry: "Education & Training Services", curatedGroup: "online learning" });
  // The core first (the uncovered UDMY drops out), then the closest education companies; the shell XXI never.
  expect(selection.peers).toEqual(["LRN", "COUR", "NRDY", "CHGG", "LAUR", "CVSA"]);
});
