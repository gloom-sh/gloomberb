import { expect, test } from "bun:test";
import { apiClient } from "../../api-client";
import type { ExchangeAnnouncementsPayload } from "../../api-client/exchange-announcements";
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
    pressReleaseUrl: "https://www.sec.gov/101/ex99-1.htm",
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
  // The 8-K's text row links its press release exhibit, where the figures are; the 10-Q its filing.
  expect(text).toContain("https://www.sec.gov/101/ex99-1.htm");
  expect(text).not.toMatch(/https:\/\/www\.sec\.gov\/101(\s|$)/m);
  expect(text).toContain("https://www.sec.gov/100");

  const json = JSON.parse(await filings("json"));
  expect(json.data[0]).toMatchObject({ items: "2.02,7.01,9.01", itemsLabel: "2.02 Results of operations; 7.01 Regulation FD disclosure" });
  expect(json.data[1]).not.toHaveProperty("itemsLabel");

  const [header, eightK, tenQ] = (await filings("csv")).split("\n");
  // Date, Form, Company and URL where they were; the items, then the fixed columns every export ends with.
  // Exports keep the filing's link in URL and add the press release after the columns they had.
  expect(header).toStartWith("Date,Form,Company,URL,Items,Item names,Press release URL,symbol_or_series,");
  expect(eightK).toContain(',https://www.sec.gov/101,"2.02,7.01,9.01",2.02 Results of operations; 7.01 Regulation FD disclosure,https://www.sec.gov/101/ex99-1.htm,');
  expect(tenQ).toContain(",https://www.sec.gov/100,,,,");
});

// `filings NST.AX` was "Unknown ticker NST.AX", and NST:ASX ended on "files no SEC reports" with nowhere to go.
test("filings reads a venue suffix and, for a company abroad that files nothing with the SEC, lists its exchange's announcements or links its page", async () => {
  const VENUES: Record<string, { venue: string; name: string }> = {
    "NST.AX": { venue: "ASX", name: "Northern Star Resources Limited" },
    "NST:ASX": { venue: "ASX", name: "Northern Star Resources Limited" },
    "AIR.NZ": { venue: "NZX", name: "Air New Zealand Limited" },
    "AIR:NZX": { venue: "NZX", name: "Air New Zealand Limited" },
  };
  const asked: string[] = [];
  const original = apiClient.getCloudExchangeAnnouncements;
  let answer: () => Promise<ExchangeAnnouncementsPayload> = async () => ({
    exchange: "ASX", symbol: "NST", name: "NORTHERN STAR RESOURCES LTD",
    page: "https://www.asx.com.au/markets/trade-our-cash-market/announcements.nst",
    announcements: [{
      date: "2026-10-20T21:19:25.000Z", headline: "September 2026 Quarterly Activities Report", types: ["First Quarter Activities Report"],
      priceSensitive: true, fileSize: "354KB", documentKey: "2924-03150816-6A1350291",
      url: "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03150816",
    }],
    total: 1836, retrievedAt: "2026-10-22T02:00:00.000Z",
  });
  apiClient.getCloudExchangeAnnouncements = (async (params: { symbol: string; exchange: string }) => {
    asked.push(`${params.symbol}:${params.exchange}`);
    return answer();
  }) as typeof apiClient.getCloudExchangeAnnouncements;
  const run = async (symbol: string, format: "text" | "csv") => {
    const cli = createTestCliContext({
      dataProvider: createTestDataProvider({
        getQuote: async (key) => {
          const listing = VENUES[key];
          if (!listing) throw new Error(`Unknown ticker ${key}`);
          return createTestQuote({ symbol: key, name: listing.name, listingExchangeName: listing.venue });
        },
        getSecFilings: async () => [],
      }),
    }, { format });
    await marketDataCliCommands.find((command) => command.name === "filings")!.execute([symbol], cli.context);
    const printed = cli.printed[0]!;
    const text = serializeCliResult(printed.result, { ...DEFAULT_CLI_OPTIONS, format }, printed.options).replace(/\u001b\[[0-9;]*m/g, "");
    return { text, warnings: printed.result.warnings ?? [] };
  };
  try {
    const nst = await run("NST.AX", "text");
    expect(nst.warnings).toContain("Read NST.AX as NST:ASX.");
    expect(nst.text).toContain("Northern Star Resources (ASX) files no SEC reports. Its latest ASX announcements:");
    expect(nst.text).toMatch(/2026-10-20 21:19 UTC\s+September 2026 Quarterly Activities Report\s+First Quarter Activities Report\s+yes/);
    expect(nst.text).toContain("ASX announcements: https://www.asx.com.au/markets/trade-our-cash-market/announcements.nst");
    expect(asked).toEqual(["NST:ASX"]);
    // CSV keeps the notice and the page as notes after the source.
    const csv = (await run("NST:ASX", "csv")).text;
    expect(csv).toContain("# note: Northern Star Resources (ASX) files no SEC reports.");
    expect(csv).toContain("# note: ASX announcements: https://www.asx.com.au/markets/trade-our-cash-market/announcements.nst");

    // ASX unreachable: the page still ends the answer, and the failure is a warning.
    answer = async () => { throw new Error("asx_unavailable"); };
    const down = await run("NST.AX", "text");
    expect(down.text).toContain([
      "Northern Star Resources (ASX) files no SEC reports.",
      "ASX announcements: https://www.asx.com.au/markets/trade-our-cash-market/announcements.nst",
    ].join("\n"));
    expect(down.warnings).toContain("ASX announcements unavailable: asx_unavailable");

    // Another venue abroad links its exchange's page; Gloom Cloud lists ASX's alone.
    const air = await run("AIR.NZ", "text");
    expect(air.text).toContain("Air New Zealand (NZX) files no SEC reports.\nNZX announcements: https://www.nzx.com/companies/AIR/announcements");
    expect(asked).toHaveLength(3);
  } finally {
    apiClient.getCloudExchangeAnnouncements = original;
  }
});
