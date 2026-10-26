import { describe, expect, test } from "bun:test";
import type {
  CloudEarningsCallPayload,
  CloudEarningsTranscriptPayload,
} from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import {
  createEarningsCallsHeadless,
  type EarningsCallsHeadlessDependencies,
} from "./headless";
import { callPeriod, callTitle } from "./format";
import { buildTranscriptSegments, findCallForQuarter } from "./model";

const calls: CloudEarningsCallPayload[] = [
  {
    id: "amd-fq2-2026",
    ticker: "AMD",
    companyName: "Advanced Micro Devices",
    fiscalYear: 2026,
    fiscalQuarter: 2,
    callAt: "2026-07-29T21:00:00.000Z",
    status: "published",
    durationSeconds: 3_600,
    wordCount: 12_000,
    hasTranscript: true,
    sentiment: 0.2,
  },
  {
    id: "amd-fq1-2026",
    ticker: "AMD",
    companyName: "Advanced Micro Devices",
    fiscalYear: 2026,
    fiscalQuarter: 1,
    callAt: "2026-04-29T21:00:00.000Z",
    status: "discovered",
    durationSeconds: null,
    wordCount: null,
    hasTranscript: false,
    sentiment: null,
  },
];

const transcript: CloudEarningsTranscriptPayload = {
  id: "amd-fq2-2026",
  ticker: "AMD",
  companyName: "Advanced Micro Devices",
  fiscalYear: 2026,
  fiscalQuarter: 2,
  callAt: "2026-07-29T21:00:00.000Z",
  timing: "AMC",
  webcastUrl: "https://example.com/call",
  durationSeconds: 3_600,
  status: "published",
  fullText: "",
  turns: [
    {
      speaker: "Jean Hu",
      role: "Chief Financial Officer",
      company: "AMD",
      text: `Gross margin expanded. ${"Margin discipline remained strong. ".repeat(80)}`,
      isQa: false,
      startSeconds: 120,
    },
    {
      speaker: "Analyst One",
      role: "Analyst",
      company: "Research Firm",
      text: "What should investors expect from the CFO on data center margins?",
      isQa: true,
      startSeconds: 2_400,
    },
  ],
  participants: [
    { name: "Jean Hu", role: "Chief Financial Officer", company: "AMD" },
  ],
  summary: "Revenue grew while gross margin expanded.",
  guidance: "Management expects sequential growth.",
  riskFactors: "Supply remains constrained.",
  analystFocus: "Analysts focused on data center margins.",
  notable: "Management raised its annual outlook.",
  sentiment: 0.2,
  sentimentRationale: "Constructive outlook.",
  qaStartTurn: 1,
  wordCount: 12_000,
  asrModel: "test",
  updatedAt: "2026-07-30T00:00:00.000Z",
};

function callArgs(options: Record<string, string | number | boolean>): HeadlessPaneLoadArgs {
  return {
    rawArgument: "",
    argument: null,
    symbols: [],
    options,
  };
}

function transcriptArgs(options: Record<string, string | number | boolean>): HeadlessPaneLoadArgs {
  return {
    rawArgument: "AMD",
    argument: "AMD",
    symbols: ["AMD"],
    options,
  };
}

function dependencies(): EarningsCallsHeadlessDependencies {
  return {
    loadCalls: async () => ({
      calls,
      fetchedAt: 123,
      stale: false,
    }),
    loadUpcoming: async () => ({ calls: [], fetchedAt: 123, stale: false }),
    loadTranscript: async () => transcript,
  };
}

const context = {} as HeadlessPaneContext;

describe("earnings calls headless", () => {
  test("maps call shelf rows and applies availability", async () => {
    const definition = createEarningsCallsHeadless(dependencies());

    const result = await definition.load(
      callArgs({ view: "transcripts", availability: "pending", limit: 1 }),
      context,
    );

    expect(result.rows).toEqual([
      expect.objectContaining({
        id: "amd-fq1-2026",
        ticker: "AMD",
        status: "queued",
        hasTranscript: false,
      }),
    ]);
    expect(result.metadata).toMatchObject({ availability: "pending", returned: 1 });
  });
});

