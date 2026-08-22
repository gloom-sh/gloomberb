import { afterEach, describe, expect, test } from "bun:test";
import {
  SecEdgarClient,
  extractFilingContent,
  parseCompanyFactsFinancialStatements,
  parseFilingDocuments,
  parseRecentFilings,
  parseSubmissionArchiveNames,
  parseTickerLookup,
} from "./sec-edgar";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("parseTickerLookup", () => {
  test("supports SEC field/data lookup payloads", () => {
    const lookup = parseTickerLookup({
      fields: ["cik", "name", "ticker", "exchange"],
      data: [
        [320193, "Apple Inc.", "AAPL", "Nasdaq"],
        [789019, "Microsoft Corp", "MSFT", "Nasdaq"],
      ],
    });

    expect(lookup.get("AAPL")).toEqual({
      cik: "0000320193",
      exchange: "Nasdaq",
      name: "Apple Inc.",
    });
    expect(lookup.get("MSFT")?.cik).toBe("0000789019");
  });

  test("supports legacy numbered lookup payloads", () => {
    const lookup = parseTickerLookup({
      "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
    });

    expect(lookup.get("AAPL")?.name).toBe("Apple Inc.");
    expect(lookup.get("AAPL")?.cik).toBe("0000320193");
  });
});

describe("parseRecentFilings", () => {
  test("maps SEC columnar submissions data into filing items", () => {
    const filings = parseRecentFilings({
      cik: "0000320193",
      name: "Apple Inc.",
      filings: {
        recent: {
          accessionNumber: ["0000320193-24-000123"],
          form: ["8-K"],
          filingDate: ["2024-08-01"],
          acceptanceDateTime: ["20240801163045"],
          primaryDocument: ["aapl-8k.htm"],
          primaryDocDescription: ["Current report"],
          items: ["2.02,9.01"],
        },
      },
    });

    expect(filings).toHaveLength(1);
    expect(filings[0]?.form).toBe("8-K");
    expect(filings[0]?.filingUrl).toBe("https://www.sec.gov/Archives/edgar/data/320193/0000320193-24-000123-index.htm");
    expect(filings[0]?.primaryDocumentUrl).toBe("https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-8k.htm");
  });

  test("reads older submission archive names", () => {
    expect(parseSubmissionArchiveNames({
      filings: {
        files: [
          { name: "CIK0000320193-submissions-001.json", filingCount: 1000 },
          { name: "readme.txt" },
        ],
      },
    })).toEqual(["CIK0000320193-submissions-001.json"]);
  });
});

describe("parseFilingDocuments", () => {
  test("maps filing index document rows into primary and exhibit documents", () => {
    const documents = parseFilingDocuments(`
      <html>
        <body>
          <table class="tableFile" summary="Document Format Files">
            <tr>
              <th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th>
            </tr>
            <tr>
              <td>1</td>
              <td>Current report</td>
              <td><a href="/ixviewer/doc/action?doc=/Archives/edgar/data/320193/000032019324000123/aapl-8k.htm">aapl-8k.htm</a></td>
              <td>8-K</td>
              <td>10000</td>
            </tr>
            <tr>
              <td>2</td>
              <td>Results of Operations and Financial Condition</td>
              <td><a href="/Archives/edgar/data/320193/000032019324000123/aapl-ex991.htm">aapl-ex991.htm</a></td>
              <td>EX-99.1</td>
              <td>42000</td>
            </tr>
          </table>
        </body>
      </html>
    `, {
      accessionNumber: "0000320193-24-000123",
      form: "8-K",
      filingDate: new Date("2024-08-01T00:00:00Z"),
      cik: "0000320193",
      filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/0000320193-24-000123-index.htm",
      primaryDocument: "aapl-8k.htm",
      primaryDocumentUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-8k.htm",
    });

    expect(documents).toMatchObject([
      {
        type: "8-K",
        document: "aapl-8k.htm",
        isPrimary: true,
        url: "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-8k.htm",
      },
      {
        type: "EX-99.1",
        description: "Results of Operations and Financial Condition",
        document: "aapl-ex991.htm",
        isPrimary: false,
      },
    ]);
  });
});

