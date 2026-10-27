import { afterEach, expect, test } from "bun:test";
import { carBeneficialOwnersPayload } from "../../plugins/builtin/holders/test-fixture";
import { createTestCliContext } from "../../test-support/cli-context";
import { setHttpFetchTransport } from "../../utils/http-transport";
import type { HolderData } from "../../types/financials";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { marketDataCliCommands } from "./market";
import { createHoldersHeadless } from "../../plugins/builtin/holders/headless";
import { createTestHeadlessContext } from "../../test-support/headless";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { createProviderMiss } from "../../sources/provider-errors";
import { apiClient } from "../../api-client";
import { isCliFailure } from "../errors";

const holders = marketDataCliCommands.find((command) => command.name === "holders")!;
const insider = marketDataCliCommands.find((command) => command.name === "insider")!;
const HOLDER_DATA = { symbol: "CAR", holders: [{ ownerType: "institution", name: "Morgan Stanley", shares: 2_029_978, changeShares: 2_029_978 }] };

afterEach(() => setHttpFetchTransport(null));

const TICKER_HOLDINGS = "/cloud/sec/13f/ticker-holdings";
/** The service's answer for a ticker no 13F filer reports. */
const noIndex = () => Response.json({ error: "No 13F CUSIP found" }, { status: 404 });

function harness() {
  const requests: URL[] = [];
  setHttpFetchTransport(async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    if (parsed.pathname === TICKER_HOLDINGS) return noIndex();
    const payload = carBeneficialOwnersPayload({ history: parsed.searchParams.get("history") === "1" });
    return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
  });
  const cli = createTestCliContext({
    dataProvider: {
      getHolders: async () => HOLDER_DATA,
      // Fewer shares today than when the reports were filed.
      getTickerFinancials: async () => ({ fundamentals: { sharesOutstanding: 32_000_000 } }),
    },
  });
  return { ...cli, requests };
}

test("holders --form lists the beneficial owners, --history every report, and the 13F table stays the default", async () => {
  const run = harness();
  await holders.execute(["CAR", "--form", "all", "--history"], run.context);
  expect([...run.requests[0]!.searchParams].filter(([key]) => key !== "limit" && key !== "offset"))
    .toEqual([["ticker", "CAR"], ["form", "all"], ["history", "1"]]);
  const history = run.printed[0]!.result.data as Array<Record<string, unknown>>;
  expect(history.slice(0, 2).map((row) => [row.filer, row.filingDate])).toEqual([
    ["Jane Street Group, LLC", "2026-05-11"], ["Pentwater Capital Management LP", "2026-05-07"],
  ]);
  expect(history.find((row) => row.filer === "Morgan Stanley")?.thirteenF).toBe("NEW");

  // The percent stays as filed; the same shares over today's count sit beside it.
  const srs = history.find((row) => row.filer === "SRS Investment Management, LLC")!;
  expect([srs.percentOfClass, srs.percentToday, srs.otherPersons]).toEqual([49.3, 54.47, 2]);
  expect(history.find((row) => row.status === "exited")?.percentToday).toBeNull();
  expect(run.printed[0]!.options?.footnote).toBe(
    "% Class is as filed; % Today is the same shares over 32M shares outstanding today. +N after a name: other reporting persons on the same report.",
  );

  await holders.execute(["CAR"], run.context);
  // The default asks the 13F index, not the 13D/13G owners, and keeps the source's list without it.
  expect(run.requests.slice(1).map((url) => url.pathname)).toEqual([TICKER_HOLDINGS]);
  expect((run.printed[1]!.result.data as Array<{ name: string }>).map((row) => row.name)).toEqual(["Morgan Stanley"]);
});

test("holders refuses an unknown form, and --history without a 13D/13G form", async () => {
  const run = harness();
  await expect(holders.execute(["CAR", "--form", "13h"], run.context)).rejects.toThrow('Unknown form "13h".');
  await expect(holders.execute(["CAR", "--history"], run.context)).rejects.toThrow("--history lists 13D/13G reports.");
  expect(run.requests).toHaveLength(0);
});

