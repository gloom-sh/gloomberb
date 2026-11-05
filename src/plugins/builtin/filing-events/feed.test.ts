import { describe, expect, test } from "bun:test";
import type { CloudFilingEventPayload } from "../../../api-client";
import { buildFilingEventsFeed, resolveFeedScrollTop } from "./feed";

function filingEvent(overrides: Partial<CloudFilingEventPayload> = {}): CloudFilingEventPayload {
  return {
    id: "id",
    ticker: "ACME",
    company: { ticker: "ACME", cik: "1", name: "Acme Inc.", shortName: "Acme" },
    filedAt: "2026-04-02T00:00:00.000Z",
    docUrl: "https://sec.gov/acme.htm",
    items: ["2.02", "9.01"],
    labels: ["Results of operations", "Exhibits"],
    kinds: ["results"],
    material: false,
    headline: null,
    summary: null,
    people: [],
    read: false,
    ...overrides,
  };
}

describe("buildFilingEventsFeed", () => {
  test("keeps filing and personnel calendar days in every time zone, a legacy instant read by its UTC day", () => {
    const event = filingEvent({
      filedAt: "2026-09-01T01:30:00Z",
      read: true,
      headline: "Officer appointment",
      people: [{ name: "Officer", role: "CEO", action: "joined", effective: "2026-09-01" }],
    });
    const events = [
      { ...event, filingDate: "2026-09-01" },
      event,
      { ...event, filingDate: "2026-02-29" },
    ];
    for (const timezone of ["America/Los_Angeles", "Europe/Berlin", "Pacific/Auckland"]) {
      const result = Bun.spawnSync([process.execPath, "--eval", `
        import { buildFilingEventsFeed } from ${JSON.stringify(new URL("./feed.ts", import.meta.url).href)};
        console.log(JSON.stringify(buildFilingEventsFeed(${JSON.stringify(events)}, 80)));
      `], { env: { ...process.env, TZ: timezone } });
      expect(result.exitCode).toBe(0);
      const feed = JSON.parse(result.stdout.toString());
      expect(feed.entries.map((entry: { filedLabel: string }) => entry.filedLabel)).toEqual(["Sep 01, 2026", "Sep 01, 2026", "Sep 01, 2026"]);
      expect(feed.entries[0].people[0].detail).toBe("CEO, joined, effective Sep 01, 2026");
    }
  });

  test("validates source calendar dates without normalizing an invalid day into another month", () => {
    const feed = buildFilingEventsFeed([filingEvent({
      read: true, headline: "Appointment", filingDate: "2024-02-29",
      people: [
        { name: "Valid", role: "CEO", action: "joined", effective: "2024-02-29" },
        { name: "Invalid", role: "CFO", action: "joined", effective: "2026-02-29" },
      ],
    })], 80);
    expect(feed.entries[0]?.filedLabel).toBe("Feb 29, 2024");
    expect(feed.entries[0]?.people.map((person) => person.detail)).toEqual([
      "CEO, joined, effective Feb 29, 2024", "CFO, joined, effective —",
    ]);
  });

  test("names each person once: a move between roles, roles taken together, and a shared date said once", () => {
    const people = (feed: ReturnType<typeof buildFilingEventsFeed>) =>
      feed.entries[0]!.people.map((person) => `${person.name}: ${person.detail}`);
    const effective = "2026-09-01";
    // Apple's April 2026 8-K, as the model reads it: a role per line, Tim Cook twice.
    expect(people(buildFilingEventsFeed([filingEvent({
      read: true, headline: "CEO transition",
      people: [
        { name: "Tim Cook", role: "Chief Executive Officer", action: "left", effective },
        { name: "Tim Cook", role: "Executive Chair", action: "joined", effective },
        { name: "John Ternus", role: "Chief Executive Officer", action: "joined", effective },
        { name: "John Ternus", role: "Member of the Board", action: "appointed director", effective },
        { name: "Art Levinson", role: "Chair of the Board", action: "left", effective: null },
        { name: "Art Levinson", role: "Lead Independent Director", action: "joined", effective },
      ],
    })], 120))).toEqual([
      "Tim Cook: Chief Executive Officer → Executive Chair, effective Sep 01, 2026",
      "John Ternus: Chief Executive Officer, joined; Member of the Board, appointed director, effective Sep 01, 2026",
      "Art Levinson: Chair of the Board → Lead Independent Director, effective Sep 01, 2026",
    ]);
  });

  test("puts what a model read first and leaves the rest below", () => {
    const feed = buildFilingEventsFeed([
      filingEvent({ id: "routine", filedAt: "2026-07-22T00:00:00.000Z" }),
      filingEvent({
        id: "news",
        filedAt: "2026-06-05T00:00:00.000Z",
        labels: ["Executive or director change"],
        material: true,
        read: true,
        headline: "Chief financial officer steps down",
        summary: "Departure effective June 30, 2026.",
      }),
    ], 60);

    expect(feed.sections.map((section) => section.id)).toEqual(["news", "also"]);
    expect(feed.entries.map((entry) => entry.id)).toEqual(["news", "routine"]);
  });

  test("keeps the exhibits label only when the filing has no other", () => {
    const feed = buildFilingEventsFeed([
      filingEvent({ id: "results" }),
      filingEvent({ id: "exhibits-only", labels: ["Exhibits"] }),
      filingEvent({ id: "unclassified", items: [], labels: [] }),
    ], 60);

    expect(feed.entries.map((entry) => entry.itemsLabel)).toEqual([
      "Results of operations",
      "Exhibits",
      "No item listed",
    ]);
  });

  test("measures an entry from the lines its read actually takes", () => {
    const headingLines = 2;
    const feed = buildFilingEventsFeed([
      filingEvent({
        id: "news",
        read: true,
        headline: "A headline long enough to wrap onto a second line",
        summary: "One point.\nAnother point.",
        people: [{ name: "Ada Lovelace", role: "Chair", action: "joined", effective: null }],
      }),
      filingEvent({ id: "routine" }),
    ], 40);

    const news = feed.entries[0]!;
    // A blank row and the filed row, two headline lines, a line per point, and
    // a line for the person. The first heading starts the feed without a blank row.
    expect(news.top).toBe(headingLines - 1);
    expect(news.lines).toBe(2 + 2 + 2 + 1);

    // The second section pays for its own heading; its filings are rows of a table, with no blank row between them.
    expect(feed.entries[1]!.top).toBe(news.top + news.lines + headingLines);
    expect(feed.entries[1]!.lines).toBe(1);
  });
});

describe("resolveFeedScrollTop", () => {
  const entry = { top: 20, lines: 6 } as Parameters<typeof resolveFeedScrollTop>[0]["entry"];

  test("leaves an entry already in view alone", () => {
    expect(resolveFeedScrollTop({ entry, scrollTop: 18, viewportHeight: 20 })).toBe(18);
  });

  test("scrolls up to an entry above the viewport", () => {
    expect(resolveFeedScrollTop({ entry, scrollTop: 30, viewportHeight: 20 })).toBe(20);
  });

  test("scrolls down just far enough to finish an entry below the viewport", () => {
    expect(resolveFeedScrollTop({ entry, scrollTop: 0, viewportHeight: 10 })).toBe(16);
  });

  test("pins an entry taller than the viewport to its own top", () => {
    const tall = { top: 20, lines: 40 } as typeof entry;
    expect(resolveFeedScrollTop({ entry: tall, scrollTop: 0, viewportHeight: 10 })).toBe(20);
  });
});