describe("parseCompanyFactsFinancialStatements", () => {
  test("maps SEC company facts into deeper annual and quarterly statement rows", () => {
    const fact = (tag: string, unit: string, rows: unknown[]) => ({
      [tag]: {
        units: {
          [unit]: rows,
        },
      },
    });
    const duration = (end: string, val: number, overrides: Record<string, unknown> = {}) => ({
      start: `${end.slice(0, 4)}-01-01`,
      end,
      val,
      filed: end,
      form: "10-K",
      fp: "FY",
      ...overrides,
    });
    const instant = (end: string, val: number, overrides: Record<string, unknown> = {}) => ({
      end,
      val,
      filed: end,
      form: "10-K",
      fp: "FY",
      ...overrides,
    });

    const statements = parseCompanyFactsFinancialStatements({
      facts: {
        "us-gaap": {
          ...fact("RevenueFromContractWithCustomerExcludingAssessedTax", "USD", [
            duration("2020-12-31", 100),
            duration("2021-03-31", 30, { form: "10-Q", fp: "Q1", frame: "CY2021Q1" }),
            duration("2021-06-30", 40, { form: "10-Q", fp: "Q2", frame: "CY2021Q2" }),
          ]),
          ...fact("NetCashProvidedByUsedInOperatingActivities", "USD", [
            duration("2020-12-31", 25),
            duration("2021-03-31", 8, { form: "10-Q", fp: "Q1", frame: "CY2021Q1" }),
          ]),
          ...fact("PaymentsToAcquirePropertyPlantAndEquipment", "USD", [
            duration("2020-12-31", 5),
            duration("2021-03-31", 3, { form: "10-Q", fp: "Q1", frame: "CY2021Q1" }),
          ]),
          ...fact("Assets", "USD", [
            instant("2020-12-31", 500),
            instant("2021-03-31", 520, { form: "10-Q", fp: "Q1", frame: "CY2021Q1I" }),
          ]),
          ...fact("EarningsPerShareDiluted", "USD/shares", [
            duration("2020-12-31", 1.25),
            duration("2021-03-31", 0.35, { form: "10-Q", fp: "Q1", frame: "CY2021Q1" }),
          ]),
        },
      },
    });

    expect(statements.annualStatements).toEqual([{
      date: "2020-12-31",
      availableAt: "2020-12-31",
      fieldAvailability: {
        totalRevenue: "2020-12-31",
        operatingCashFlow: "2020-12-31",
        capitalExpenditure: "2020-12-31",
        freeCashFlow: "2020-12-31",
        totalAssets: "2020-12-31",
        eps: "2020-12-31",
      },
      totalRevenue: 100,
      operatingCashFlow: 25,
      capitalExpenditure: -5,
      freeCashFlow: 20,
      totalAssets: 500,
      eps: 1.25,
    }]);
    expect(statements.quarterlyStatements).toEqual([
      {
        date: "2021-03-31",
        availableAt: "2021-03-31",
        fieldAvailability: {
          totalRevenue: "2021-03-31",
          operatingCashFlow: "2021-03-31",
          capitalExpenditure: "2021-03-31",
          freeCashFlow: "2021-03-31",
          totalAssets: "2021-03-31",
          eps: "2021-03-31",
        },
        totalRevenue: 30,
        operatingCashFlow: 8,
        capitalExpenditure: -3,
        freeCashFlow: 5,
        totalAssets: 520,
        eps: 0.35,
      },
      {
        date: "2021-06-30",
        availableAt: "2021-06-30",
        fieldAvailability: { totalRevenue: "2021-06-30" },
        totalRevenue: 40,
      },
    ]);
  });

  test("keeps the original filing date for unchanged unframed quarter facts", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            units: {
              USD: [
                {
                  start: "2024-12-29",
                  end: "2025-03-29",
                  val: 95_359,
                  filed: "2026-05-01",
                  form: "10-Q",
                  fp: "Q2",
                  frame: "CY2025Q1",
                },
                {
                  start: "2024-12-29",
                  end: "2025-03-29",
                  val: 95_359,
                  filed: "2025-05-02",
                  form: "10-Q",
                  fp: "Q2",
                },
                {
                  start: "2024-09-29",
                  end: "2025-03-29",
                  val: 219_659,
                  filed: "2025-05-02",
                  form: "10-Q",
                  fp: "Q2",
                },
              ],
            },
          },
        },
      },
    };

    expect(parseCompanyFactsFinancialStatements(payload).quarterlyStatements).toEqual([{
      date: "2025-03-29",
      availableAt: "2025-05-02",
      fieldAvailability: { totalRevenue: "2025-05-02" },
      totalRevenue: 95_359,
    }]);
  });

  test("uses the later filing when a quarter value is actually restated", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            units: {
              USD: [
                {
                  start: "2024-12-29",
                  end: "2025-03-29",
                  val: 95_000,
                  filed: "2025-05-02",
                  form: "10-Q",
                  fp: "Q2",
                },
                {
                  start: "2024-12-29",
                  end: "2025-03-29",
                  val: 95_359,
                  filed: "2025-06-01",
                  form: "10-Q/A",
                  fp: "Q2",
                },
              ],
            },
          },
        },
      },
    };

    expect(parseCompanyFactsFinancialStatements(payload).quarterlyStatements[0]).toMatchObject({
      date: "2025-03-29",
      availableAt: "2025-06-01",
      totalRevenue: 95_359,
    });
  });

  test("retains the latest disclosure when a restated value returns to its original value", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            units: {
              USD: [
                {
                  start: "2024-12-29",
                  end: "2025-03-29",
                  val: 95_000,
                  filed: "2025-07-01",
                  form: "10-Q/A",
                  fp: "Q2",
                },
                {
                  start: "2024-12-29",
                  end: "2025-03-29",
                  val: 96_000,
                  filed: "2025-06-01",
                  form: "10-Q/A",
                  fp: "Q2",
                },
                {
                  start: "2024-12-29",
                  end: "2025-03-29",
                  val: 95_000,
                  filed: "2025-05-02",
                  form: "10-Q",
                  fp: "Q2",
                },
              ],
            },
          },
        },
      },
    };

    expect(parseCompanyFactsFinancialStatements(payload).quarterlyStatements[0]).toMatchObject({
      date: "2025-03-29",
      availableAt: "2025-07-01",
      fieldAvailability: { totalRevenue: "2025-07-01" },
      totalRevenue: 95_000,
    });
  });

  test("merges statement values from all configured tags for a field", () => {
    const fact = (tag: string, unit: string, rows: unknown[]) => ({
      [tag]: {
        units: {
          [unit]: rows,
        },
      },
    });
    const quarterly = (end: string, val: number, frame: string) => ({
      start: `${end.slice(0, 4)}-01-01`,
      end,
      val,
      filed: end,
      form: "10-Q",
      fp: "Q1",
      frame,
    });

    const statements = parseCompanyFactsFinancialStatements({
      facts: {
        "us-gaap": {
          ...fact("RevenueFromContractWithCustomerExcludingAssessedTax", "USD", [
            quarterly("2026-03-31", 200, "CY2026Q1"),
          ]),
          ...fact("Revenues", "USD", [
            quarterly("2025-03-31", 100, "CY2025Q1"),
          ]),
          ...fact("GrossProfit", "USD", [
            quarterly("2025-03-31", 60, "CY2025Q1"),
            quarterly("2026-03-31", 120, "CY2026Q1"),
          ]),
        },
      },
    });

    expect(statements.quarterlyStatements).toEqual([
      {
        date: "2025-03-31",
        availableAt: "2025-03-31",
        fieldAvailability: { totalRevenue: "2025-03-31", grossProfit: "2025-03-31" },
        totalRevenue: 100,
        grossProfit: 60,
      },
      {
        date: "2026-03-31",
        availableAt: "2026-03-31",
        fieldAvailability: { totalRevenue: "2026-03-31", grossProfit: "2026-03-31" },
        totalRevenue: 200,
        grossProfit: 120,
      },
    ]);
  });

  test("keeps field-level filing dates for point-in-time calculations", () => {
    const statements = parseCompanyFactsFinancialStatements({
      facts: {
        "us-gaap": {
          Revenues: {
            units: {
              USD: [{
                start: "2025-01-01",
                end: "2025-12-31",
                val: 120,
                filed: "2026-02-10",
                form: "10-K",
                fp: "FY",
              }],
            },
          },
          GrossProfit: {
            units: {
              USD: [{
                start: "2025-01-01",
                end: "2025-12-31",
                val: 72,
                filed: "2026-02-12",
                form: "10-K",
                fp: "FY",
              }],
            },
          },
        },
      },
    });

    expect(statements.annualStatements[0]?.availableAt).toBe("2026-02-12");
    expect(statements.annualStatements[0]?.fieldAvailability).toEqual({
      totalRevenue: "2026-02-10",
      grossProfit: "2026-02-12",
    });
  });
});

