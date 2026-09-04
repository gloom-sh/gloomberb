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
