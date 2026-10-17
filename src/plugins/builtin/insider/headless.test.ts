import { describe, expect, test } from "bun:test";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import type { HeadlessPaneLoadArgs } from "../../../types/plugin";
import type { SecFilingItem } from "../../../types/data-provider";
import { loadParsedInsiderFilings } from "./client";
import { createInsiderHeadless } from "./headless";
import type { ParsedInsiderFiling } from "./model";
import { createTestHeadlessContext } from "../../../test-support/headless";
import type { InsiderSignalsPayload } from "../../../api-client/insider-signals";
import { insiderSignalsCache } from "./signals-client";
import { normalizeCapabilityOptions, type PaneFunctionCapability } from "../../../cli/pane-functions/capabilities";
import { parsePaneFunctionArgs } from "../../../cli/pane-functions/options";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { setCliWidthOverride } from "../../../utils/cli-output";

const parsed: ParsedInsiderFiling[] = [
  {
    filing: {
      accessionNumber: "one",
      form: "4",
      filingDate: new Date("2026-08-26T00:00:00.000Z"),
      cik: "0000002488",
      filingUrl: "https://www.sec.gov/one",
    },
    transaction: {
      filingDate: new Date("2026-08-25T00:00:00.000Z"),
      reportedName: "SU LISA T",
      title: "Chief Executive Officer",
      transactionType: "P",
      shares: 25_000,
      pricePerShare: 150,
      totalValue: 3_750_000,
      sharesOwned: 4_000_000,
      form: "4",
    },
    isLoading: false,
  },
  {
    filing: {
      accessionNumber: "two",
      form: "4",
      filingDate: new Date("2026-08-24T00:00:00.000Z"),
      cik: "0000002488",
      filingUrl: "https://www.sec.gov/two",
    },
    transaction: {
      filingDate: new Date("2026-08-23T00:00:00.000Z"),
      reportedName: "OTHER OFFICER",
      title: "Officer",
      transactionType: "S",
      shares: 1_000,
      pricePerShare: 155,
      totalValue: 155_000,
      sharesOwned: 20_000,
      form: "4",
    },
    isLoading: false,
  },
];

function args(name = "", limit = 20, type?: string): HeadlessPaneLoadArgs {
  return {
    rawArgument: "AMD",
    argument: "AMD",
    symbols: ["AMD"],
    options: { name, limit, ...(type ? { type } : {}) },
  };
}

// The company's own CIK is 2488; 891478 files a Form 4 as an owner of another company.
function form4(issuerCik: string, owner = "SU LISA T") {
  return `<ownershipDocument><issuer><issuerCik>${issuerCik}</issuerCik></issuer><reportingOwner><reportingOwnerId><rptOwnerName>${owner}</rptOwnerName></reportingOwnerId></reportingOwner><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-08-20</value></transactionDate><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>10</value></transactionShares></transactionAmounts></nonDerivativeTransaction></ownershipDocument>`;
}

function listed(accessionNumber: string, form: string, date: string): SecFilingItem {
  return { accessionNumber, form, filingDate: new Date(`${date}T00:00:00Z`), cik: "0000002488", filingUrl: `https://www.sec.gov/${accessionNumber}` };
}

