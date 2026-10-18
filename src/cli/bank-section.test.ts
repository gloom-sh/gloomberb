import { expect, test } from "bun:test";
import type { BankFiguresPayload } from "../api-client/bank-figures";
import { createTestCliContext } from "../test-support/cli-context";
import type { TickerFinancials } from "../types/financials";
import { marketDataCliCommands } from "./commands/market";
import { DEFAULT_CLI_OPTIONS, type CliOutputFormat } from "./options";
import { serializeCliResult } from "./result";
import type { PeriodicFiling, StatementReportSources } from "./statement-filings";

const FDIC = { fetchedAt: "2026-10-18T20:39:04.458Z", sha256: "c".repeat(64), datasetAsOf: "2026-08-19T18:58:33.000Z" };
// JPM's figures as Gloom Cloud served them on 2026-10-18, from the 10-Qs and the FDIC's call report for cert 628.
const JPM_BANK: BankFiguresPayload = {
  symbol: "JPM",
  company: { cik: "0000019617", name: "JPMORGAN CHASE & CO" },
  bank: true,
  deposits: {
    currency: "USD",
    latest: { date: "2026-06-30", value: 2_713_700_000_000, form: "10-Q", filed: "2026-08-06", accessionNumber: "0001628280-26-054343", basis: "total" },
    previous: { date: "2026-03-31", value: 2_675_520_000_000, form: "10-Q", filed: "2026-05-01", accessionNumber: "0001628280-26-029344", basis: "total" },
    sources: [{ url: "https://data.sec.gov/api/xbrl/companyconcept/CIK0000019617/us-gaap/Deposits.json", fetchedAt: "2026-10-18T20:39:01.774Z", sha256: "a".repeat(64) }],
  },
  leadBank: {
    cert: 628, name: "JPMorgan Chase Bank, National Association", rssd: "852218", state: "OH",
    holdingCompany: { name: "JPMORGAN CHASE&CO", rssd: "1039502" }, totalAssets: 4_091_315_000_000, reportDate: "2026-06-30", otherBanks: 1,
    source: { url: "https://api.fdic.gov/banks/institutions", ...FDIC, datasetAsOf: "2026-10-16T11:58:03.000Z" },
  },
  callReport: {
    cert: 628, reportDate: "2026-06-30", totalDeposits: 2_820_284_000_000, domesticDeposits: 2_226_790_000_000,
    insuredDeposits: 893_279_000_000, uninsuredDeposits: 1_392_514_000_000, uninsuredShare: 1_392_514 / (893_279 + 1_392_514),
    cre: { constructionAndLand: 18_789_000_000, multifamily: 107_317_000_000, nonOwnerOccupied: 39_378_000_000, total: 165_484_000_000 },
    capital: { basis: "total risk-based capital", value: 326_427_000_000 },
    creToCapital: 165_484 / 326_427,
    source: { url: "https://api.fdic.gov/banks/financials?filters=CERT%3A628", ...FDIC },
  },
  notes: [],
};

const JPM: TickerFinancials = {
  quote: { symbol: "JPM", name: "JPMorgan Chase & Co.", price: 330, currency: "USD", change: 0, changePercent: 0, exchangeName: "NYSE" },
  fundamentals: { trailingPE: 14.25, eps: 23.84 },
  profile: { sector: "Financial Services", industry: "Banks - Diversified" },
  annualStatements: [{ date: "2025-12-31", totalRevenue: 1, dateSource: "sec", dateEvidence: { accessionNumber: "0001628280-26-008131", filed: "2026-02-13" } }],
  quarterlyStatements: [{ date: "2026-06-30", totalRevenue: 1, dateSource: "sec", dateEvidence: { accessionNumber: "0001628280-26-054343", filed: "2026-08-06" } }],
  priceHistory: [],
};
const JPM_FILINGS: PeriodicFiling[] = [
  { form: "8-K", filed: "2026-10-13", accessionNumber: "0001628280-26-065582", items: ["2.02", "9.01"] },
  { form: "10-Q", filed: "2026-08-06", accessionNumber: "0001628280-26-054343", items: [], reportDate: "2026-06-30" },
];

