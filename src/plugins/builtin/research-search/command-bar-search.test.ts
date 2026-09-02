import { describe, expect, test } from "bun:test";
import type { CloudSearchHit } from "../../../api-client";
import { hitResultDef } from "./command-bar-search";
import { formatHitDateShort } from "./model";

const NOW = new Date("2026-09-01T12:00:00").getTime();

function hit(overrides: Partial<CloudSearchHit>): CloudSearchHit {
  return {
    id: "hit-1",
    docType: "news",
    sourceId: "doc-1",
    chunkIndex: 0,
    ticker: "NVDA",
    publishedAt: "2026-08-30T09:00:00",
    title: "Nvidia guides above estimates",
    url: "https://example.com",
    snippet: "record <mark>margin</mark> again",
    score: 1,
    metadata: { source: "Reuters" },
    ...overrides,
  };
}

describe("formatHitDateShort", () => {
  /**
   * Three formats hinge on two boundaries, a day and a year, and the column
   * is too narrow to tell a mistake from a design choice.
   */
  test("switches from age to day to month at the day and year boundaries", () => {
    const at = (iso: string) => formatHitDateShort(iso, NOW);
    expect(at("2026-09-01T11:59:30")).toBe("1m");
    expect(at("2026-09-01T08:45:00")).toBe("3h");
    expect(at("2026-08-31T12:00:01")).toBe("23h");
    expect(at("2026-08-31T12:00:00")).toBe("Aug 31");
    expect(at("2026-01-01T00:00:00")).toBe("Jan 1");
    expect(at("2025-12-31T23:59:59")).toBe("Dec 2025");
    // A clock ahead of ours is not "in -2h".
    expect(at("2026-09-01T14:00:00")).toBe("Sep 1");
    expect(at("not a date")).toBe("");
    expect(at(undefined)).toBe("");
  });
});

describe("document hit rows", () => {
  test("put the date on the right and the source and ticker ahead of the snippet", () => {
    const row = hitResultDef(hit({}), () => {}, NOW);
    expect(row.badge).toBe("NEWS");
    expect(row.right).toBe("Aug 30");
    expect(row.lines).toEqual([{
      segments: [
        { text: "Reuters · NVDA · ", emphasis: "muted" },
        { text: "record ", emphasis: undefined },
        { text: "margin", emphasis: "match" },
        { text: " again", emphasis: undefined },
      ],
    }]);
  });

  test("lead with the speaker for a call and the section for a filing, whose form is the badge", () => {
    const call = hitResultDef(hit({
      docType: "transcript",
      metadata: { speaker: "Colette Kress", role: "CFO" },
    }), () => {}, NOW);
    expect(call.badge).toBe("CALL");
    expect(call.lines?.[0]?.segments[0]?.text).toBe("Colette Kress, CFO · NVDA · ");

    const filing = hitResultDef(hit({
      docType: "filing",
      metadata: { form: "10-K", section: "Item 1A" },
    }), () => {}, NOW);
    expect(filing.badge).toBe("10-K");
    expect(filing.lines?.[0]?.segments[0]?.text).toBe("Item 1A · NVDA · ");

    const bare = hitResultDef(hit({ metadata: {} }), () => {}, NOW);
    expect(bare.lines?.[0]?.segments[0]?.text).toBe("NVDA · ");

    // The News section is all one kind, so a badge there would only repeat the heading.
    expect(hitResultDef(hit({}), () => {}, NOW, { badge: false }).badge).toBeUndefined();
  });
});