describe("insider client", () => {
  test("leaves out the Form 4s the company filed as an owner of another issuer, reading one at a time until it has its own", async () => {
    let active = 0;
    let maxActive = 0;
    const read: string[] = [];
    const contents: Record<string, string> = {
      owned: form4("1580608", "BANCO SANTANDER"),
      own: form4("0000002488"),
      older: form4("2488", "OTHER OFFICER"),
    };
    const provider = createTestDataProvider({
      getSecFilings: async () => [listed("owned", "4", "2026-08-26"), listed("10q", "10-Q", "2026-08-01"), listed("own", "4", "2026-07-20"), listed("older", "4", "2026-07-01")],
      getSecFilingContent: async (filing) => {
        read.push(filing.accessionNumber);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(1);
        active -= 1;
        return contents[filing.accessionNumber] ?? null;
      },
    });

    const result = await loadParsedInsiderFilings(provider, "AMD", { limit: 1 });

    expect(result.parsed.map(({ filing }) => filing.accessionNumber)).toEqual(["own"]);
    expect(result.foreignPrivateIssuer).toBe(false);
    expect(read).toEqual(["owned", "own"]);
    expect(maxActive).toBe(1);
  });

  test("a foreign private issuer whose Form 4s are all filed as an owner has none, and says why", async () => {
    const load = (filings: SecFilingItem[]) => createInsiderHeadless().load(args("", 20), {
      ...createTestHeadlessContext(),
      marketData: createTestDataProvider({
        getSecFilings: async () => filings,
        getSecFilingContent: async (filing) => form4(filing.accessionNumber === "own" ? "2488" : "1580608", "BANCO SANTANDER"),
      }),
    });
    const owned = [listed("owned-1", "4", "2022-01-31"), listed("owned-2", "4/A", "2008-05-20")];

    const foreign = await load([listed("6k", "6-K", "2026-10-08"), ...owned, listed("annual", "20-F", "2026-03-01"), listed("old", "10-K", "2001-03-01")]);
    expect(foreign.rows).toEqual([]);
    expect(foreign.empty).toBe("No Form 4 insiders: foreign private issuers file none.");
    expect(foreign.metadata?.foreignPrivateIssuer).toBe(true);

    // A company that moved to domestic reports is not one, though it once filed a 20-F.
    const domestic = await load([listed("10k", "10-K", "2026-02-01"), ...owned, listed("annual", "20-F", "2020-03-01")]);
    expect(domestic.empty).toBe("No Form 4 insider filings.");

    // Its own Form 4s, from before it reported as a foreign private issuer, are still shown.
    const history = await load([listed("6k", "6-K", "2026-10-08"), ...owned, listed("own", "4", "2005-01-01")]);
    expect(history.rows.map((row) => row.accessionNumber)).toEqual(["own"]);
    expect(history.metadata?.foreignPrivateIssuer).toBe(false);
  });

  test("a listing abroad whose company files nothing with the SEC says so by name, as filings does", async () => {
    const load = (symbol: string) => createInsiderHeadless().load({ ...args(), rawArgument: symbol, argument: symbol, symbols: [symbol] }, {
      ...createTestHeadlessContext(),
      marketData: createTestDataProvider({
        getSecFilings: async () => [],
        getSecFilingContent: async () => null,
        getQuote: async (_symbol, exchange) => createTestQuote({ symbol: "CAR.AX", name: "CAR Group Limited", currency: "AUD", listingExchangeName: exchange }),
      }),
    });
    expect((await load("CAR:ASX")).empty).toBe("CAR Group (ASX) files no SEC reports.");
    // A US symbol the SEC lists nothing for has no Form 4, which is all the report knows.
    expect((await load("ZZZZ")).empty).toBe("No Form 4 insider filings.");
  });

  test("filing limit expands every transaction and reports failed content even with an owner filter", async () => {
    const tx = (shares: number) => `<nonDerivativeTransaction><securityTitle><value>Class A</value></securityTitle><transactionDate><value>2026-08-20</value></transactionDate><transactionCoding><transactionCode>G</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${shares}</value></transactionShares></transactionAmounts></nonDerivativeTransaction>`;
    const provider = createTestDataProvider({
      getSecFilings: async () => parsed.map(({ filing }) => filing),
      getSecFilingContent: async (filing) => filing.accessionNumber === "one"
        ? `<ownershipDocument><reportingOwner><reportingOwnerId><rptOwnerName>SU LISA T</rptOwnerName></reportingOwnerId></reportingOwner>${tx(55)}${tx(294)}</ownershipDocument>`
        : null,
    });
    const result = await createInsiderHeadless().load(args("su lisa t", 2), { ...createTestHeadlessContext(), marketData: provider });
    expect(result.rows.map((row) => [row.id, row.shares, row.side])).toEqual([["one:0", 55, "GIFT"], ["one:1", 294, "GIFT"]]);
    expect(result.metadata).toMatchObject({ parsed: 1, transactions: 2, requested: 2 });
    expect(result.errors).toEqual(["two: Form 4 transactions are unavailable or incomplete."]);
  });
});

