import { describe, expect, test } from "bun:test";
import type { ScreenDefinition, ScreenPayload } from "../../../api-client/equity-screener";
import type { HeadlessPaneContext } from "../../../types/headless";
import type { TickerFinancials } from "../../../types/financials";
import { screenFixture } from "../equity-screener/test-fixture";
import { peerGroupOf, peerMethodTitle, pickPeers, rankPeerCandidates, selectPeers } from "./relative-valuation-peers";

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

  test("a megacap keeps its industry's peers of a hundredth its size or more, the sector fills the rest, and too few anywhere leave the industry's", () => {
    const amazon = { symbol: "AMZN", industry: "Internet Retail", description: null, marketCapUsd: 2.75e12 };
    const retail = [candidate("MELI", 8.5e10), candidate("DASH", 7.3e10), candidate("EBAY", 5.3e10), candidate("CHWY", 1.5e10), candidate("ETSY", 6e9)];
    const cyclical = [candidate("TSLA", 1.6e12), candidate("HD", 3.2e11), candidate("MCD", 1.8e11), candidate("EBAY", 5.3e10), candidate("NKE", 1e11)];
    const widened = selectPeers(amazon, peerGroupOf(amazon)!, { industry: retail, core: [], sector: { name: "Consumer Cyclical", candidates: cyclical } })!;
    expect(widened).toMatchObject({ method: "sector", industryPeers: ["MELI", "DASH", "EBAY"], peers: ["MELI", "DASH", "EBAY", "TSLA", "HD", "MCD"] });
    expect(peerMethodTitle(widened)).toBe("peers by industry: Internet Retail, then sector: Consumer Cyclical");
    expect(widened.basis).toBe("MELI, DASH and EBAY, the 3 covered equities in Internet Retail of at least a hundredth of AMZN's market cap; "
      + "TSLA, HD and MCD, the 3 covered equities in the Consumer Cyclical sector closest to AMZN in market cap");
    // A sector with no one else of its size keeps the industry's closest, as without one.
    const unwidened = selectPeers(amazon, peerGroupOf(amazon)!, { industry: retail, core: [], sector: { name: "Consumer Cyclical", candidates: [candidate("TINY", 1e9)] } });
    expect(unwidened).toMatchObject({ method: "industry", peers: ["MELI", "DASH", "EBAY", "CHWY", "ETSY"] });
  });

  test("too few covered names, or no screener, fall back to the labelled curated list", () => {
    const duolingo = { symbol: "DUOL", industry: "Software - Application", description: LEARNING, marketCapUsd: 6.5e9 };
    for (const candidates of [{ industry: [], core: [candidate("LRN", 3.4e9)] }, null]) {
      const curated = selectPeers(duolingo, peerGroupOf(duolingo)!, candidates);
      expect(curated).toMatchObject({ method: "curated", peers: ["COUR", "CHGG", "NRDY", "LRN", "UDMY"] });
    }
  });
});

function screenRow(symbol: string, industry: string, cap: number, operating = true, sector: string | null = null): ScreenPayload["rows"][number] {
  const row = structuredClone(screenFixture().rows[0]!);
  const set = (field: keyof typeof row.metrics, value: number) => {
    row.metrics[field] = { ...row.metrics[field], value, state: "available", asOf: "2026-10-13" };
  };
  set("marketCap", cap);
  if (operating) set("revenueGrowthPercent", 10);
  return { ...row, symbol, exchange: "NYSE", name: symbol, industry, sector };
}

/** A screener over `universe` that answers the criteria the peer pick asks with (`in`, `gte`, `between`), sorted and limited. */
function universeScreener(universe: ScreenPayload["rows"], asked: ScreenDefinition[]): HeadlessPaneContext["apiClient"] {
  return {
    async equityScreener(_path: string, init: RequestInit) {
      const query = JSON.parse(String(init.body)) as ScreenDefinition & { limit: number; cursor: null };
      const { limit, cursor: _cursor, ...definition } = query;
      asked.push(definition);
      const cap = (row: ScreenPayload["rows"][number]) => row.metrics.marketCap.value ?? 0;
      const rows = universe.filter((row) => definition.criteria.every((criterion) => {
        if (criterion.op === "in") return criterion.value.includes(String(row[criterion.field as "symbol" | "sector" | "industry"]));
        if (criterion.op === "gte") return cap(row) >= criterion.value;
        if (criterion.op === "between") return cap(row) >= criterion.value[0] && cap(row) <= criterion.value[1];
        throw new Error(`unexpected criterion ${JSON.stringify(criterion)}`);
      })).sort((left, right) => (definition.sort.direction === "asc" ? cap(left) - cap(right) : cap(right) - cap(left))).slice(0, limit);
      return { ...screenFixture(), definition, rows, universe: { ...screenFixture().universe, covered: rows.length, matched: rows.length } };
    },
  } as unknown as HeadlessPaneContext["apiClient"];
}