async function fundamentals(financials: TickerFinancials, sources: Partial<StatementReportSources>, format: CliOutputFormat = "text") {
  const bankCalls: string[] = [];
  const statementSources: StatementReportSources = {
    statementFilings: async () => JPM_FILINGS,
    bankFigures: async (symbol) => { bankCalls.push(symbol); return JPM_BANK; },
    ...sources,
  };
  const cli = createTestCliContext({ dataProvider: { getTickerFinancials: async () => financials }, statementSources }, { format });
  await marketDataCliCommands.find((entry) => entry.name === "fundamentals")!.execute([financials.quote!.symbol], cli.context);
  const [printed] = cli.printed;
  const output = serializeCliResult(printed!.result, { ...DEFAULT_CLI_OPTIONS, format }, printed!.options).replace(/\u001b\[[0-9;]*m/g, "");
  return { output, data: printed!.result.data as any, bankCalls };
}

test("a bank's fundamentals show its dated deposits, their change, its lead bank's uninsured share and CRE, and where NIM is", async () => {
  const { output, data } = await fundamentals(JPM, {});
  const lines = output.split("\n");
  expect(lines).toContain("Latest quarter 2026-06-30, 10-Q filed 2026-08-06.");
  expect(lines).toContain("Q3 (Sep 2026) results released 2026-10-13 (8-K); statements arrive with the 10-Q.");
  const bank = lines.slice(lines.indexOf("Bank"), lines.indexOf("Bank") + 7);
  expect(bank).toEqual([
    "Bank",
    "Lead Bank           JPMorgan Chase Bank, National Association (FDIC cert 628; largest of 2 insured banks by assets at 2026-06-30; FDIC data of 2026-10-16)",
    "Deposits            2.71T USD at 2026-06-30 (10-Q filed 2026-08-06)",
    "Deposits QoQ        +1.43% from 2.68T USD at 2026-03-31 (10-Q filed 2026-05-01)",
    "Uninsured Deposits  60.9% of deposits, 1.39T USD (call report 2026-06-30, FDIC data of 2026-08-19)",
    "CRE / Capital       50.7%: CRE 165.48B USD over total risk-based capital 326.43B USD (call report 2026-06-30, FDIC data of 2026-08-19)",
    "NIM is a Pro figure in EQS: gloomberb fn EQS --metric kpiNimPercent --definition "
      + `'{"version":1,"currency":null,"criteria":[{"field":"symbol","op":"in","value":["JPM"]}],"sort":{"field":"symbol","direction":"asc"}}'`,
  ]);
  expect(data.bank.callReport.creToCapital).toBeCloseTo(0.507, 3);
  expect(data.statementFilings.resultsRelease.accessionNumber).toBe("0001628280-26-065582");

  const csv = (await fundamentals(JPM, {}, "csv")).output.split("\n");
  expect(csv).toContain("# section: Bank");
  expect(csv.find((line) => line.startsWith("Deposits Filing,"))).toStartWith("Deposits Filing,10-Q filed 2026-08-06,JPM,");
  expect(csv.find((line) => line.startsWith("Uninsured Share (%),"))).toStartWith("Uninsured Share (%),60.92");
  expect(csv.find((line) => line.startsWith("Deposits QoQ (%),"))).toStartWith("Deposits QoQ (%),1.427");
});

test("a bank without FDIC data keeps its deposits and says so in one line; an unreachable service is one line too", async () => {
  const noFdic: BankFiguresPayload = { ...JPM_BANK, leadBank: null, callReport: null, notes: ["FDIC data is unavailable right now."] };
  const { output } = await fundamentals(JPM, { bankFigures: async () => noFdic });
  expect(output).toMatch(/\nDeposits +2\.71T USD at 2026-06-30 \(10-Q filed 2026-08-06\)\n/);
  expect(output).toContain("FDIC data is unavailable right now.");
  expect(output).not.toContain("Uninsured");

  const down = await fundamentals(JPM, { bankFigures: async () => { throw new Error("503"); } });
  expect(down.output).toContain("Bank\nBank figures (deposits, uninsured share, CRE) are unavailable right now.");
  expect(down.data.bankNote).toBe("Bank figures (deposits, uninsured share, CRE) are unavailable right now.");
});

test("a company outside finance is never asked for bank figures, and its report gains only the statement line", async () => {
  const apple: TickerFinancials = {
    ...JPM,
    quote: { ...JPM.quote!, symbol: "AAPL", name: "Apple Inc.", exchangeName: "NASDAQ" },
    profile: { sector: "Technology", industry: "Consumer Electronics" },
  };
  const { output, data, bankCalls } = await fundamentals(apple, {});
  expect(bankCalls).toEqual([]);
  expect(output).not.toContain("\nBank\n");
  expect(output).not.toContain("NIM");
  expect(output).toContain("Latest quarter 2026-06-30, 10-Q filed 2026-08-06.");
  expect(data.bank).toBeNull();
  // A financial company that is not a bank: Gloom Cloud says so, and the report says nothing.
  const visa = await fundamentals({ ...apple, profile: { sector: "Financial Services", industry: "Credit Services" } },
    { bankFigures: async () => ({ ...JPM_BANK, bank: false, deposits: null, leadBank: null, callReport: null }) });
  expect(visa.output).not.toContain("\nBank\n");
});