describe("SecEdgarClient", () => {
  test("extracts readable text from filing html", () => {
    const content = extractFilingContent(`
      <html>
        <body>
          <h1>FORM 8-K</h1>
          <p>Item 2.02 Results of Operations and Financial Condition.</p>
          <p>Revenue increased 12% year over year.</p>
        </body>
      </html>
    `, "text/html");

    expect(content).toContain("FORM 8-K");
    expect(content).toContain("Revenue increased 12% year over year.");
  });

  test("trims SEC document wrapper metadata before exhibit content", () => {
    const content = extractFilingContent(`
      <SEC-DOCUMENT>
      <DOCUMENT>
      <TYPE>EX-99.1
      <SEQUENCE>2
      <FILENAME>q42026er-991.htm
      <DESCRIPTION>EX-99.1
      <TEXT>
        <html><body>
          <p>Exhibit 99.1</p>
          <h1>e.l.f. Beauty Announces Fourth Quarter Fiscal 2026 Results</h1>
          <p>Delivered fiscal 2026 net sales growth of 25% year over year.</p>
        </body></html>
      </TEXT>
      </DOCUMENT>
      </SEC-DOCUMENT>
    `, "text/html", { form: "EX-99.1" });

    expect(content?.startsWith("Exhibit 99.1")).toBe(true);
    expect(content).toContain("Fourth Quarter Fiscal 2026 Results");
    expect(content).not.toContain("q42026er-991.htm");
  });

  test("drops hidden inline xbrl boilerplate from filing html", () => {
    const content = extractFilingContent(`
      <?xml version="1.0"?>
      <html>
        <body>
          <h5><a href="#toc">Table of Contents</a></h5>
          <div style="display: none">
            <ix:header>
              <ix:hidden>
                <ix:nonNumeric name="dei:DocumentType">DEF 14A</ix:nonNumeric>
                <ix:nonNumeric name="dei:AmendmentFlag">false</ix:nonNumeric>
              </ix:hidden>
              <ix:resources>
                <xbrli:context id="P1">ecd:ChngInFrValOfOutsdngAndUnvstdEqtyAwrdsGrntdInPrrYrsMember ecd:PeoMember</xbrli:context>
              </ix:resources>
            </ix:header>
          </div>
          <div>
            <div>UNITED STATES</div>
            <div>SECURITIES AND EXCHANGE COMMISSION</div>
            <div>SCHEDULE 14A</div>
            <p>Definitive Proxy Statement</p>
          </div>
        </body>
      </html>
    `, "text/html", { form: "DEF 14A" });

    expect(content).toContain("UNITED STATES");
    expect(content).toContain("SCHEDULE 14A");
    expect(content).not.toContain("ecd:ChngInFrValOfOutsdngAndUnvstdEqtyAwrdsGrntdInPrrYrsMember");
    expect(content).not.toContain("false");
  });

  test("returns a clean fallback message for pdf filings", () => {
    const content = extractFilingContent("%PDF-1.6\u0000\u0000\u0000", "application/pdf", {
      sourceUrl: "https://www.sec.gov/Archives/edgar/data/2488/example.pdf",
    });

    expect(content).toContain("document is a PDF");
    expect(content).not.toContain("%PDF-1.6");
  });

  test("summarizes ownership xml filings cleanly", () => {
    const content = extractFilingContent(`
      <?xml version="1.0"?>
      <ownershipDocument>
        <issuer>
          <issuerName>Realty Income Corp</issuerName>
          <issuerTradingSymbol>O</issuerTradingSymbol>
        </issuer>
        <periodOfReport>2026-03-12</periodOfReport>
        <reportingOwner>
          <reportingOwnerId>
            <rptOwnerName>Jane Doe</rptOwnerName>
          </reportingOwnerId>
        </reportingOwner>
        <nonDerivativeTable>
          <nonDerivativeTransaction>
            <securityTitle><value>Common Stock</value></securityTitle>
            <transactionDate><value>2026-03-12</value></transactionDate>
            <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
            <transactionAmounts>
              <transactionShares><value>16228</value></transactionShares>
              <transactionPricePerShare><value>197.42</value></transactionPricePerShare>
              <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
            </transactionAmounts>
            <postTransactionAmounts>
              <sharesOwnedFollowingTransaction><value>3214778</value></sharesOwnedFollowingTransaction>
            </postTransactionAmounts>
            <ownershipNature>
              <directOrIndirectOwnership><value>D</value></directOrIndirectOwnership>
            </ownershipNature>
          </nonDerivativeTransaction>
        </nonDerivativeTable>
      </ownershipDocument>
    `, "text/xml", { form: "4" });

    expect(content).toContain("Form 4 | Realty Income Corp | O");
    expect(content).toContain("Owner Jane Doe");
    expect(content).toContain("Common Stock | 2026-03-12 | Code S | 16228 shares D | @ 197.42 | Owned 3214778 | Ownership Direct");
  });

  test("loads a company's recent filings by ticker", async () => {
    let callCount = 0;
    const headersSeen: Array<Record<string, string>> = [];
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      callCount += 1;
      const url = String(input);
      headersSeen.push((init?.headers ?? {}) as Record<string, string>);
      if (url.includes("company_tickers_exchange.json")) {
        return new Response(JSON.stringify({
          fields: ["cik", "name", "ticker", "exchange"],
          data: [[320193, "Apple Inc.", "AAPL", "Nasdaq"]],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        cik: "0000320193",
        name: "Apple Inc.",
        filings: {
          recent: {
            accessionNumber: ["0000320193-24-000123"],
            form: ["10-Q"],
            filingDate: ["2024-08-02"],
            acceptanceDateTime: ["20240802120000"],
            primaryDocument: ["aapl-10q.htm"],
            primaryDocDescription: ["Quarterly report"],
            items: [""],
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new SecEdgarClient();
    const filings = await client.getRecentFilings("AAPL", 1);

    expect(callCount).toBe(2);
    expect(filings).toHaveLength(1);
    expect(filings[0]?.form).toBe("10-Q");
    expect(headersSeen[0]?.["User-Agent"]).toBeTruthy();
    expect(headersSeen[0]?.From).toBeTruthy();
  });

  test("loads older EDGAR submission archives when recent filings run out", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("company_tickers_exchange.json")) {
        return new Response(JSON.stringify({
          fields: ["cik", "name", "ticker", "exchange"],
          data: [[320193, "Apple Inc.", "AAPL", "Nasdaq"]],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("CIK0000320193.json")) {
        return new Response(JSON.stringify({
          cik: "0000320193",
          name: "Apple Inc.",
          filings: {
            recent: {
              accessionNumber: ["0000320193-24-000123"],
              form: ["8-K"],
              filingDate: ["2024-08-02"],
              acceptanceDateTime: ["20240802120000"],
              primaryDocument: ["aapl-8k.htm"],
              primaryDocDescription: ["Current report"],
              items: [""],
            },
            files: [{ name: "CIK0000320193-submissions-001.json" }],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        accessionNumber: ["0000320193-18-000001"],
        form: ["4"],
        filingDate: ["2018-01-02"],
        acceptanceDateTime: ["20180102120000"],
        primaryDocument: ["xslF345X03/wk-form4.xml"],
        primaryDocDescription: ["Form 4"],
        items: [""],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const client = new SecEdgarClient();
    const filings = await client.getRecentFilings("AAPL", 2);
    expect(urls.some((url) => url.endsWith("CIK0000320193-submissions-001.json"))).toBe(true);
    expect(filings.map((filing) => filing.form)).toEqual(["8-K", "4"]);
    expect(filings[1]?.accessionNumber).toBe("0000320193-18-000001");
  });

  test("surfaces SEC bot blocking errors clearly", async () => {
    globalThis.fetch = (async () => new Response(
      "<html><body>Undeclared Automated Tool</body></html>",
      {
        status: 200,
        headers: { "content-type": "text/html" },
      },
    )) as unknown as typeof fetch;

    const client = new SecEdgarClient();

    await expect(client.getRecentFilings("AAPL", 1)).rejects.toThrow("SEC blocked the request");
  });

  test("loads filing body content", async () => {
    globalThis.fetch = (async (input: Request | string | URL) => new Response(
      String(input).includes("primary-doc")
        ? "<html><body><h1>Quarterly Report</h1><p>Net sales increased.</p></body></html>"
        : JSON.stringify({
            fields: ["cik", "name", "ticker", "exchange"],
            data: [[320193, "Apple Inc.", "AAPL", "Nasdaq"]],
          }),
      {
        status: 200,
        headers: {
          "content-type": String(input).includes("primary-doc") ? "text/html" : "application/json",
        },
      },
    )) as unknown as typeof fetch;

    const client = new SecEdgarClient();
    const content = await client.getFilingContent({
      form: "10-Q",
      filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/index.htm",
      primaryDocumentUrl: "https://www.sec.gov/Archives/edgar/data/320193/primary-doc.htm",
    });

    expect(content).toContain("Quarterly Report");
    expect(content).toContain("Net sales increased.");
  });

  test("falls back from a pdf primary document to an alternate html document", async () => {
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = String(input);
      if (url.includes("-index.htm")) {
        return new Response(`
          <html>
            <body>
              <a href="/Archives/edgar/data/2488/example.pdf">example.pdf</a>
              <a href="/Archives/edgar/data/2488/example.htm">example.htm</a>
            </body>
          </html>
        `, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }

      return new Response("<html><body><h1>Proxy Statement</h1><p>Annual meeting details.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const client = new SecEdgarClient();
    const content = await client.getFilingContent({
      filingUrl: "https://www.sec.gov/Archives/edgar/data/2488/0000000000-26-000001-index.htm",
      primaryDocumentUrl: "https://www.sec.gov/Archives/edgar/data/2488/example.pdf",
      form: "DEF 14A",
    });

    expect(content).toContain("Proxy Statement");
    expect(content).toContain("Annual meeting details.");
  });

  test("loads filing documents from the filing index", async () => {
    globalThis.fetch = (async () => new Response(`
      <html>
        <body>
          <table class="tableFile">
            <tr><td>1</td><td>Current report</td><td><a href="/Archives/edgar/data/320193/000032019324000123/aapl-8k.htm">aapl-8k.htm</a></td><td>8-K</td><td>10000</td></tr>
            <tr><td>2</td><td>Investor presentation</td><td><a href="/Archives/edgar/data/320193/000032019324000123/aapl-ex992.pdf">aapl-ex992.pdf</a></td><td>EX-99.2</td><td>90000</td></tr>
          </table>
        </body>
      </html>
    `, {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;

    const client = new SecEdgarClient();
    const documents = await client.getFilingDocuments({
      accessionNumber: "0000320193-24-000123",
      form: "8-K",
      filingDate: new Date("2024-08-01T00:00:00Z"),
      cik: "0000320193",
      filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/0000320193-24-000123-index.htm",
      primaryDocument: "aapl-8k.htm",
    });

    expect(documents.map((document) => document.type)).toEqual(["8-K", "EX-99.2"]);
    expect(documents[1]?.description).toBe("Investor presentation");
  });
});
