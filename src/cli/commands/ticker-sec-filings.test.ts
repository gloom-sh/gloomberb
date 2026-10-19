import { expect, spyOn, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { SecFilingItem } from "../../types/data-provider";
import type { MarketContext } from "../types";
import { createTestDataProvider } from "../../test-support/data-provider";
import { ticker } from "./ticker";
import { createCoreCliCommands } from "../index";
import { checkCliCommandOptions } from "../command-options";
import { createTestCliContext } from "../../test-support/cli-context";

const config = createDefaultConfig("/tmp/gloom-ticker-sec-unused");

// JPM as the service lists it: note supplements in runs, the 13G/A it files as a holder of other
// companies (no file number) among its own filings, the results 8-K behind them.
const filing = (form: string, index: number, extra: Partial<SecFilingItem> = {}): SecFilingItem => ({
  form, accessionNumber: `0000019617-26-${String(index).padStart(6, "0")}`, filingDate: new Date("2026-10-13"), cik: "19617",
  filingUrl: `https://www.sec.gov/${index}`, ...extra,
});
const issuer = [
  ...Array.from({ length: 30 }, (_, index) => filing(index % 3 ? "424B2" : "FWP", index)),
  // A note's term sheet filed as a plain 424B3, among the supplements.
  filing("424B3", 31, { primaryDocDescription: "FORM 424B3" }),
  filing("SCHEDULE 13G/A", 40, { fileNumber: "" }),
  filing("SCHEDULE 13G/A", 41, { fileNumber: "" }),
  filing("8-K", 100, { items: "2.02,9.01", primaryDocDescription: "8-K", fileNumber: "001-05805" }),
  // Filed for JPM by an agent, about another company.
  filing("SCHEDULE 13D/A", 42, { accessionNumber: "0001193125-26-410213", fileNumber: "" }),
  filing("8-K", 101, { items: "7.01,9.01" }),
  // About JPM: its own 005- number.
  filing("SCHEDULE 13G", 50, { accessionNumber: "0002100119-26-000693", fileNumber: "005-34242" }),
  // A row an older server sent without file numbers: kept, never guessed.
  filing("SC 13G/A", 51),
  ...Array.from({ length: 4 }, (_, index) => filing("4", 200 + index)),
  filing("10-Q", 300),
];
// Rallybio files its merger prospectus as a 424B3, and no notes.
const merger = [
  filing("EFFECT", 70, { cik: "1739410" }),
  filing("424B3", 71, { cik: "1739410", primaryDocDescription: "424B3" }),
  filing("S-4/A", 72, { cik: "1739410" }),
];
// Apple's schedules are all about Apple.
const apple = [
  filing("SCHEDULE 13G", 60, { cik: "320193", fileNumber: "005-33632" }),
  filing("4", 61, { cik: "320193", fileNumber: "" }),
  filing("SC 13G/A", 62, { cik: "320193", fileNumber: "005-33632" }),
];

async function report({ all = false, filings = issuer, json = true }: { all?: boolean; filings?: SecFilingItem[]; json?: boolean } = {}) {
  let data: any;
  let text = "";
  const requested: number[] = [];
  const log = spyOn(console, "log").mockImplementation((line?: unknown) => { text += `${String(line)}\n`; });
  try {
    await ticker("JPM", {
      allFilings: all,
      initMarketData: async () => ({
        config, dataDir: "/tmp/gloom-ticker-sec-unused",
        store: { loadTicker: async () => null }, persistence: { close: () => {} },
        dataProvider: {
          ...createTestDataProvider({ getTickerFinancials: async () => ({ annualStatements: [{ date: "2025-12-31", totalRevenue: 1 }], quarterlyStatements: [], priceHistory: [] }) }),
          getNews: async () => [],
          getSecFilings: async (_symbol: string, count = 0) => { requested.push(count); return filings.slice(0, count); },
        },
      }) as unknown as MarketContext,
      fail: (message) => { throw new Error(message); },
      ...json ? { printResult: (result: { data?: unknown }) => { data = result.data; } } : {},
    });
  } finally {
    log.mockRestore();
  }
  return { data, requested, text: text.replace(/\u001b\[[0-9;]*m/g, "") };
}

const forms = (data: any) => data.recentSecFilings.map((row: { form: string }) => row.form);

test("ticker's recent SEC filings are the company's own: no pricing supplements or 13D/13G about others, counted in one note", async () => {
  const { data, requested } = await report();
  expect(requested).toEqual([200]);
  expect(forms(data)).toEqual(["8-K", "8-K", "SCHEDULE 13G", "SC 13G/A", "4"]);
  // Codes in items, as fn SEC and filings give them; the words the text shows beside them.
  expect(data.recentSecFilings[0]).toMatchObject({ items: "2.02,9.01", itemsLabel: "2.02 Results of operations" });
  expect(data.recentSecFilingsHidden).toEqual({ pricingSupplements: 31, ownershipReportsAboutOthers: 3 });

  const { text } = await report({ json: false });
  const section = text.slice(text.indexOf("Recent SEC Filings"));
  expect(section).toContain("Items 2.02 Results of operations");
  expect(section).toContain("Items 7.01 Regulation FD disclosure");
  expect(section).not.toContain("424B2");
  expect(section).not.toContain("SCHEDULE 13G/A");
  expect(section).not.toContain("424B3");
  expect(section).toContain("31 pricing supplements and 3 ownership reports about other companies hidden, --all to show");

  const all = await report({ all: true });
  expect(forms(all.data)).toEqual(["FWP", "424B2", "424B2", "FWP", "424B2"]);
  expect(all.data.recentSecFilingsHidden).toEqual({ pricingSupplements: 0, ownershipReportsAboutOthers: 0 });
  // Past the supplements, --all lists the term sheet and the schedules about other companies too.
  expect(forms((await report({ all: true, filings: issuer.slice(30) })).data))
    .toEqual(["424B3", "SCHEDULE 13G/A", "SCHEDULE 13G/A", "8-K", "SCHEDULE 13D/A"]);

  // A company's 424B3 merger prospectus is its own.
  const company = await report({ filings: merger });
  expect(forms(company.data)).toEqual(["EFFECT", "424B3", "S-4/A"]);
  expect(company.data.recentSecFilingsHidden).toEqual({ pricingSupplements: 0, ownershipReportsAboutOthers: 0 });

  const own = await report({ filings: apple });
  expect(forms(own.data)).toEqual(["SCHEDULE 13G", "4", "SC 13G/A"]);
  expect(own.data.recentSecFilingsHidden).toEqual({ pricingSupplements: 0, ownershipReportsAboutOthers: 0 });
});

test("ticker --all, as the CLI reads it, keeps the supplements and the schedules", async () => {
  const command = createCoreCliCommands(() => [], () => null, () => []).find((entry) => entry.name === "ticker")!;
  // The dispatcher's option check takes --all.
  expect(() => checkCliCommandOptions(command, ["JPM", "--all"])).not.toThrow();
  const run = async (args: string[]) => {
    const requested: number[] = [];
    const cli = createTestCliContext({
      config, dataDir: "/tmp/gloom-ticker-sec-unused",
      dataProvider: {
        ...createTestDataProvider({ getTickerFinancials: async () => ({ annualStatements: [{ date: "2025-12-31", totalRevenue: 1 }], quarterlyStatements: [], priceHistory: [] }) }),
        getNews: async () => [],
        getSecFilings: async (_symbol: string, count = 0) => { requested.push(count); return issuer.slice(0, count); },
      },
    }, { format: "json" });
    await command.execute(args, cli.context);
    return { requested, data: cli.printed[0]!.result.data };
  };
  const all = await run(["JPM", "--all"]);
  expect(all.requested).toEqual([5]);
  expect(all.data.recentSecFilings.map((row: { form: string }) => row.form)).toEqual(["FWP", "424B2", "424B2", "FWP", "424B2"]);
  expect((await run(["JPM"])).requested).toEqual([200]);
});