describe("insider headless model", () => {
  test("projects parsed Form 4 values and applies the owner filter", async () => {
    const requestedLimits: number[] = [];
    const headless = createInsiderHeadless({
      loadParsed: async (_symbol, limit) => {
        requestedLimits.push(limit);
        return { parsed: parsed.slice(0, limit), foreignPrivateIssuer: false, noFilings: false };
      },
    });

    const all = await headless.load(args("", 2), createTestHeadlessContext());
    expect(all.rows[0]).toMatchObject({
      insider: "SU LISA T",
      side: "BUY",
      shares: 25_000,
      totalValue: 3_750_000,
    });

    const filtered = await headless.load(args("other officer", 2), createTestHeadlessContext());
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0]).toMatchObject({ insider: "OTHER OFFICER", side: "SELL" });
    // The name the pane shows matches too.
    const shown = await headless.load(args("Lisa T. Su", 2), createTestHeadlessContext());
    expect(shown.rows.map((row) => [row.insider, row.insiderName, row.role])).toEqual([["SU LISA T", "Lisa T. Su", "CEO"]]);
    expect(requestedLimits).toEqual([2, 2, 2]);
  });
});

describe("insider report without a ticker", () => {
  // Invented company and people.
  const signals = (window: number, rows: InsiderSignalsPayload["rows"]): InsiderSignalsPayload => ({
    window, through: "2026-10-15", asOf: "2026-10-14", coverage: { from: "2026-08-31", through: "2026-10-14" }, rows,
  });
  const row: InsiderSignalsPayload["rows"][number] = {
    ticker: "NWBI", issuerCik: "9900001", company: "Northwind Biologics Inc", score: 78,
    reasons: ["3 insiders, $1.2M in 14 days", "CFO raised stake 56%"], insiders: 3, buys: 3, value: 1_152_500, shares: 95_000,
    firstBuy: "2026-10-01", lastBuy: "2026-10-14", lastFiled: "2026-10-14",
    signals: { clusterInsiders: 3, repeatBuys: 1, usualRatio: null, stakeIncreasePct: 136.4, newPosition: false },
    buyers: [{ name: "Rivera Ana", role: "CEO", value: 496_000, buys: 1, lastBuy: "2026-10-01" }, { name: "Okafor Ben", role: "Director", value: 354_000, buys: 1, lastBuy: "2026-10-14" }],
  };

  test("ranks the companies whose insiders are buying, with the reasons and the buyers under each", async () => {
    const asked: unknown[] = [];
    const apiClient = { getCloudSecInsiderSignals: async (params: { window?: number; limit?: number }) => {
      asked.push(params);
      return signals(params.window ?? 30, params.window === 7 ? [] : [row]);
    } } as never;
    const load = (window: number) => createInsiderHeadless().load(
      { rawArgument: "", argument: "", symbols: [], options: { name: "", limit: 20, window } },
      createTestHeadlessContext({ apiClient }),
    );
    try {
      const report = await load(30);
      expect(report.columns?.map((column) => column.header))
        .toEqual(["Ticker", "Company", "Score", "Role", "Nth", "Vs Usual", "Stake", "Buyers", "Bought", "Last Buy", "Filed", "Insiders"]);
      expect(report.rows[0]).toMatchObject({
        ticker: "NWBI",
        score: 78,
        // A server that predates structured signals: the lead's role and how many others, no figures.
        role: "CEO +2",
        nth: null,
        vsUsual: null,
        stake: null,
        // Why stays in the rows as the server's sentences.
        why: "3 insiders, $1.2M in 14 days · CFO raised stake 56%",
        filingDate: "2026-10-14",
        buyers: "Ana Rivera (CEO) $496k; Ben Okafor (Director) $354k",
      });
      expect((await load(7)).empty).toBe("No open-market insider buying in the last 7 days.");
      expect(asked).toEqual([{ window: 30, limit: 20 }, { window: 7, limit: 20 }]);
    } finally {
      insiderSignalsCache.reset();
    }
  });

  test("ranks selling with --side sell and the filters, the facts as text and each insider's stake under the row", async () => {
    const asked: unknown[] = [];
    const sale: InsiderSignalsPayload["rows"][number] = {
      ...row,
      ticker: "TRNT", company: "Tailspin Toys Inc", score: 61, reasons: ["3 insiders, $4.2M in 5 days", "CEO sold 40% of stake"],
      whySignals: [
        { kind: "cluster", value: 3, text: "3 insiders", insider: null },
        { kind: "stake", value: -40, text: "-40%", insider: { name: "Rivera Ana", role: "CEO" } },
        { kind: "repeat", value: 2, text: "2nd sale", insider: { name: "Rivera Ana", role: "CEO" } },
      ],
      buyers: [
        { name: "Rivera Ana", role: "CEO", value: 2_400_000, buys: 2, lastBuy: "2026-10-13", shares: 60_000, stakeChangePct: -40, newPosition: false, exited: false },
        { name: "Okafor Ben", role: "Director", value: 1_800_000, buys: 1, lastBuy: "2026-10-09", shares: 45_000, stakeChangePct: -100, newPosition: false, exited: true },
      ],
      marketCap: 1.2e9,
    };
    const apiClient = { getCloudSecInsiderSignals: async (params: Record<string, unknown>) => {
      asked.push(params);
      return { ...signals(Number(params.window ?? 30), params.cap === "large" ? [] : [sale]), side: "sell", marketCaps: "stored" };
    } } as never;
    const load = (options: Record<string, string | number | boolean>) => createInsiderHeadless().load(
      { rawArgument: "", argument: "", symbols: [], options: { name: "", limit: 20, window: 30, side: "sell", role: "all", ...options } },
      createTestHeadlessContext({ apiClient }),
    );
    try {
      const report = await load({ role: "officers", minValue: 1_000_000, cluster: true, exited: true });
      expect(asked[0]).toEqual({ side: "sell", window: 30, limit: 20, role: "officers", minValue: 1_000_000, cluster: true, position: "exited" });
      expect(report.columns?.map((column) => column.header))
        .toEqual(["Ticker", "Company", "Score", "Role", "Nth", "Vs Usual", "Stake", "Sellers", "Sold", "Last Sale", "Filed", "Insiders"]);
      // On a narrow table the size against usual moves under the row first, then the nth sale, the company and the filing day.
      expect(report.columns?.filter((column) => column.stackPriority).map((column) => [column.key, column.stackPriority]))
        .toEqual([["company", 2], ["nth", 3], ["vsUsual", 4], ["filingDate", 1]]);
      expect(report.rows[0]).toMatchObject({
        ticker: "TRNT",
        role: "CEO +2",
        // The lead's nth sale from the why facts of a server that predates the buyer's own.
        nth: 2,
        vsUsual: null,
        stake: -40,
        stakeBothWays: false,
        why: "3 insiders, $4.2M in 5 days · CEO sold 40% of stake",
        reasons: ["3 insiders, $4.2M in 5 days", "CEO sold 40% of stake"],
        marketCap: 1.2e9,
        buyers: "Ana Rivera (CEO) $2.4M -40%; Ben Okafor (Director) $1.8M EXITED",
      });
      expect(report.metadata).toMatchObject({ side: "sell", marketCaps: "stored" });
      expect((await load({ cap: "large" })).empty).toBe("No insider selling in the last 30 days matches these filters.");
      // A position filter belongs to one side.
      await expect(load({ new: true })).rejects.toThrow("--new is a buying filter");
      await expect(load({ side: "buy", exited: true })).rejects.toThrow("--exited is a selling filter");
    } finally {
      insiderSignalsCache.reset();
    }
  });
});