describe("earnings transcript headless", () => {
  test("full-text fallback searches return matching paragraphs rather than the entire call", () => {
    const fallback = { ...transcript, turns: [], fullText: "Welcome to the quarterly call.\n\nMembership renewal rates increased.\n\nThank you for joining us." };
    expect(buildTranscriptSegments(fallback, "transcript", { search: "RENEWAL" }).map((row) => row.text)).toEqual(["Membership renewal rates increased."]);
    expect(buildTranscriptSegments(fallback, "transcript", { search: "missing" })).toEqual([]);
    expect(buildTranscriptSegments(fallback, "transcript", { speaker: "CFO", search: "renewal" })).toEqual([]);
  });

  test("non-calendar fiscal quarter selection uses reported fiscal identity, not announcement month", () => {
    const cost = [{ ...calls[0]!, id: "cost-fq4", ticker: "COST", fiscalYear: 2025, fiscalQuarter: 4, callAt: "2025-09-25T21:00:00Z" },
      { ...calls[1]!, id: "cost-fq1", ticker: "COST", fiscalYear: 2026, fiscalQuarter: 1, callAt: "2025-12-11T21:00:00Z" }];
    expect(findCallForQuarter(cost, "FQ4-2025")?.id).toBe("cost-fq4");
    expect(findCallForQuarter(cost, "FY2026")?.id).toBe("cost-fq1");
  });
  test("an event that is not an earnings call is listed by its label and is not the latest earnings call", () => {
    const deal: CloudEarningsCallPayload = {
      ...calls[0]!,
      id: "amd-deal",
      fiscalYear: null,
      fiscalQuarter: null,
      callAt: "2026-09-06T12:00:00.000Z",
      eventKind: "other",
      eventLabel: "M&A call",
    };
    expect(findCallForQuarter([deal, ...calls], "latest")?.id).toBe("amd-fq2-2026");
    expect(findCallForQuarter([deal], "latest")?.id).toBe("amd-deal");
    expect(callTitle(deal)).toBe("AMD M&A call");
    expect(callPeriod(deal)).toBe("M&A");
    expect(callTitle(calls[0]!)).toBe("AMD FQ2 26");
  });

  test("a ticker alone lists the company's calls; a quarter or section reads the transcript", async () => {
    const definition = createEarningsCallsHeadless(dependencies());
    const title = definition.describe;
    if (typeof title !== "function") throw new Error("The report title depends on the arguments");
    const listed = await definition.load(transcriptArgs({}), context);
    expect(listed.columns?.map((column) => column.key)).toContain("callAt");
    expect(listed.rows.length).toBe(calls.length);
    expect(title(transcriptArgs({}))).toBe("Earnings Calls | AMD");
    const read = await definition.load(transcriptArgs({ section: "guidance" }), context);
    expect(read.metadata).toMatchObject({ section: "guidance", fiscalQuarter: 2, limit: 20 });
    expect(title(transcriptArgs({ section: "guidance" }))).toBe("Earnings Call Transcript | AMD | latest");
  });

  test("selects a quarter and filters speakers by role acronym", async () => {
    const definition = createEarningsCallsHeadless(dependencies());

    const result = await definition.load(transcriptArgs({
      section: "transcript",
      quarter: "FQ2-2026",
      speaker: "CFO",
      search: "margin",
      offset: 0,
      limit: 20,
    }), context);

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((row) => row.speaker === "Jean Hu")).toBe(true);
    expect(result.metadata).toMatchObject({
      fiscalYear: 2026,
      fiscalQuarter: 2,
      section: "transcript",
      speaker: "CFO",
    });
  });

  test("pages bounded transcript segments and reports truncation", async () => {
    const definition = createEarningsCallsHeadless(dependencies());
    const first = await definition.load(transcriptArgs({
      section: "transcript",
      quarter: "latest",
      speaker: "CFO",
      search: "",
      offset: 0,
      limit: 1,
    }), context);
    const second = await definition.load(transcriptArgs({
      section: "transcript",
      quarter: "latest",
      speaker: "CFO",
      search: "",
      offset: 1,
      limit: 1,
    }), context);

    expect(first.rows).toHaveLength(1);
    expect(first.metadata).toMatchObject({
      returnedSegments: 1,
      truncated: true,
      hasMore: true,
      nextOffset: 1,
    });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.index).toBe(1);
  });
});

