import { describe, expect, test } from "bun:test";
import type { CloudSearchHit } from "../../../api-client";
import { hitDocumentKey, presentSearchHit } from "./model";

function hit(overrides: Partial<CloudSearchHit>): CloudSearchHit {
  return {
    id: "hit",
    docType: "filing",
    sourceId: "0000320193-26-000001",
    chunkIndex: 0,
    ticker: "AAPL",
    publishedAt: "2026-05-02T21:00:00.000Z",
    title: "Apple Inc. 10-Q",
    url: "https://example.com/filing",
    snippet: "gross margin",
    score: 1,
    metadata: {},
    ...overrides,
  };
}

// Later pages are deduped on this key, so it has to name the document rather
// than whichever chunk of it scored best on that page.
describe("hitDocumentKey", () => {
  test("a document is the same row under a different chunk", () => {
    expect(hitDocumentKey(hit({ id: "chunk-9", chunkIndex: 9 })))
      .toBe(hitDocumentKey(hit({ id: "chunk-4", chunkIndex: 4 })));
    expect(hitDocumentKey(hit({ id: "other", sourceId: "0000320193-26-000002" })))
      .not.toBe(hitDocumentKey(hit({ id: "chunk-4", chunkIndex: 4 })));
  });

  test("documents of different types that share a source id stay apart", () => {
    expect(hitDocumentKey(hit({ docType: "news", sourceId: "shared" })))
      .not.toBe(hitDocumentKey(hit({ docType: "filing", sourceId: "shared" })));
  });
});

describe("presentSearchHit", () => {
  test("dates a filing by the day EDGAR gave it, in every time zone, and names it by its filer", () => {
    // NXT's 10-Q, accepted Friday Oct 30 at 19:40 ET and filed Monday Nov 2.
    const filing = hit({
      publishedAt: "2026-10-30T23:40:13.000Z",
      title: "Nextpower Inc. 10-Q 2026-11-02",
      metadata: { form: "10-Q", filingDate: "2026-11-02", company: "Nextpower Inc." },
    });
    for (const timezone of ["America/Los_Angeles", "Europe/Berlin", "Pacific/Auckland"]) {
      const result = Bun.spawnSync([process.execPath, "--eval", `
        import { formatHitDate, formatHitDateShort, presentSearchHit } from ${JSON.stringify(new URL("./model.ts", import.meta.url).href)};
        const hit = presentSearchHit(${JSON.stringify(filing)});
        console.log(JSON.stringify([hit.title, formatHitDate(hit.publishedAt), formatHitDateShort(hit.publishedAt, Date.parse("2026-11-05T08:00:00Z"))]));
      `], { env: { ...process.env, TZ: timezone } });
      expect(JSON.parse(result.stdout.toString())).toEqual(["Nextpower Inc.", "Nov 02, 2026", "Nov 2"]);
    }
  });

  test("drops the ticker and date a call's title repeats, and leaves a hit without filing metadata as it came", () => {
    expect(presentSearchHit(hit({ docType: "transcript", ticker: "WHD", title: "WHD Q3 FY2026 Earnings Call" })).title).toBe("Q3 FY2026 Earnings Call");
    expect(presentSearchHit(hit({ docType: "transcript", ticker: "WHD", title: "WHD Investor Day 2026-10-14" })).title).toBe("Investor Day");
    const legacy = hit({ title: "8-K - QuidelOrtho Corp (0001906324) (Filer)" });
    expect(presentSearchHit(legacy)).toEqual(legacy);
  });
});
