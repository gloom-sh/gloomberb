import { describe, expect, test } from "bun:test";
import type {
  CloudEarningsCallPayload,
  CloudEarningsTranscriptPayload,
} from "../../../api-client";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import {
  createEarningsCallsHeadless,
  createEarningsTranscriptHeadless,
  type EarningsCallsHeadlessDependencies,
} from "./headless";
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
    loadTranscript: async () => transcript,
  };
}

const context = {} as HeadlessPaneContext;

describe("earnings calls headless", () => {
  test("maps call shelf rows and applies availability", async () => {
    const definition = createEarningsCallsHeadless(dependencies());

    const result = await definition.load(
      callArgs({ availability: "pending", limit: 1 }),
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
  test("selects a quarter and filters speakers by role acronym", async () => {
    const definition = createEarningsTranscriptHeadless(dependencies());

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
    const definition = createEarningsTranscriptHeadless(dependencies());
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
    const result = await createEarningsCallsHeadless(deps).load(callArgs({ limit: 200 }), context);
    expect(result.rows).toHaveLength(200);
    expect(result.complete).toBe(false);
    expect(result.metadata).toMatchObject({ total: 200, returned: 200, truncated: true, sourceLimitReached: true, totalIsExact: false });
  });

  test("filtering a capped source to no matches does not imply exhaustive absence", async () => {
    const deps = dependencies();
    // Existing injected/snapshot loaders can omit new metadata; the known 200-row request still bounds this path.
    deps.loadCalls = async () => ({ calls: capped, fetchedAt: 123, stale: false });
    const result = await createEarningsCallsHeadless(deps).load(callArgs({ limit: 200, availability: "pending" }), context);
    expect(result.rows).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.metadata).toMatchObject({ total: 0, truncated: true, totalIsExact: false });
    await expect(createEarningsTranscriptHeadless(deps).load(transcriptArgs({ quarter: "FQ1-1990" }), context))
      .rejects.toThrow("among the latest 200 loaded calls");
  });

  test("an uncapped response keeps exact loaded totals and ordinary missing-quarter behavior", async () => {
    const deps = dependencies();
    const result = await createEarningsCallsHeadless(deps).load(callArgs({ limit: 200 }), context);
    expect(result.complete).not.toBe(false);
    expect(result.metadata).toMatchObject({ total: 2, truncated: false, sourceLimitReached: false, totalIsExact: true });
    await expect(createEarningsTranscriptHeadless(deps).load(transcriptArgs({ quarter: "FQ1-1990" }), context))
      .rejects.toThrow("No FQ1-1990 earnings call found for AMD.");
  });
});

test("pending discovery is not reported as a complete empty export", async () => {
  const deps = dependencies();
  deps.loadCalls = async () => ({ calls: [], fetchedAt: 123, stale: false, pending: true });
  const result = await createEarningsCallsHeadless(deps).load(callArgs({ limit: 200 }), context);
  expect(result.complete).toBe(false);
  expect(result.metadata).toMatchObject({ total: 0, pending: true, totalIsExact: false, sourceLimitReached: false });
});