describe("bounded call discovery", () => {
  const capped = Array.from({ length: 200 }, (_, index) => ({ ...calls[0]!, id: `bounded-${index}` }));

  test("a full source page remains bounded even when every returned row fits the export", async () => {
    const deps = dependencies();
    deps.loadCalls = async () => ({ calls: capped, fetchedAt: 123, stale: false, sourceLimit: 200, sourceLimitReached: true });
    const result = await createEarningsCallsHeadless(deps).load(callArgs({ view: "transcripts", limit: 200 }), context);
    expect(result.rows).toHaveLength(200);
    expect(result.complete).toBe(false);
    expect(result.metadata).toMatchObject({ total: 200, returned: 200, truncated: true, sourceLimitReached: true, totalIsExact: false });
  });

  test("filtering a capped source to no matches does not imply exhaustive absence", async () => {
    const deps = dependencies();
    // Existing injected/snapshot loaders can omit new metadata; the known 200-row request still bounds this path.
    deps.loadCalls = async () => ({ calls: capped, fetchedAt: 123, stale: false });
    const result = await createEarningsCallsHeadless(deps).load(callArgs({ view: "transcripts", limit: 200, availability: "pending" }), context);
    expect(result.rows).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.metadata).toMatchObject({ total: 0, truncated: true, totalIsExact: false });
    await expect(createEarningsCallsHeadless(deps).load(transcriptArgs({ quarter: "FQ1-1990" }), context))
      .rejects.toThrow("among the latest 200 loaded calls");
  });

  test("an uncapped response keeps exact loaded totals and ordinary missing-quarter behavior", async () => {
    const deps = dependencies();
    const result = await createEarningsCallsHeadless(deps).load(callArgs({ view: "transcripts", limit: 200 }), context);
    expect(result.complete).not.toBe(false);
    expect(result.metadata).toMatchObject({ total: 2, truncated: false, sourceLimitReached: false, totalIsExact: true });
    await expect(createEarningsCallsHeadless(deps).load(transcriptArgs({ quarter: "FQ1-1990" }), context))
      .rejects.toThrow("No FQ1-1990 earnings call found for AMD.");
  });
});

test("pending discovery is not reported as a complete empty export", async () => {
  const deps = dependencies();
  deps.loadCalls = async () => ({ calls: [], fetchedAt: 123, stale: false, pending: true });
  const result = await createEarningsCallsHeadless(deps).load(callArgs({ view: "transcripts", limit: 200 }), context);
  expect(result.complete).toBe(false);
  expect(result.metadata).toMatchObject({ total: 0, pending: true, totalIsExact: false, sourceLimitReached: false });
});

test("a refused account reads as CALLS's lock note on one line, for the list and for a transcript, with the refusal as its cause", async () => {
  const refused = (status: number) => Promise.reject(new ApiRequestError(status === 401 ? "Unauthorized" : "Refused", status));
  const load = (status: number, args: HeadlessPaneLoadArgs, transcriptOnly = false) => createEarningsCallsHeadless({
    ...dependencies(),
    ...(transcriptOnly ? { loadTranscript: () => refused(status) } : { loadCalls: () => refused(status), loadUpcoming: () => refused(status) }),
  }).load(args, context);
  await expect(load(401, callArgs({}))).rejects.toThrow(/^CALLS is part of Gloom Cloud Pro: .* Signed out it shows none of it\. Free, with no sign-in: gloom events <ticker> .*log in or sign up .*then upgrade.*; gloom fn CALLS then reads/);
  await expect(load(403, transcriptArgs({}))).rejects.toThrow(/Until the email is verified it shows none of it\..*verify your email \(Ctrl\+P, Resend Verification Email\)/);
  await expect(load(402, callArgs({}))).rejects.toThrow(/On a free account it shows none of it\..*upgrade in the app/);
  await expect(load(402, transcriptArgs({ section: "qa" }), true)).rejects.toThrow(/^CALLS is part of Gloom Cloud Pro: /);
  const failure = await Promise.resolve(load(401, callArgs({}))).catch((error: unknown) => error);
  expect((failure as Error).cause).toBeInstanceOf(ApiRequestError);
  // Anything else keeps its own message.
  await expect(load(500, callArgs({}))).rejects.toThrow("Refused");
});

