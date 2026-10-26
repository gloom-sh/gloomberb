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
import { explainRefusal } from "../shared/cloud-denied";
import { resolveHeadlessIssuerListing } from "../shared/headless-market-data";
import {
  calendarAway,
  callStatusLabel,
  isPendingTranscript,
  loadEarningsCallsWithClient,
  loadTranscriptWithClient,
  loadUpcomingCallsWithClient,
  UPCOMING_LIMIT,
  upcomingCutNotice,
  type EarningsCallsResult,
  type UpcomingCallsResult,
  type UpcomingDays,
} from "./data";
import { callPeriod, eventLabelOf } from "./format";
import type { MarketDay } from "../earnings/board-model";
import {
  calendarDays,
  calendarSections,
  callAway,
  callCountdown,
  callLocalClock,
  callNewYorkClock,
  callStartText,
  callTimeKnown,
  clockIsNewYork,
  isUpcomingCall,
  nextCall,
} from "./upcoming";
import { callsLockNote } from "./lock-note";
import {
  buildTranscriptSegments,
  findCallForQuarter,
  sortCallsNewest,
  type TranscriptSection,
} from "./model";
import { REPORT_FILTER, REPORT_PAGE, REPORT_ROWS } from "../shared/headless-options";

const CALL_COLUMNS = [
  { key: "ticker", header: "Ticker" },
  { key: "company", header: "Company" },
  { key: "callAt", header: "Call date" },
  { key: "fiscalYear", header: "FY", align: "right" as const },
  { key: "fiscalQuarter", header: "FQ", align: "right" as const },
  { key: "event", header: "Event" },
  { key: "status", header: "Status" },
  { key: "durationSeconds", header: "Seconds", align: "right" as const },
  { key: "wordCount", header: "Words", align: "right" as const },
  { key: "sentiment", header: "Tone", align: "right" as const },
];

/** CALLS alone: the calendar's calls, by day, with their starts here and in New York. */
const CALENDAR_COLUMNS = [
  { key: "day", header: "Day" },
  { key: "ticker", header: "Ticker" },
  { key: "company", header: "Company" },
  { key: "callAt", header: "Call at" },
  { key: "timeKnown", header: "Time known" },
  { key: "local", header: "Local" },
  { key: "newYork", header: "ET" },
  { key: "period", header: "Period" },
  { key: "in", header: "In" },
  { key: "status", header: "Status" },
];
/** The text report leaves out the instant and its flag, which the two clocks say, and the status the In column says. */
const CALENDAR_TEXT_COLUMNS = CALENDAR_COLUMNS.filter((column) => !["callAt", "timeKnown", "status"].includes(column.key));

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
  loadUpcoming(days: UpcomingDays, context: HeadlessPaneContext): Promise<UpcomingCallsResult>;
  /** When the report is read; the countdowns and the calendar's days are against it. */
  now?(): number;
  loadTranscript(
    callId: string,
    context: HeadlessPaneContext,
  ): Promise<CloudEarningsTranscriptPayload>;
}

const defaultDependencies: EarningsCallsHeadlessDependencies = {
  loadCalls: async (ticker, limit, context) => loadEarningsCallsWithClient(
    context.apiClient,
    ticker,
    { limit, ...(ticker ? await resolveHeadlessIssuerListing(context, ticker) : {}) },
  ),
  loadUpcoming: (days, context) => loadUpcomingCallsWithClient(context.apiClient, days),
  loadTranscript: (callId, context) => loadTranscriptWithClient(context.apiClient, callId),
};

/** A refused read says what the lock note says (CALLS is Pro whole), so a free account meets the same words as a signed-out one. */
function explainDenied(ticker: string | null, context: HeadlessPaneContext) {
  return async (error: unknown): Promise<never> => { throw await explainRefusal(error, callsLockNote, { symbol: ticker, context }); };
}

