import { describe, expect, test } from "bun:test";
import type { SecFilingItem } from "../../../types/data-provider";
import {
  buildLetterSearchUrl,
  createCommentLettersLoader,
  letterMarkup,
  letterPlainText,
  letterTopics,
  parseFilerName,
  parseLetterSearchPage,
  parseTickerMatch,
  tickerCandidate,
  type IssuerFilingsLoader,
} from "./client";
import type { CommentLetterIssuer, CommentLetterPage } from "./types";

const hit = (id: string, form: string, displayName: string, fileDate: string) => ({
  _id: id,
  _source: { adsh: id.split(":")[0], form, root_forms: [form], file_date: fileDate, ciks: ["0001130713"], display_names: [displayName] },
});

const page = (hits: unknown[], total: { value: number; relation: string }) => ({ hits: { total, hits } });

const signal = new AbortController().signal;

describe("comment letter search results", () => {
  test("keeps one row per filing, says who wrote it, and parses the filer", () => {
    const parsed = parseLetterSearchPage(page([
      hit("0001140361-26-032956:filename1.htm", "CORRESP", "BED BATH & BEYOND, INC.  (NXH, BBBYW)  (CIK 0001130713)", "2026-08-14"),
      hit("0001140361-26-032956:filename2.htm", "CORRESP", "BED BATH & BEYOND, INC.  (NXH, BBBYW)  (CIK 0001130713)", "2026-08-14"),
      hit("0000000000-26-007882:filename1.pdf", "UPLOAD", "KKR FS Income Trust  (CIK 0001930679)", "2026-08-11"),
      hit("0000320193-26-000124:aapl-10k.htm", "10-K", "Apple Inc.  (AAPL)  (CIK 0000320193)", "2026-05-13"),
    ], { value: 4, relation: "eq" }), 0);
    expect(parsed.rows.map((row) => [row.accessionNumber, row.author])).toEqual([
      ["0001140361-26-032956", "company"],
      ["0000000000-26-007882", "staff"],
    ]);
    expect(parsed.rows[0]).toMatchObject({
      companyName: "BED BATH & BEYOND, INC.",
      tickers: ["NXH", "BBBYW"],
      cik: "0001130713",
      filingUrl: "https://www.sec.gov/Archives/edgar/data/1130713/0001140361-26-032956-index.htm",
      primaryDocumentUrl: "https://www.sec.gov/Archives/edgar/data/1130713/000114036126032956/filename1.htm",
    });
    expect(parsed.hasMore).toBe(false);
  });

  test("names without tickers or with their own parentheses stay names", () => {
    expect(parseFilerName("KKR FS Income Trust  (CIK 0001930679)")).toEqual({ companyName: "KKR FS Income Trust", tickers: [] });
    expect(parseFilerName("Acme (Holdings) Ltd  (CIK 0000000001)")).toEqual({ companyName: "Acme (Holdings) Ltd", tickers: [] });
    expect(parseFilerName("Apple Inc.  (AAPL)  (CIK 0000320193)")).toEqual({ companyName: "Apple Inc.", tickers: ["AAPL"] });
  });

  test("pages by the hits returned, and stops at the search's 10,000-hit window", () => {
    const hundred = Array.from({ length: 100 }, (_, index) =>
      hit(`0000000000-26-${String(index).padStart(6, "0")}:filename1.pdf`, "UPLOAD", "Acme Corp  (CIK 0000000001)", "2026-08-01"));
    const first = parseLetterSearchPage(page(hundred, { value: 10_000, relation: "gte" }), 0);
    expect(first).toMatchObject({ hasMore: true, nextOffset: 100, windowLimited: false });

    const last = parseLetterSearchPage(page(hundred, { value: 10_000, relation: "gte" }), 9_900);
    expect(last).toMatchObject({ hasMore: false, nextOffset: null, windowLimited: true });

    const exact = parseLetterSearchPage(page(hundred.slice(0, 40), { value: 140, relation: "eq" }), 100);
    expect(exact).toMatchObject({ hasMore: false, windowLimited: false });

    const url = new URL(buildLetterSearchUrl({ query: "revenue recognition", offset: 100 }));
    expect(url.searchParams.get("q")).toBe("revenue recognition");
    expect(url.searchParams.get("forms")).toBe("CORRESP,UPLOAD");
    expect(url.searchParams.get("from")).toBe("100");
    expect(new URL(buildLetterSearchUrl({ cik: "0000320193" })).searchParams.get("ciks")).toBe("0000320193");
  });
});