function financialsOf(symbol: string, cap: number, industry: string, description: string | null = null): TickerFinancials {
  return {
    annualStatements: [], quarterlyStatements: [], priceHistory: [],
    quote: { symbol, price: 100, change: 0, changePercent: 0, currency: "USD", lastUpdated: 1, marketCap: cap },
    profile: { industry, ...description ? { description } : {} },
  };
}

describe("--peers by market cap across industry and sector", () => {
  const tech = (symbol: string, cap: number) => screenRow(symbol, "Semiconductors", cap, true, "Technology");
  const gadgets = (symbol: string, cap: number) => screenRow(symbol, "Consumer Electronics", cap, true, "Technology");
  const airline = (symbol: string, cap: number) => screenRow(symbol, "Airlines", cap, true, "Industrials");
  const universe = [
    gadgets("AAPL", 5.02e12), gadgets("SONO", 2.1e9), gadgets("VUZI", 1.98e8), gadgets("UEIC", 6.8e7), gadgets("AXIL", 3.7e7),
    gadgets("RIME", 2.3e6), gadgets("BOXL", 1.7e6),
    tech("NVDA", 5.19e12), tech("MSFT", 3.94e12), tech("AVGO", 1.68e12), tech("MU", 1.11e12), tech("AMD", 9.44e11), tech("INTC", 4.82e11),
    tech("TXN", 2.83e11), tech("TINY", 9e6),
    airline("DAL", 5.29e10), airline("UAL", 3.36e10), airline("LUV", 2.13e10), airline("AAL", 8.3e9), airline("ALK", 4e9),
    airline("SKYW", 3.7e9), airline("MESA", 4e7), screenRow("PCAR", "Farm & Heavy Construction Machinery", 5.4e10, true, "Industrials"),
  ];
  const pick = async (symbol: string, cap: number, industry: string) => {
    const asked: ScreenDefinition[] = [];
    const ctx = { apiClient: universeScreener(universe, asked), signal: new AbortController().signal } as HeadlessPaneContext;
    return { selection: await pickPeers(symbol, financialsOf(symbol, cap, industry), ctx), asked };
  };

  test("a megacap whose industry is micro-caps gets its sector's large caps, nearest in size", async () => {
    const { selection, asked } = await pick("AAPL", 5.02e12, "Consumer Electronics");
    expect(asked.map((query) => query.criteria)).toEqual([
      [{ field: "industry", op: "in", value: ["Consumer Electronics"] }],
      [{ field: "sector", op: "in", value: ["Technology"] }, { field: "marketCap", op: "gte", value: 5.02e12 }],
      [{ field: "sector", op: "in", value: ["Technology"] }, { field: "marketCap", op: "between", value: [Math.floor(5.02e12 / 100), 5.02e12] }],
    ]);
    expect(selection).toMatchObject({ method: "sector", sector: "Technology", industryPeers: [], peers: ["NVDA", "MSFT", "AVGO", "MU", "AMD", "INTC"] });
    expect(peerMethodTitle(selection, { automatic: true })).toBe("auto peers by sector: Technology");
    expect(selection.basis).toBe("the 6 covered equities in the Technology sector closest to AAPL in market cap, "
      + "as no other covered equity in Consumer Electronics has a hundredth of its market cap");
  });

  test("a mid-cap whose industry has peers of its size keeps them and never asks the sector", async () => {
    const { selection, asked } = await pick("DAL", 5.29e10, "Airlines");
    expect(asked.map((query) => query.criteria)).toEqual([[{ field: "industry", op: "in", value: ["Airlines"] }]]);
    // MESA, under a hundredth of DAL, is left out though the table has room for a sixth.
    expect(selection).toMatchObject({ method: "industry", peers: ["UAL", "LUV", "AAL", "ALK", "SKYW"] });
    expect(peerMethodTitle(selection)).toBe("peers by industry: Airlines");
  });
});

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