test("holders on a home line label the values in their own currency and mark the rows held as receipts", async () => {
  // Gloom Cloud's BHP London list, trimmed: dollar values from the 13F filings on a pence-quoted line.
  const data: HolderData = {
    symbol: "BHP.L", name: "BHP Group Limited", currency: "GBp", exchange: "LSE", asOf: "2026-06-30",
    isDepositaryReceipt: false, adrRatio: 2, valueCurrency: "USD", valueBasis: "period_end_price",
    holders: [
      { ownerType: "institution", name: "Paradigm Asset Management Company, LLC", reportDate: "2026-06-30", shares: 66_100,
        shareBasis: "ordinary", value: 2_720_167, percentHeld: 0.000013 },
      { ownerType: "institution", name: "Horizon Financial Services, LLC", reportDate: "2026-06-30", shares: 120,
        shareBasis: "depositary_receipt", value: 9_997, percentHeld: 4.7e-8 },
    ],
  };
  const cli = createTestCliContext({ dataProvider: { getHolders: async () => data } });
  await holders.execute(["BHP:LSE"], cli.context);
  const { result, options } = cli.printed[0]!;
  const text = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "text" }, options).replace(/\u001b\[[0-9;]*m/g, "");
  expect(text).toContain("values in USD");
  expect(text).toContain("Value = shares reported at 2026-06-30 x period-end price (USD).");
  expect(text).toMatch(/Shares +Basis +Value \(USD\) +% Held/);
  expect(text).toMatch(/Paradigm Asset Management Company, LLC +2026-06-30 +66,100 +2\.72M +<0\.01%/);
  expect(text).toMatch(/Horizon Financial Services, LLC +2026-06-30 +120 +ADR +10k +<0\.01%/);
  expect(result.metadata).toMatchObject({ currency: "GBp", valueCurrency: "USD" });
});

test("holders writes HDS's rows: largest value first, percents in percent, and HDS's CSV columns", async () => {
  // Gloom Cloud's SAN list, trimmed: the source orders by a two-decimal stake, which put Northern Trust above Chevy Chase.
  const data: HolderData = {
    symbol: "SAN", name: "Banco Santander, S.A.", currency: "USD", exchange: "NYSE", asOf: "2026-06-30",
    valueCurrency: "USD", valueBasis: "latest_price",
    holders: [
      { ownerType: "institution", name: "Northern Trust Corporation", reportDate: "2026-06-30", shares: 12_968_275,
        value: 174_942_026, percentHeld: 0.00090000004, changeShares: -403_588, changePercent: -0.030182 },
      { ownerType: "institution", name: "Chevy Chase Trust Holdings, LLC", reportDate: "2026-06-30", shares: 14_003_466,
        value: 188_906_753, percentHeld: 0.00090000004, changeShares: 187_825, changePercent: 0.013595 },
    ],
  };
  setHttpFetchTransport(async () => noIndex());
  const cli = createTestCliContext({ dataProvider: { getHolders: async () => data } });
  await holders.execute(["SAN"], cli.context);
  const { result, options } = cli.printed[0]!;
  const hds = await createHoldersHeadless({ loadSnapshot: async () => ({ data }) }).load({
    rawArgument: "SAN", argument: "SAN", symbols: ["SAN"], options: { sort: "value", order: "desc", limit: 25 },
  }, createTestHeadlessContext());
  expect(result.data).toEqual(hds.rows);
  const csv = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options).split("\n");
  expect(csv.slice(0, 3)).toEqual([
    "Holder,Type,Mkt value (USD),Amount,Chg,Chg%,Held (%),Period,symbol_or_series,currency_or_unit,interval,source,as_of",
    '"Chevy Chase Trust Holdings, LLC",institution,188906753,14003466,187825,1.3595,0.09,2026-06-30,SAN,,,SEC EDGAR,2026-06-30',
    "Northern Trust Corporation,institution,174942026,12968275,-403588,-3.0182,0.09,2026-06-30,SAN,,,SEC EDGAR,2026-06-30",
  ]);
});