describe("a ticker as the search", () => {
  const suggestions = {
    hits: {
      hits: [
        { _id: "2055491", _source: { entity: "Permuto Capital AAPL Trust I" } },
        { _id: "320193", _source: { entity: "Apple Inc. (AAPL)", tickers: "AAPL" } },
      ],
    },
  };

  test("matches the company filed under exactly that ticker, not a name containing it", () => {
    expect(parseTickerMatch(suggestions, "AAPL")).toEqual({ cik: "0000320193", ticker: "AAPL", name: "Apple Inc." });
    expect(parseTickerMatch({ hits: { hits: [{ _id: "1067983", _source: { entity: "BERKSHIRE HATHAWAY INC (BRK-A, BRK-B)", tickers: "BRK-A, BRK-B" } }] } }, "BRK.B"))
      .toMatchObject({ cik: "0001067983", ticker: "BRK-B" });
    expect(parseTickerMatch({ hits: { hits: [suggestions.hits.hits[0]] } }, "AAPL")).toBeNull();
    expect(tickerCandidate("aapl")).toBe("AAPL");
    expect(tickerCandidate("revenue recognition")).toBeNull();
  });

  const apple: CommentLetterIssuer = { cik: "0000320193", ticker: "AAPL", name: "Apple Inc." };
  const filing = (accessionNumber: string, form: string, filingDate: Date | string): SecFilingItem => ({
    accessionNumber,
    form,
    filingDate: filingDate as Date,
    cik: "0000320193",
    companyName: "Apple Inc.",
    filingUrl: `https://www.sec.gov/Archives/edgar/data/320193/${accessionNumber}-index.htm`,
  });
  const emptyPage = (): Omit<CommentLetterPage, "issuer"> => ({ rows: [], hasMore: false, nextOffset: null, windowLimited: false });

  function fakeClient(issuer: CommentLetterIssuer | null) {
    const searches: Array<{ query?: string; cik?: string; offset?: number }> = [];
    return {
      searches,
      client: {
        resolveTicker: async () => issuer,
        searchLetters: async (options: { query?: string; cik?: string; offset?: number }) => {
          searches.push(options);
          return emptyPage();
        },
      },
    };
  }

  test("lists the company's letters from its filing list, dates restored from cache included", async () => {
    const { client, searches } = fakeClient(apple);
    const issuerFilings: IssuerFilingsLoader = async () => ({
      complete: true,
      filings: [
        filing("0000000000-24-005673", "UPLOAD", new Date("2024-05-16T00:00:00Z")),
        filing("0000320193-24-000069", "10-Q", new Date("2024-05-03T00:00:00Z")),
        filing("0000320193-24-000061", "CORRESP", "2024-04-29T00:00:00.000Z"),
      ],
    });
    const result = await createCommentLettersLoader(client, "aapl", issuerFilings)({ offset: 0, signal, force: false });
    expect(result.issuer).toEqual(apple);
    expect(result.rows.map((row) => [row.form, row.author, row.filingDate.toISOString().slice(0, 10)])).toEqual([
      ["UPLOAD", "staff", "2024-05-16"],
      ["CORRESP", "company", "2024-04-29"],
    ]);
    expect(result.hasMore).toBe(false);
    expect(searches).toEqual([]);
  });

  test("searches by CIK when the filing list is capped or unavailable, and as text when no company has the ticker", async () => {
    for (const listed of [{ complete: false, filings: [] }, null]) {
      const { client, searches } = fakeClient(apple);
      const loader = createCommentLettersLoader(client, "AAPL", async () => listed);
      await loader({ offset: 0, signal, force: false });
      await loader({ offset: 100, signal, force: false });
      expect(searches).toEqual([{ cik: "0000320193", offset: 0 }, { cik: "0000320193", offset: 100 }]);
    }

    const { client, searches } = fakeClient(null);
    const result = await createCommentLettersLoader(client, "LOW", async () => {
      throw new Error("no filing list for a word");
    })({ offset: 0, signal, force: false });
    expect(result.issuer).toBeNull();
    expect(searches).toEqual([{ query: "LOW", offset: 0 }]);
  });
});

describe("letter text", () => {
  test("drops EDGAR's envelope and keeps a paragraph wrapped in the source as one line", () => {
    const markup = letterMarkup("<DOCUMENT>\n<TYPE>CORRESP\n<SEQUENCE>1\n<FILENAME>filename1.htm\n<TEXT>\n<HTML><P>Cira\nCentre, 2929 Arch Street</P>\n<P>Dear Staff:</P></HTML>\n</TEXT>\n</DOCUMENT>");
    expect(markup).toBe("<HTML><P>Cira Centre, 2929 Arch Street</P> <P>Dear Staff:</P></HTML>");
    expect(letterMarkup("Plain text letter.\nSecond line.")).toBe("Plain text letter.\nSecond line.");
  });
});

describe("letter topics", () => {
  test("come from the letter's own words, markup and entities removed", () => {
    const text = letterPlainText(
      "<html><head><title>Restatement</title></head><body><p>Please revise your non&#8209;GAAP measures and the "
      + "<b>revenue recognition</b> policy.</p><p>Management&#8217;s going concern assessment</p></body></html>",
    );
    expect(letterTopics(text)).toEqual(["going concern", "revenue recognition", "non-GAAP"]);
    expect(letterTopics("We acknowledge the comments and will file the amendment.")).toEqual([]);
  });
});