describe("upcoming calls", () => {
  // Wednesday Oct 21 2026, 14:00 in New York.
  const now = Date.parse("2026-10-21T18:00:00Z");
  const upcoming = (id: string, ticker: string, callAt: string, extra: Partial<CloudEarningsCallPayload> = {}): CloudEarningsCallPayload => ({
    ...calls[1]!, id, ticker, companyName: `${ticker} Inc`, fiscalYear: 2026, fiscalQuarter: 3, callAt, ...extra,
  });

  test("fn CALLS TICKER puts the next call first, upcoming with its countdown, and on its own line in the text", async () => {
    const deps = dependencies();
    deps.now = () => now;
    deps.loadCalls = async () => ({
      calls: [...calls, upcoming("amd-fq3-2026", "AMD", "2026-11-04T21:00:00Z"), upcoming("amd-fq4-2026", "AMD", "2027-02-03T22:00:00Z")],
      fetchedAt: 123, stale: false,
    });
    const result = await createEarningsCallsHeadless(deps).load(transcriptArgs({}), context);
    expect(result.rows.slice(0, 2)).toEqual([
      expect.objectContaining({ id: "amd-fq3-2026", status: "upcoming", upcoming: true, in: "Nov 4" }),
      expect.objectContaining({ id: "amd-fq4-2026", status: "upcoming" }),
    ]);
    expect((result as { textRows?: unknown[] }).textRows?.map((row) => (row as { id: string }).id)).not.toContain("amd-fq3-2026");
    expect(result.metadata).toMatchObject({
      notices: [expect.stringMatching(/^Next call Wed Nov 4 .*16:00.*\.$/)],
      nextCall: { id: "amd-fq3-2026", timeKnown: true, in: "Nov 4" },
    });
  });

  test("fn CALLS alone is the week's calendar by day in start order, and --view transcripts the shelf", async () => {
    const deps = dependencies();
    deps.now = () => now;
    const asked: unknown[] = [];
    deps.loadUpcoming = async (days) => {
      asked.push(days);
      return {
        calls: [
          upcoming("ibm", "IBM", "2026-10-22T00:00:00Z"),
          upcoming("tsla", "TSLA", "2026-10-21T21:30:00Z"),
          upcoming("ko", "KO", "2026-10-21T12:30:00Z", { status: "published", hasTranscript: true }),
          upcoming("meta", "META", "2026-10-21T20:30:00Z"),
          upcoming("aal", "AAL", "2026-10-22T12:30:00Z", { eventKind: "other", eventLabel: "investor day", fiscalYear: null, fiscalQuarter: null }),
        ],
        fetchedAt: 123,
        stale: false,
      };
    };
    const definition = createEarningsCallsHeadless(deps);
    const result = await definition.load(callArgs({}), context);
    expect(asked).toEqual([{ from: "2026-10-21", to: "2026-10-23" }]);
    expect(result.rows.map((row) => [row.day, row.ticker, row.newYork, row.in])).toEqual([
      ["Today", "KO", "08:30", "transcribed"],
      ["Today", "META", "16:30", "in 2h 30m"],
      ["Today", "TSLA", "17:30", "in 3h 30m"],
      ["Tomorrow", "AAL", "08:30", "in 18h 30m"],
      ["Tomorrow", "IBM", null, "tomorrow"],
    ]);
    expect(result.metadata).toMatchObject({ view: "upcoming", from: "2026-10-21", to: "2026-10-23", total: 5 });
    // An event that is not an earnings call keeps its label in the calendar too.
    expect(result.rows.find((row) => row.ticker === "AAL")).toMatchObject({ period: "Inv day", event: "investor day" });
    const title = definition.describe;
    if (typeof title !== "function") throw new Error("The report title depends on the arguments");
    expect(title(callArgs({}))).toBe("Earnings Calls | Calendar");

    const shelf = await definition.load(callArgs({ view: "transcripts" }), context);
    expect(shelf.rows.map((row) => row.id)).toEqual(["amd-fq2-2026", "amd-fq1-2026"]);
    expect(asked).toHaveLength(1);
    expect(result.complete).not.toBe(false);
    expect(result.metadata?.notices).toBeUndefined();

    // A cut list says so: the reader's own --limit, and the server's limit, which leaves the report incomplete.
    const limited = await definition.load(callArgs({ limit: 2 }), context);
    expect(limited.rows).toHaveLength(2);
    expect(limited.complete).not.toBe(false);
    expect(limited.metadata?.notices).toEqual(["Showing the first 2 of 5 calls (--limit 2)."]);
    const served = deps.loadUpcoming;
    deps.loadUpcoming = async (days, ctx) => ({ ...(await served(days, ctx)), truncated: true });
    const cut = await createEarningsCallsHeadless(deps).load(callArgs({}), context);
    expect(cut.complete).toBe(false);
    expect(cut.metadata).toMatchObject({
      sourceLimit: 1500, sourceLimitReached: true, truncated: true,
      notices: ["The calendar stops at 1,500 calls: later calls from Oct 22 on may be missing."],
    });
  });
});
