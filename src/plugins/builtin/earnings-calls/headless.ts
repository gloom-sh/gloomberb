import type {
  CloudEarningsCallPayload,
  CloudEarningsTranscriptPayload,
} from "../../../api-client";
import type {
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessRowsResult,
} from "../../../types/plugin";
import {
  callStatusLabel,
  isPendingTranscript,
  loadEarningsCallsWithClient,
  loadTranscriptWithClient,
  type EarningsCallsResult,
} from "./data";
import {
  buildTranscriptSegments,
  findCallForQuarter,
  sortCallsNewest,
  type TranscriptSection,
} from "./model";

const CALL_COLUMNS = [
  { key: "ticker", header: "Ticker" },
  { key: "company", header: "Company" },
  { key: "callAt", header: "Call date" },
  { key: "fiscalYear", header: "FY", align: "right" as const },
  { key: "fiscalQuarter", header: "FQ", align: "right" as const },
  { key: "status", header: "Status" },
  { key: "durationSeconds", header: "Seconds", align: "right" as const },
  { key: "wordCount", header: "Words", align: "right" as const },
  { key: "sentiment", header: "Tone", align: "right" as const },
];

const TRANSCRIPT_COLUMNS = [
  { key: "index", header: "#", align: "right" as const },
  { key: "section", header: "Section" },
  { key: "startSeconds", header: "Start", align: "right" as const },
  { key: "speaker", header: "Speaker" },
  { key: "role", header: "Role" },
  { key: "isQa", header: "Q&A" },
  { key: "text", header: "Text" },
];

export interface EarningsCallsHeadlessDependencies {
  loadCalls(
    ticker: string | null,
    limit: number,
    context: HeadlessPaneContext,
  ): Promise<EarningsCallsResult>;
  loadTranscript(
    callId: string,
    context: HeadlessPaneContext,
  ): Promise<CloudEarningsTranscriptPayload>;
}

const defaultDependencies: EarningsCallsHeadlessDependencies = {
  loadCalls: (ticker, limit, context) => loadEarningsCallsWithClient(
    context.apiClient,
    ticker,
    { limit },
  ),
  loadTranscript: (callId, context) => loadTranscriptWithClient(context.apiClient, callId),
};

function callRow(call: CloudEarningsCallPayload) {
  return {
    id: call.id,
    ticker: call.ticker,
    company: call.companyName,
    callAt: call.callAt,
    fiscalYear: call.fiscalYear,
    fiscalQuarter: call.fiscalQuarter,
    status: call.hasTranscript ? "transcribed" : callStatusLabel(call) || call.status,
    durationSeconds: call.durationSeconds,
    wordCount: call.wordCount,
    hasTranscript: call.hasTranscript,
    sentiment: call.sentiment,
    webcastUrl: call.webcastUrl ?? null,
  };
}

function availabilityMatches(call: CloudEarningsCallPayload, availability: string): boolean {
  if (availability === "all") return true;
  return availability === "transcribed" ? call.hasTranscript : !call.hasTranscript;
}

export function projectEarningsCallsHeadless(
  result: EarningsCallsResult,
  args: HeadlessPaneLoadArgs,
): HeadlessRowsResult {
  const availability = String(args.options.availability ?? "all");
  const limit = Number(args.options.limit ?? 50);
  const matching = sortCallsNewest(result.calls)
    .filter((call) => availabilityMatches(call, availability));
  const rows = matching.slice(0, limit).map(callRow);

  return {
    columns: CALL_COLUMNS,
    rows,
    errors: result.refreshError ? [result.refreshError] : undefined,
    metadata: {
      fetchedAt: result.fetchedAt,
      stale: result.stale,
      pending: result.pending ?? false,
      unknownTicker: result.unknownTicker ?? false,
      availability,
      total: matching.length,
      returned: rows.length,
      truncated: rows.length < matching.length,
    },
  };
}

function selectedSection(args: HeadlessPaneLoadArgs): TranscriptSection {
  return String(args.options.section ?? "overview") as TranscriptSection;
}