test("holders on a US line lists the 13F index's filers past the source's few, as many as --limit asks", async () => {
  const offsets: string[] = [];
  setHttpFetchTransport(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname !== TICKER_HOLDINGS) return noIndex();
    const offset = Number(parsed.searchParams.get("offset"));
    offsets.push(String(offset));
    return Response.json({
      ticker: "PBR", quarter: "2026Q2", period: "2026-06-30", previousPeriod: "2026-03-31", warnings: [], asOf: "2026-10-24T00:00:00Z",
      holderCount: 567, newCount: 0, exitCount: 0, totalValue: null, valueScope: "loaded page", hasMore: true, nextOffset: offset + 25,
      rows: Array.from({ length: 25 }, (_, index) => ({
        id: `${offset + index}`, cik: String(offset + index + 1).padStart(10, "0"), fund: `Filer ${offset + index + 1}`,
        ticker: "PBR", cusip: "71654V408", issuer: "Petroleo Brasileiro SA", type: "SH", value: null,
        shares: (100 - offset - index) * 1_000_000, previousShares: (100 - offset - index) * 1_000_000 - 500_000,
        weight: null, previousWeight: null, weightChange: null, action: "add",
      })),
    });
  });
  // The source's own row for the largest filer, in its own spelling: shares at $25.62, a stake of the common class.
  const cli = createTestCliContext({
    dataProvider: {
      getHolders: async () => ({
        symbol: "PBR", currency: "USD", exchange: "NYSE", asOf: "2026-06-30", valueCurrency: "USD", valueBasis: "latest_price",
        summary: { institutionsCount: 567 },
        holders: [{ ownerType: "institution", name: "Filer One LLC", reportDate: "2026-06-30", shares: 100_000_000, value: 2_562_000_000, percentHeld: 0.0269 }],
      }),
    },
  }, { limit: 30 });
  await holders.execute(["PBR"], cli.context);
  expect(offsets).toEqual(["0", "25"]);
  const { result } = cli.printed[0]!;
  const rows = result.data as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(30);
  expect(rows[0]).toMatchObject({ name: "Filer One LLC", value: 2_562_000_000, percentHeld: 2.69, changeShares: 500_000, changePercent: 0.5025 });
  expect(rows[29]).toMatchObject({ name: "Filer 30", shares: 71_000_000, value: 1_819_020_000, changeShares: 500_000 });
  expect(result.metadata).toMatchObject({ shown: 30, total: 567, truncated: true });

  // --tail counts back from the rows loaded, and says it is not the smallest filers.
  offsets.length = 0;
  const tail = createTestCliContext({ dataProvider: { getHolders: async () => ({ symbol: "PBR", currency: "USD", exchange: "NYSE", holders: [] }) } }, { tail: 3 });
  await holders.execute(["PBR"], tail.context);
  expect(offsets).toEqual(["0"]);
  const tailed = tail.printed[0]!.result;
  expect(tailed.metadata).toMatchObject({ shown: 3, reported: 25, total: 567 });
  expect(tailed.warnings).toEqual(["--tail 3 is the last 3 of the largest 25 loaded, not the smallest of all 567 holders."]);
});

