import { describe, expect, test } from "bun:test";
import type { CloudNewsPayload } from "../../../../../api-client";
import type { NewsInsiderFiling, NewsStoryItem } from "../../../../../news/types";
import { mapCloudNewsArticle } from "../../../../../sources/gloomberb-cloud/news";
import { groupInsiderFilings, insiderFilingSummary, insiderGroupTotal, rankStoryCoverage, tradeDaySpan } from "./story-evidence";

// The 7 Oct 2026 story on Q3 insider sales, its three outlets and the Form 4s its first insider filed.
const story = {
  title: "Q3 2026 insider stock sales: Nvidia's Mark Stevens tops AI sellers",
  summary: "Nvidia director Mark Stevens sold nearly $947 million of Nvidia shares in the third quarter, topping a list of insider sellers that also included Amazon founder Jeff Bezos and Arista Networks CEO Jayshree Ullal.",
};

const item = (id: string, sourceName: string, publishedAt: string, title: string, summary = ""): NewsStoryItem => ({
  id, sourceKey: id, sourceName, title, summary, url: `https://example.com/${id}`, publishedAt: new Date(publishedAt),
});

const coverage = [
  item("quartz", "Quartz", "2026-10-07T13:35:00Z", story.title),
  item("fp", "Financial Post", "2026-10-07T13:50:00Z",
    "Nvidia director and multibillionaire among the top-10 insider stock sellers in the third quarter",
    "Nvidia director Mark Stevens topped third-quarter insider stock sellers, while Arista Networks CEO Jayshree Ullal and Amazon founder Jeff Bezos were also among major AI-linked sellers."),
  // The newest, and about a sector's insider ratio, not the story's sellers.
  item("kobeissi", "@KobeissiLetter", "2026-10-07T16:25:00Z",
    "Executives in the Financials sector are turning cautious: The unique seller/buyer ratio for Financials stood at 2.10x above its long-term average in Q3 2026",
    "Financial-sector executives showed elevated insider selling relative to buying in Q3 2026, with insider purchases at their lowest level in nearly 23 years."),
];

const filing = (accession: string, overrides: Partial<NewsInsiderFiling>): NewsInsiderFiling => ({
  accession, form: "4", filedOn: "2026-09-22", issuerName: "NVIDIA CORP", ticker: "NVDA", insider: "STEVENS MARK A",
  title: "Director", side: "sale", firstTradeDate: "2026-09-18", lastTradeDate: "2026-09-18", lines: 1, shares: 1, value: 1,
  weightedPrice: 1, rule10b51: false, url: `https://www.sec.gov/${accession}`, ...overrides,
});

const stevens = [
  filing("0001199039-26-000012", { filedOn: "2026-09-02", firstTradeDate: "2026-08-31", lastTradeDate: "2026-09-02", lines: 7, shares: 1_848_501, value: 410_843_670.67, weightedPrice: 222.2577 }),
  filing("0001199039-26-000014", { filedOn: "2026-09-08", firstTradeDate: "2026-09-03", lastTradeDate: "2026-09-04", lines: 7, shares: 1_022_239, value: 235_636_867.41, weightedPrice: 230.5105 }),
  filing("0001199039-26-000016", { lines: 2, shares: 1_366_000, value: 300_147_095.4, weightedPrice: 219.72701 }),
];

describe("a story's own page", () => {
  test("coverage leads with the outlets that tell the story, a wider post after them however recent", () => {
    // The Financial Post names every seller the story does; Quartz carries its headline alone.
    expect(rankStoryCoverage(coverage, story).map((entry) => entry.id)).toEqual(["fp", "quartz", "kobeissi"]);
    // Among equals, the newest first.
    const twins = [item("a", "A", "2026-10-07T10:00:00Z", story.title), item("b", "B", "2026-10-07T11:00:00Z", story.title)];
    expect(rankStoryCoverage(twins, story).map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  test("an insider's filings add up to the total a story's headline number is checked against", () => {
    const [group, ...others] = groupInsiderFilings(stevens);
    expect(others).toEqual([]);
    expect(group).toMatchObject({ name: "Mark A. Stevens", ticker: "NVDA", lines: 16, shares: 4_236_740 });
    expect(insiderGroupTotal(group!)).toBe("Sold 4,236,740 shares for $946,627,633.48 in 3 Form 4s, traded 31 Aug–18 Sep 2026");
    expect(insiderFilingSummary(stevens[2]!)).toBe("Sold 1,366,000 shares at avg $219.727, traded 18 Sep 2026, 2 lines, no 10b5-1 plan");
    expect(insiderFilingSummary({ ...stevens[1]!, rule10b51: null })).toBe("Sold 1,022,239 shares at avg $230.5105, traded 3–4 Sep 2026, 7 lines, 10b5-1 not stated");
    expect(tradeDaySpan("2025-12-30", "2026-01-02")).toBe("30 Dec 2025–2 Jan 2026");
  });

  test("a filing the service sends incomplete is left out, never shown with a gap", () => {
    const payload = {
      id: "3224efb6-4d68-4526-8ab2-455771f8898a", headline: story.title, summary: story.summary, category: "filing", sentiment: "neutral",
      sectors: [], firstPublishedAt: "2026-10-07T13:35:57.000Z", lastPublishedAt: "2026-10-07T16:25:00.000Z",
      firstSeenAt: "2026-10-07T13:36:00.000Z", lastSeenAt: "2026-10-07T16:26:00.000Z", primaryUrl: "https://example.com/q3",
      primarySource: "quartz", variantCount: 1, sourceCount: 3, sources: [], entities: [], tickerLinks: [],
      insiderFilings: [
        { ...stevens[2]!, issuerCik: "1045810", url: "https://www.sec.gov/Archives/edgar/data/1045810/000119903926000016/0001199039-26-000016-index.htm" },
        { ...stevens[1]!, issuerCik: "1045810", shares: 0 },
        { ...stevens[0]!, issuerCik: "1045810", accession: "not-an-accession" },
      ],
    } as unknown as CloudNewsPayload;
    const article = mapCloudNewsArticle(payload);
    expect(article.insiderFilings?.map((entry) => entry.accession)).toEqual(["0001199039-26-000016"]);
    // A story from a server that matches none has none.
    expect(mapCloudNewsArticle({ ...payload, insiderFilings: undefined }).insiderFilings).toBeUndefined();
  });
});
