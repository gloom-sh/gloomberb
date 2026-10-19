import { expect, test } from "bun:test";
import { createTestCliContext } from "../../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import type { SecFilingItem } from "../../types/data-provider";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { marketDataCliCommands } from "./market";

const FILINGS: SecFilingItem[] = [
  {
    accessionNumber: "0000072971-26-000101", form: "8-K", filingDate: new Date("2026-10-13"), items: "2.02,7.01,9.01",
    cik: "72971", companyName: "WELLS FARGO & COMPANY/MN", filingUrl: "https://www.sec.gov/101",
  },
  {
    accessionNumber: "0000072971-26-000100", form: "10-Q", filingDate: new Date("2026-08-01"),
    cik: "72971", companyName: "WELLS FARGO & COMPANY/MN", filingUrl: "https://www.sec.gov/100",
  },
];

async function filings(format: "text" | "json" | "csv"): Promise<string> {
  const run = createTestCliContext({
    dataProvider: createTestDataProvider({
      getQuote: async () => createTestQuote({ symbol: "WFC", name: "Wells Fargo & Company", listingExchangeName: "NYSE" }),
      getSecFilings: async () => FILINGS,
    }),
  }, { format });
  await marketDataCliCommands.find((command) => command.name === "filings")!.execute(["WFC"], run.context);
  const printed = run.printed[0]!;
  return serializeCliResult(printed.result, { ...DEFAULT_CLI_OPTIONS, format }, printed.options);
}

test("filings names an 8-K's items; exports keep the codes in items and add the names after the columns they had", async () => {
  const text = (await filings("text")).replace(/\u001b\[[0-9;]*m/g, "");
  expect(text).toContain("2.02 Results of operations; 7.01 Regulation FD disclosure");

  const json = JSON.parse(await filings("json"));
  expect(json.data[0]).toMatchObject({ items: "2.02,7.01,9.01", itemsLabel: "2.02 Results of operations; 7.01 Regulation FD disclosure" });
  expect(json.data[1]).not.toHaveProperty("itemsLabel");

  const [header, eightK, tenQ] = (await filings("csv")).split("\n");
  // Date, Form, Company and URL where they were; the items, then the fixed columns every export ends with.
  expect(header).toStartWith("Date,Form,Company,URL,Items,Item names,symbol_or_series,");
  expect(eightK).toContain(',https://www.sec.gov/101,"2.02,7.01,9.01",2.02 Results of operations; 7.01 Regulation FD disclosure,');
  expect(tenQ).toContain(",https://www.sec.gov/100,,,");
});