test("a fund no source has holders of says it is a fund and what reads it instead, as no data, in holders, 13f and fn HDS", async () => {
  // The service's covered funds for fn MEMB, trimmed: XLE is one, EWJ is not.
  setHttpFetchTransport(async (url) => new URL(url).pathname === "/cloud/members"
    ? Response.json({ funds: [{ ticker: "XLE", name: "Energy", aliases: [], changes: "none", asOf: null }] })
    : noIndex());
  const fund = (symbol: string, listingExchangeName: string) => ({
    getHolders: async () => { throw createProviderMiss("NO_DATA"); },
    getQuote: async () => createTestQuote({ symbol, instrumentType: "ETF", listingExchangeName }),
  });
  const failure = async (command: string, symbol: string, market: Record<string, unknown>) => {
    const cli = createTestCliContext({ dataProvider: createTestDataProvider(market) });
    return marketDataCliCommands.find((entry) => entry.name === command)!.execute([symbol], cli.context).then(() => null, (error) => error);
  };
  for (const command of ["holders", "13f"]) {
    const xle = await failure(command, "XLE", fund("XLE", "ARCA"));
    expect(isCliFailure(xle) && xle.code).toBe("no_data");
    expect(xle.message).toBe("XLE is a fund: there is no ownership breakdown for funds.");
    expect(xle.details).toBe("13F filers that hold it: gloom fn 13F XLE\nWhat it holds: gloom fn MEMB XLE\nFund facts: gloom fn ETF XLE");
  }
  // fn MEMB is named only for a fund it covers, and none of the US commands for a fund listed abroad.
  expect((await failure("holders", "EWJ", fund("EWJ", "ARCA"))).details).toBe("13F filers that hold it: gloom fn 13F EWJ\nFund facts: gloom fn ETF EWJ");
  expect((await failure("holders", "SXR8", fund("SXR8", "XETRA"))).details).toBeUndefined();
  // A company the source has nothing for keeps the source's answer.
  const stock = await failure("holders", "ZZZQ", { ...fund("ZZZQ", "NASDAQ"), getQuote: async () => createTestQuote({ symbol: "ZZZQ", instrumentType: "EQUITY" }) });
  expect(isCliFailure(stock)).toBe(false);

  const hds = await createHoldersHeadless({ loadSnapshot: async () => { throw createProviderMiss("NO_DATA"); } }).load({
    rawArgument: "XLE", argument: "XLE", symbols: ["XLE"], options: { sort: "value", order: "desc", limit: 25 },
  }, createTestHeadlessContext({ marketData: createTestDataProvider(fund("XLE", "ARCA")), apiClient }));
  expect(hds).toMatchObject({
    rows: [],
    unavailableSymbols: ["XLE"],
    empty: "XLE is a fund: there is no ownership breakdown for funds.\n13F filers that hold it: gloom fn 13F XLE\nWhat it holds: gloom fn MEMB XLE\nFund facts: gloom fn ETF XLE",
  });
});

test("insider leads with INS's Form 4 summary, not a 13F list that names no insider, and dates the report by the newest filing", async () => {
  // `insider JNJ` read "none reported" from the 13F list while `fn INS JNJ` summed 42 Form 4 lines.
  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
  const form4 = (date: string, code: string, shares: number, price: number) => `<ownershipDocument><issuer><issuerCik>200406</issuerCik></issuer>`
    + `<reportingOwner><reportingOwnerId><rptOwnerName>DOE JANE</rptOwnerName></reportingOwnerId></reportingOwner><nonDerivativeTable><nonDerivativeTransaction>`
    + `<securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>${date}</value></transactionDate>`
    + `<transactionCoding><transactionCode>${code}</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${shares}</value></transactionShares>`
    + `<transactionPricePerShare><value>${price}</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>`;
  const filings = [[day(3), "S", 1_000, 150], [day(10), "S", 500, 140]] as const;
  const cli = createTestCliContext({
    dataProvider: {
      getHolders: async () => ({ symbol: "JNJ", asOf: "2026-06-30", holders: [{ ownerType: "institution", name: "Vanguard Group Inc", shares: 1 }] }),
      getSecFilings: async () => filings.map(([date], index) => ({
        accessionNumber: `f${index}`, form: "4", filingDate: new Date(`${date}T00:00:00Z`), cik: "0000200406", filingUrl: `https://www.sec.gov/f${index}`,
      })),
      getSecFilingContent: async (filing: { accessionNumber: string }) => form4(...filings[Number(filing.accessionNumber.slice(1))]!),
    },
  });
  await insider.execute(["JNJ"], cli.context);
  const { result, options } = cli.printed[0]!;
  const text = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "text" }, options).replace(/\u001b\[[0-9;]*m/g, "");
  expect(text).not.toContain("none reported");
  expect(text).toContain("Loaded filings, last 90 days: Common Stock: Sold 1.5k shares ($220,000.00)");
  expect(text).toContain(`2 Form 4 lines in the latest 2 filings, newest filed ${day(3)}: gloom fn INS JNJ`);
  expect(text).toContain("(Form 4 filings)");
  expect(result.metadata).toMatchObject({
    form4Insiders: "available",
    form4: { lines: 2, filings: 2, newestFiled: day(3), notCovered: null },
  });
});