test("the ranking's text fits 120 columns whole, and on 80 the size against usual, the nth trade and the company move under the row", async () => {
  // Invented company and people.
  const rows: InsiderSignalsPayload["rows"] = [{
    ticker: "NWBI", issuerCik: "9900001", company: "Northwind Biologics Incorporated", score: 78, reasons: ["3 insiders, $1.2M in 14 days"],
    insiders: 3, buys: 3, value: 1_152_500, shares: 95_000, firstBuy: "2026-10-01", lastBuy: "2026-10-14", lastFiled: "2026-10-14",
    signals: { clusterInsiders: 3, repeatBuys: 12, usualRatio: 100, stakeIncreasePct: 2415, newPosition: false },
    buyers: [
      { name: "Rivera Ana", role: "10% owner", value: 796_000, buys: 4, lastBuy: "2026-10-01", stakeChangePct: 2415, repeatBuys: 12, usualRatio: 100 },
      { name: "Okafor Ben", role: "Director", value: 356_500, buys: 1, lastBuy: "2026-10-14", newPosition: true, repeatBuys: 1, usualRatio: null },
    ],
  }, {
    ticker: "TRNT", issuerCik: "9900002", company: "Tailspin Toys", score: 40, reasons: ["CFO bought $496k"],
    insiders: 1, buys: 2, value: 496_000, shares: 9_000, firstBuy: "2026-10-01", lastBuy: "2026-10-04", lastFiled: "2026-10-05",
    signals: { clusterInsiders: 1, repeatBuys: 1, usualRatio: null, stakeIncreasePct: 12.4, newPosition: false },
    buyers: [{ name: "Chen Li", role: "CFO", value: 496_000, buys: 2, lastBuy: "2026-10-04", stakeChangePct: 12.4, twoWay: true, repeatBuys: null, usualRatio: null }],
  }];
  const apiClient = { getCloudSecInsiderSignals: async (): Promise<InsiderSignalsPayload> => ({
    window: 30, through: "2026-10-15", asOf: "2026-10-14", coverage: { from: "2026-08-31", through: "2026-10-14" }, rows,
  }) } as never;
  const headless = createInsiderHeadless();
  const args = { rawArgument: "", argument: "", symbols: [], options: { name: "", limit: 20, window: 30 } };
  try {
    const result = await headless.load(args, createTestHeadlessContext({ apiClient }));
    const text = (width: number) => {
      setCliWidthOverride(width);
      return renderHeadlessPaneText(headless, result, args, "INS").replace(/\x1b\[[0-9;]*m/g, "").split("\n");
    };
    const wide = text(120);
    expect(wide).toContain("Ticker  Company                        Score  Role           Nth  Vs Usual   Stake  Buyers  Bought  Last Buy  Filed");
    // Every column stays; a long company name is cut.
    expect(wide).toContain("NWBI    Northwind Biologics Incorpor\u2026     78  10% owner +2  12th     100x+     25x       3  $1.15M  10/14/26  2026-10-14");
    // Traded both ways: dashes for the nth trade and size, the stake marked.
    expect(wide).toContain("TRNT    Tailspin Toys                     40  CFO             --        --  +12% \u00b1       1   $496k  10/4/26   2026-10-05");
    expect(wide).toContain("  Ana Rivera (10% owner) $796k 25x; Ben Okafor (Director) $356.5k NEW");
    expect(Math.max(...wide.map((line) => line.length))).toBeLessThanOrEqual(120);
    const narrow = text(80);
    expect(narrow).toContain("Ticker  Score  Role           Stake  Buyers  Bought  Last Buy  Filed");
    expect(narrow).toContain("TRNT       40  CFO           +12% \u00b1       1   $496k  10/4/26   2026-10-05");
    expect(narrow).toContain("  Company Northwind Biologics Incorporated  Nth 12th  Vs Usual 100x+");
    expect(Math.max(...narrow.map((line) => line.length))).toBeLessThanOrEqual(80);
  } finally {
    setCliWidthOverride(null);
    insiderSignalsCache.reset();
  }
});

test("the catalog's examples for the ranking run without a ticker and read as the options they name", () => {
  const options = createInsiderHeadless().options;
  const capability = { id: "insider", botSafe: true, options } as unknown as PaneFunctionCapability;
  const examples = options.filter((option) => option.example).map((option) => [option.example!, option.exampleWithoutArgument]);
  expect(examples).toEqual([
    ["--side sell --min-value 250000", true],
    ["--role directors --cluster --window 90", true],
    ["--side sell --exited", true],
  ]);
  const read = (example: string) => {
    const parsed = parsePaneFunctionArgs(["INS", ...example.split(" ")]);
    expect(parsed.arg).toBe("");
    const { side, window, role, minValue, cluster, exited } = normalizeCapabilityOptions(capability, parsed.options, { code: "INS" });
    return { side, window, role, minValue, cluster, exited };
  };
  expect(read(examples[0]![0] as string)).toMatchObject({ side: "sell", window: 30, role: "all", minValue: 250_000 });
  expect(read(examples[1]![0] as string)).toMatchObject({ side: "buy", window: 90, role: "directors", cluster: true });
  expect(read(examples[2]![0] as string)).toMatchObject({ side: "sell", exited: true });
});