function callRow(call: CloudEarningsCallPayload, now: number) {
  const upcoming = isUpcomingCall(call, now);
  return {
    id: call.id,
    ticker: call.ticker,
    company: call.companyName,
    callAt: call.callAt,
    fiscalYear: call.fiscalYear,
    fiscalQuarter: call.fiscalQuarter,
    // A deal call, a conference, an investor day: not a quarter's earnings call.
    event: eventLabelOf(call),
    status: call.hasTranscript ? "transcribed" : callStatusLabel(call, now) || call.status,
    upcoming,
    in: upcoming ? callCountdown(call, now) : null,
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

/** The next call as its own line above a company's calls: "Next call Thu Oct 22 22:30 (16:30 ET), in 3h." */
export function nextCallNotice(call: CloudEarningsCallPayload, now: number): string {
  const { start, newYork } = callStartText(call, now);
  const away = callAway(call, now);
  return `Next call ${start}${newYork ? ` (${newYork})` : ""}${away ? `, ${away}` : ""}.`;
}

function projectEarningsCallsHeadless(
  result: EarningsCallsResult,
  args: HeadlessPaneLoadArgs,
  now: number,
): HeadlessRowsResult {
  const availability = String(args.options.availability ?? "all");
  const limit = Number(args.options.limit ?? 50);
  const matching = sortCallsNewest(result.calls)
    .filter((call) => availabilityMatches(call, availability));
  // A company's next call leads, on its own line above the table as in the pane.
  const next = typeof args.argument === "string" ? nextCall(matching, now) : null;
  const ordered = next ? [next, ...matching.filter((call) => call !== next)] : matching;
  const rows = ordered.slice(0, limit).map((call) => callRow(call, now));
  const sourceLimit = result.sourceLimit ?? 200;
  const sourceLimitReached = result.sourceLimitReached ?? result.calls.length >= sourceLimit;

  return {
    columns: CALL_COLUMNS,
    rows,
    ...(next ? { textRows: rows.filter((row) => row.id !== next.id) } : {}),
    errors: result.refreshError ? [result.refreshError] : undefined,
    ...(sourceLimitReached || result.pending ? { complete: false } : {}),
    metadata: {
      ...(next ? { notices: [nextCallNotice(next, now)], nextCall: { id: next.id, callAt: next.callAt, timeKnown: callTimeKnown(next), in: callCountdown(next, now) } } : {}),
      fetchedAt: result.fetchedAt,
      stale: result.stale,
      pending: result.pending ?? false,
      unknownTicker: result.unknownTicker ?? false,
      availability,
      total: matching.length,
      sourceLimit,
      sourceLimitReached,
      totalIsExact: !sourceLimitReached && !result.pending && !result.stale,
      returned: rows.length,
      truncated: sourceLimitReached || rows.length < matching.length,
    },
  };
}

function selectedSection(args: HeadlessPaneLoadArgs): TranscriptSection {
  return String(args.options.section ?? "overview") as TranscriptSection;
}

function transcriptResult(
  transcript: CloudEarningsTranscriptPayload,
  call: CloudEarningsCallPayload,
  calls: EarningsCallsResult,
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
    errors: calls.refreshError ? [calls.refreshError] : undefined,
    ...(calls.stale || calls.pending ? { complete: false } : {}),
    metadata: {
      stale: calls.stale,
      callListFetchedAt: calls.fetchedAt,
      callListPending: calls.pending ?? false,
      callId: call.id,
      ticker: transcript.ticker,
      company: transcript.companyName,
      fiscalYear: transcript.fiscalYear,
      fiscalQuarter: transcript.fiscalQuarter,
      event: eventLabelOf(transcript),
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

/** The calendar's rows: each day's calls in start order, with how far away each is. */
function projectCalendar(
  result: UpcomingCallsResult,
  days: readonly MarketDay[],
  args: HeadlessPaneLoadArgs,
  now: number,
): HeadlessRowsResult {
  const availability = String(args.options.availability ?? "all");
  // The calendar lists every call of its days unless --limit says fewer.
  const limit = args.options.limit == null ? Number.POSITIVE_INFINITY : Number(args.options.limit);
  const sections = calendarSections(result.calls.filter((call) => availabilityMatches(call, availability)), days);
  const all = sections.flatMap((section) => section.items.map((call) => ({ day: section.label, call })));
  const rows = all.slice(0, limit).map(({ day, call }) => ({
    id: call.id,
    day,
    ticker: call.ticker,
    company: call.companyName,
    callAt: call.callAt,
    timeKnown: callTimeKnown(call),
    local: callLocalClock(call),
    newYork: callNewYorkClock(call),
    period: callPeriod(call),
    event: eventLabelOf(call),
    fiscalYear: call.fiscalYear,
    fiscalQuarter: call.fiscalQuarter,
    in: calendarAway(call, now),
    status: call.hasTranscript ? "transcribed" : callStatusLabel(call, now) || call.status,
    hasTranscript: call.hasTranscript,
    webcastUrl: call.webcastUrl ?? null,
  }));
  // On New York's clock one time says both, as in the pane.
  const sameClock = clockIsNewYork(all.map(({ call }) => call), now);
  // A cut list says so above the table: the server's limit, or the reader's own --limit.
  const notices = [
    ...(result.truncated ? [upcomingCutNotice(result.calls)] : []),
    ...(rows.length < all.length ? [`Showing the first ${rows.length} of ${all.length} calls (--limit ${rows.length}).`] : []),
  ];
  return {
    columns: CALENDAR_COLUMNS,
    textColumns: sameClock ? CALENDAR_TEXT_COLUMNS.filter((column) => column.key !== "local") : CALENDAR_TEXT_COLUMNS,
    rows,
    errors: result.refreshError ? [result.refreshError] : undefined,
    ...(result.stale || result.truncated ? { complete: false } : {}),
    empty: "No calls on the calendar these days.",
    metadata: {
      view: "upcoming",
      fetchedAt: result.fetchedAt,
      stale: result.stale,
      from: days[0]?.from ?? null,
      to: days.at(-1)?.to ?? null,
      days: days.map((day) => ({ label: day.label, from: day.from, to: day.to })),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      availability,
      total: all.length,
      returned: rows.length,
      truncated: rows.length < all.length || !!result.truncated,
      sourceLimit: UPCOMING_LIMIT,
      sourceLimitReached: !!result.truncated,
      ...(notices.length ? { notices } : {}),
    },
  };
}

/**
 * `fn CALLS` is the calendar of every company's calls this week (`--view
 * transcripts` lists the latest transcripts instead); `fn CALLS NVDA` lists
 * the company's calls, its next one first. Naming a quarter or a section
 * reads one transcript instead, with paging.
 */
function readsTranscript(args: HeadlessPaneLoadArgs): boolean {
  return typeof args.argument === "string"
    && (String(args.options.quarter ?? "").trim().length > 0 || String(args.options.section ?? "").trim().length > 0);
}

export function createEarningsCallsHeadless(
  dependencies: EarningsCallsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    freshness: { source: "Company earnings calls", status: "not-a-feed", basis: "transcripts" },
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: "Optional company symbol. Omit it for the calendar of every company's calls.",
      optional: true,
    },
    options: [
      {
        key: "view",
        description: "Without a ticker: the calendar of every company's calls today and this week, or the latest transcripts.",
        type: "enum",
        values: [
          { value: "upcoming", aliases: ["calendar"] },
          { value: "transcripts", aliases: ["transcribed", "shelf"] },
        ],
        defaultValue: "upcoming",
        example: "--view transcripts",
        exampleWithoutArgument: true,
      },
      {
        key: "availability",
        shot: REPORT_FILTER,
        description: "Transcript availability to include when listing calls.",
        type: "enum",
        values: [
          { value: "all" },
          { value: "transcribed" },
          { value: "pending" },
        ],
        defaultValue: "all",
      },
      {
        key: "quarter",
        description: "Read one transcript: latest, FQ2-2026, or FY2026. Needs a ticker.",
        type: "string",
        defaultValue: "",
      },
      {
        key: "section",
        shot: { reportOnly: "picks a transcript section for the text report" },
        description: "Transcript section to return; implies --quarter latest.",
        type: "enum",
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
        defaultValue: "",
      },
      {
        key: "speaker",
        shot: { reportOnly: "picks a speaker's turns for the text report" },
        description: "Speaker name, role, or role acronym such as CFO, when reading a transcript.",
        type: "string",
        defaultValue: "",
      },
      {
        key: "search",
        shot: { reportOnly: "finds text in the transcript for the text report" },
        description: "Text to find in transcript turns, when reading a transcript.",
        type: "string",
        defaultValue: "",
      },
      {
        key: "offset",
        shot: REPORT_PAGE,
        description: "Transcript segment offset for paging.",
        type: "integer",
        defaultValue: 0,
        minimum: 0,
        maximum: 100_000,
      },
      {
        key: "limit",
        shot: REPORT_ROWS,
        description: "Maximum calls, or transcript segments, to return (every call on the calendar, 50 of a company's calls, 20 segments by default).",
        type: "integer",
        minimum: 1,
        maximum: 200,
      },
    ],
    columns: CALL_COLUMNS,
    // No aliases: the template's keywords stay the catalog's search terms.
    discovery: {
      dataRequirements: ["Gloom Cloud Pro account"],
      limitations: ["Pro only, the list of calls included."],
    },
    describe: (args) => {
      if (readsTranscript(args)) {
        return `Earnings Call Transcript | ${String(args.argument)} | ${String(args.options.quarter || "latest")}`;
      }
      if (args.argument) return `Earnings Calls | ${String(args.argument)}`;
      return String(args.options.view ?? "upcoming") === "transcripts" ? "Earnings Calls | Transcripts" : "Earnings Calls | Calendar";
    },
    async load(args, context) {
      const ticker = typeof args.argument === "string" ? args.argument : null;
      const now = dependencies.now?.() ?? Date.now();
      if (!ticker && String(args.options.view ?? "upcoming") !== "transcripts") {
        const days = calendarDays(now);
        const upcoming = await dependencies
          .loadUpcoming({ from: days[0]!.from, to: days.at(-1)!.to }, context)
          .catch(explainDenied(null, context));
        return projectCalendar(upcoming, days, args, now);
      }
      const calls = await dependencies.loadCalls(ticker, 200, context).catch(explainDenied(ticker, context));
      if (!ticker || !readsTranscript(args)) {
        return projectEarningsCallsHeadless(calls, { ...args, options: { ...args.options, limit: args.options.limit ?? 50 } }, now);
      }
      const quarter = String(args.options.quarter || "latest");
      const selected = findCallForQuarter(calls.calls, quarter);
      if (!selected) {
        if (calls.unknownTicker) throw new Error(`${ticker} is not a known listed company.`);
        if (calls.pending) throw new Error(`Earnings call discovery for ${ticker} is still pending.`);
        if (calls.sourceLimitReached ?? calls.calls.length >= (calls.sourceLimit ?? 200)) {
          throw new Error(`No ${quarter} earnings call found among the latest ${calls.sourceLimit ?? 200} loaded calls for ${ticker}; earlier calls may exist.`);
        }
        throw new Error(`No ${quarter} earnings call found for ${ticker}.`);
      }
      const transcript = await dependencies.loadTranscript(selected.id, context).catch(explainDenied(ticker, context));
      if (isPendingTranscript(transcript)) {
        throw new Error(`Transcript for ${ticker} ${quarter} is still being produced.`);
      }
      return transcriptResult(transcript, selected, calls, {
        ...args,
        options: { ...args.options, section: args.options.section || "overview", limit: args.options.limit ?? 20 },
      });
    },
  };
}

export const earningsCallsHeadless = createEarningsCallsHeadless();