function transcriptResult(
  transcript: CloudEarningsTranscriptPayload,
  call: CloudEarningsCallPayload,
  args: HeadlessPaneLoadArgs,
): HeadlessRowsResult {
  const section = selectedSection(args);
  const speaker = String(args.options.speaker ?? "").trim();
  const search = String(args.options.search ?? "").trim();
  const offset = Number(args.options.offset ?? 0);
  const limit = Number(args.options.limit ?? 20);
  const segments = buildTranscriptSegments(transcript, section, { speaker, search });
  const rows = segments.slice(offset, offset + limit).map((segment) => ({ ...segment }));
  const hasMore = offset + rows.length < segments.length;

  return {
    columns: TRANSCRIPT_COLUMNS,
    rows,
    metadata: {
      callId: call.id,
      ticker: transcript.ticker,
      company: transcript.companyName,
      fiscalYear: transcript.fiscalYear,
      fiscalQuarter: transcript.fiscalQuarter,
      callAt: transcript.callAt,
      durationSeconds: transcript.durationSeconds,
      wordCount: transcript.wordCount,
      sentiment: transcript.sentiment,
      updatedAt: transcript.updatedAt,
      section,
      speaker: speaker || null,
      search: search || null,
      offset,
      limit,
      totalSegments: segments.length,
      returnedSegments: rows.length,
      truncated: offset > 0 || hasMore,
      hasMore,
      nextOffset: hasMore ? offset + rows.length : null,
    },
  };
}

function transcriptOptions() {
  return [
    {
      key: "section",
      description: "Transcript section to return.",
      type: "enum" as const,
      values: [
        { value: "overview" },
        { value: "summary" },
        { value: "transcript" },
        { value: "qa", aliases: ["q&a"] },
        { value: "guidance" },
        { value: "risks" },
        { value: "notable" },
        { value: "analyst-focus", aliases: ["analyst"] },
        { value: "participants", aliases: ["speakers"] },
      ],
      defaultValue: "overview",
    },
    {
      key: "quarter",
      description: "Fiscal quarter such as latest, FQ2-2026, or FY2026.",
      type: "string" as const,
      defaultValue: "latest",
    },
    {
      key: "speaker",
      description: "Speaker name, role, or role acronym such as CFO.",
      type: "string" as const,
      defaultValue: "",
    },
    {
      key: "search",
      description: "Text to find in transcript turns.",
      type: "string" as const,
      defaultValue: "",
    },
    {
      key: "offset",
      description: "Transcript segment offset for paging.",
      type: "integer" as const,
      defaultValue: 0,
      minimum: 0,
      maximum: 100_000,
    },
    {
      key: "limit",
      description: "Maximum transcript segments to return.",
      type: "integer" as const,
      defaultValue: 20,
      minimum: 1,
      maximum: 200,
    },
  ];
}

export function createEarningsCallsHeadless(
  dependencies: EarningsCallsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: "Optional company symbol. Omit it to browse all calls.",
      optional: true,
    },
    options: [
      {
        key: "availability",
        description: "Transcript availability to include.",
        type: "enum",
        values: [
          { value: "all" },
          { value: "transcribed" },
          { value: "pending" },
        ],
        defaultValue: "all",
      },
      {
        key: "limit",
        description: "Maximum calls to return.",
        type: "integer",
        defaultValue: 50,
        minimum: 1,
        maximum: 200,
      },
    ],
    columns: CALL_COLUMNS,
    describe: (args) => args.argument
      ? `Earnings Calls | ${String(args.argument)}`
      : "Earnings Calls",
    async load(args, context) {
      const ticker = typeof args.argument === "string" ? args.argument : null;
      return projectEarningsCallsHeadless(
        await dependencies.loadCalls(ticker, 200, context),
        args,
      );
    },
  };
}

export function createEarningsTranscriptHeadless(
  dependencies: EarningsCallsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: "Company symbol.",
    },
    options: transcriptOptions(),
    columns: TRANSCRIPT_COLUMNS,
    describe: (args) => (
      `Earnings Call Transcript | ${String(args.argument)} | ${String(args.options.quarter)}`
    ),
    async load(args, context) {
      const ticker = String(args.argument);
      const calls = await dependencies.loadCalls(ticker, 200, context);
      const quarter = String(args.options.quarter ?? "latest");
      const selected = findCallForQuarter(calls.calls, quarter);
      if (!selected) {
        if (calls.unknownTicker) throw new Error(`${ticker} is not a known listed company.`);
        if (calls.pending) throw new Error(`Earnings call discovery for ${ticker} is still pending.`);
        throw new Error(`No ${quarter} earnings call found for ${ticker}.`);
      }
      const transcript = await dependencies.loadTranscript(selected.id, context);
      if (isPendingTranscript(transcript)) {
        throw new Error(`Transcript for ${ticker} ${quarter} is still being produced.`);
      }
      return transcriptResult(transcript, selected, args);
    },
  };
}

export const earningsCallsHeadless = createEarningsCallsHeadless();
export const earningsTranscriptHeadless = createEarningsTranscriptHeadless();
