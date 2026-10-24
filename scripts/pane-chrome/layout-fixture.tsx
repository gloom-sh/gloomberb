/** @jsxImportSource react */
/**
 * Panes for the layout checks (layout-checks.ts): one per shared component
 * that sets text or scrolls content (the stack detail reader, the article
 * reader, markdown, prose paragraphs, a table, and a page with a table as tall
 * as its rows and label and value rows, a series list beside its detail
 * under a query bar), plus the real Trials and
 * Changelog panes, whose open items read through the detail reader, and the
 * Calls pane on an invented earnings call with its recording. Every study,
 * release, article and call is invented, and nothing is fetched: the Trials
 * registry, the release feed and Gloom Cloud's call reads are answered in the
 * page, signed in on a Pro plan.
 *
 * Scenario options (query string, after `scenario=layout`): `pane=<id>`
 * (trials, changelog, calls, reader, markdown, prose, inline, list, or a pane of the main
 * fixture such as table or chart-bar), `audio=<url>` (the recording the call
 * plays, `none` for a call without one), `calls=calendar` or `calls=META`
 * (the Calls pane alone or on one company, over a production-like day of
 * calls) and `mode=dock` or
 * `mode=float`; a floating pane takes most of the window at a size that is not
 * a whole number of cells.
 */
import { useRef, useState } from "react";
import { SeriesListDetail, useSeriesList } from "../../src/plugins/builtin/shared/series-list-detail";
import { DetailScrollBody } from "../../src/components/ui/detail-scroll-body";
import { BulletList, Prose } from "../../src/components/ui/prose";
import { KeyValueRow } from "../../src/components/ui/display";
import { DataTableView } from "../../src/components/data-table/view";
import { buildSectionedRows, isSectionedItemRow, renderSectionedRowHeader, sectionedRowsHeight, type SectionedRow } from "../../src/components/data-table/sections";
import { MarkdownText } from "../../src/components/markdown-text";
import { ArticleReader } from "../../src/components/reader/article-reader";
import { parseArticle } from "../../src/components/reader/article-text";
import { TrialsPane } from "../../src/plugins/builtin/clinical-trials/pane";
import { changelogModule } from "../../src/plugins/builtin/changelog";
import { EarningsCallsPane } from "../../src/plugins/builtin/earnings-calls/pane";
import { apiClient, setCloudApiFetchTransport, type CloudEarningsCallPayload, type CloudEarningsTranscriptPayload, type CloudTranscriptTurnPayload } from "../../src/api-client";
import { PluginRenderProvider } from "../../src/plugins/runtime";
import { createTestPluginRuntime } from "../../src/test-support/plugin-runtime";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../src/theme/font-scale";
import type { LayoutConfig } from "../../src/types/config";
import type { PaneProps } from "../../src/types/plugin";
import type { ScrollBoxRenderable } from "../../src/ui";
import { Box, useUiCapabilities } from "../../src/ui";
import { setHttpFetchTransport } from "../../src/utils/http-transport";

const SENTENCES = [
  "The registry lists a two-arm study of a home exercise program for adults recovering from a long hospital stay.",
  "Participants are assigned at random to the program or to the usual follow-up, and both groups keep their regular care.",
  "The main outcome is the distance walked in six minutes at twelve weeks, measured by staff who do not know the assignment.",
  "Secondary outcomes include grip strength, a quality of life questionnaire, readmissions and the number of falls reported.",
  "The sponsor expects to enrol participants at four sites and to report results a year after the last visit.",
  "Visits take place at the start, at six weeks and at twelve weeks, with a phone call between them.",
];
/** One long paragraph, then a list and a short closing paragraph: the shape a registry summary takes. */
const SUMMARY = [
  [...SENTENCES, ...SENTENCES].join(" "),
  "The main questions it aims to answer are:",
  "* Does the program lengthen the distance walked in six minutes?",
  "* Does it change how often participants return to hospital?",
  SENTENCES.slice(0, 3).join(" "),
].join("\n\n");

function inventedStudy(index: number) {
  return {
    protocolSection: {
      identificationModule: { nctId: `NCT0900${String(index).padStart(4, "0")}`, briefTitle: `Home Exercise After a Long Hospital Stay, Study ${index + 1}`, officialTitle: "An invented study" },
      statusModule: {
        overallStatus: index % 2 ? "RECRUITING" : "NOT_YET_RECRUITING",
        studyFirstPostDateStruct: { date: "2026-10-09" },
        lastUpdatePostDateStruct: { date: `2026-10-${String(16 - index).padStart(2, "0")}` },
        startDateStruct: { date: "2026-11-01", type: "ESTIMATED" },
        primaryCompletionDateStruct: { date: "2027-11", type: "ESTIMATED" },
        completionDateStruct: { date: "2028-03", type: "ESTIMATED" },
      },
      sponsorCollaboratorsModule: { leadSponsor: { name: "Lumen Clinical Workshop", class: "OTHER" } },
      designModule: { studyType: "INTERVENTIONAL", phases: ["NA"], enrollmentInfo: { count: 120 + index } },
      conditionsModule: { conditions: ["Deconditioning", "Hospital Readmission", "Frailty"] },
      descriptionModule: { briefSummary: SUMMARY },
    },
  };
}

const RELEASE_BODY = [
  "## Highlights",
  "",
  ...Array.from({ length: 6 }, (_, index) => `- **An invented change ${index + 1}.** ${SENTENCES[index % SENTENCES.length]} ${SENTENCES[(index + 1) % SENTENCES.length]} (#${1700 + index})`),
  "",
  "## Also in this release",
  "",
  ...Array.from({ length: 8 }, (_, index) => `- ${SENTENCES[(index + 2) % SENTENCES.length]} (#${1720 + index})`),
  "",
  "[Full diff](https://example.invalid/compare/v0.9.8...v0.9.9)",
].join("\n");

const RELEASES = Array.from({ length: 6 }, (_, index) => ({
  id: 9000 + index,
  tag_name: `v0.9.${9 - index}`,
  name: `v0.9.${9 - index} An invented release`,
  body: RELEASE_BODY,
  html_url: `https://example.invalid/releases/${index}`,
  published_at: new Date(Date.UTC(2026, 9, 12 - index)).toISOString(),
  draft: false,
  prerelease: false,
}));

/** Answers the Trials registry and the release feed in the page; anything else fails. */
export function installLayoutFetches(params?: URLSearchParams): void {
  if (params?.get("pane") === "calls") installCallFetches(params);
  const answer = (url: string): Response | null => {
    if (url.startsWith("https://clinicaltrials.gov/api/v2/studies")) {
      return Response.json({ studies: Array.from({ length: 12 }, (_, index) => inventedStudy(index)) });
    }
    if (url.startsWith("https://api.github.com/repos/") && url.includes("/releases")) return Response.json(RELEASES);
    return null;
  };
  setHttpFetchTransport(async (url) => answer(url) ?? new Response("Not in the fixture", { status: 404 }));
  const pageFetch = window.fetch.bind(window);
  const fixtureFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return answer(url) ?? pageFetch(input, init);
  };
  window.fetch = Object.assign(fixtureFetch, { preconnect: pageFetch.preconnect }) as typeof fetch;
}

/** An invented company's calls, newest first; the newest is the one the Calls pane opens. */
const CALLS: CloudEarningsCallPayload[] = [2, 1, 4, 3].map((quarter, index) => ({
  id: `lumen-${index}`,
  ticker: "LUMN",
  companyName: "Lumen Instrument Works",
  fiscalYear: index < 2 ? 2026 : 2025,
  fiscalQuarter: quarter,
  callAt: new Date(Date.UTC(2026, 7 - index * 3, 6, 21)).toISOString(),
  status: "published",
  durationSeconds: 240 + index * 600,
  wordCount: 900,
  hasTranscript: true,
  sentiment: 0.18 - index * 0.07,
}));

const turn = (
  speaker: string,
  role: string | undefined,
  startSeconds: number,
  paragraphs: Array<[number, string]>,
  isQa = false,
): CloudTranscriptTurnPayload => ({
  speaker,
  role,
  company: role === "Analyst" ? "Harbour Street Research" : role ? "Lumen Instrument Works" : undefined,
  text: paragraphs.map(([, text]) => text).join(" "),
  paragraphs: paragraphs.map(([, text]) => text),
  paragraphStarts: paragraphs.map(([start]) => start),
  isQa,
  startSeconds,
});

/** Four minutes of an invented call, timed against the recording the page plays. */
const TURNS: CloudTranscriptTurnPayload[] = [
  turn("Operator", undefined, 4, [[4, "Good afternoon and welcome to the second quarter call of Lumen Instrument Works. All lines are in listen-only mode until the question and answer session."]]),
  turn("Mara Ellison", "Head of Investor Relations", 16, [[16, "Thank you, and good afternoon. With me are our chief executive and our chief financial officer. Our remarks include forward-looking statements, and the risks that could change them are in our annual report."]]),
  turn("Theo Brandt", "Chief Executive Officer", 31, [
    [31, "Thanks, Mara. The quarter came in ahead of the plan we set in February. Orders for the field spectrometers grew 14% from a year ago, and the backlog closed at $212 million, the highest in our history."],
    [52, "The new lens line in the river studio reached full output in June. It took two months longer than we wanted, but yields are now above 90% and the cost of each assembly is down by a fifth."],
    [74, "Turning to the classroom kits, schools placed their autumn orders earlier than usual. We shipped 38,000 kits in the quarter and expect a similar number in the third."],
  ]),
  turn("Ines Kovac", "Chief Financial Officer", 96, [
    [96, "Revenue was $148 million, up 11%. Gross margin was 46.2%, a point and a half better than last year, mostly from the lens yields Theo described."],
    [117, "Operating expenses rose 6% as we added service staff in two regions. Free cash flow was $19 million, and we ended the quarter with $96 million in cash and no debt."],
    [138, "For the full year we now expect revenue of $590 million to $605 million and a gross margin of about 46%."],
  ]),
  turn("Operator", undefined, 156, [[156, "We will now begin the question and answer session. The first question comes from Priya Nandakumar with Harbour Street Research."]], true),
  turn("Priya Nandakumar", "Analyst", 166, [[166, "Thanks for taking the question. How much of the margin gain is lasting, and how much came from the timing of the classroom shipments?"]], true),
  turn("Ines Kovac", "Chief Financial Officer", 178, [
    [178, "Most of it is lasting. The yield improvement stays with us. The classroom timing added perhaps thirty basis points that will reverse in the fourth quarter."],
    [196, "So the right way to think about the second half is a margin close to where we were this quarter, not above it."],
  ], true),
  turn("Priya Nandakumar", "Analyst", 208, [[208, "And on the backlog, how quickly does it convert?"]], true),
  turn("Theo Brandt", "Chief Executive Officer", 214, [[214, "About two thirds ships within two quarters. The rest is observatory work with acceptance testing, which runs on the customer's schedule."]], true),
  turn("Operator", undefined, 230, [[230, "That concludes today's call. Thank you for joining."]], true),
];

const CALL_TRANSCRIPT: CloudEarningsTranscriptPayload = {
  ...CALLS[0]!,
  timing: null,
  webcastUrl: "https://example.invalid/lumen/webcast",
  fullText: "",
  turns: TURNS,
  participants: [
    { name: "Theo Brandt", role: "Chief Executive Officer", company: "Lumen Instrument Works" },
    { name: "Ines Kovac", role: "Chief Financial Officer", company: "Lumen Instrument Works" },
    { name: "Priya Nandakumar", role: "Analyst", company: "Harbour Street Research" },
  ],
  summary: "Orders and margin came in ahead of plan. The lens line reached full output and the backlog is the largest the company has had.",
  guidance: "Full-year revenue of $590 million to $605 million and a gross margin of about 46%.",
  riskFactors: "Observatory work converts on customers' acceptance schedules.",
  notable: "Classroom kit orders arrived earlier than usual.",
  analystFocus: "How lasting the margin gain is, and how fast the backlog converts.",
  sentimentRationale: null,
  qaStartTurn: 4,
  asrModel: null,
  updatedAt: "2026-08-07T00:00:00Z",
};

/**
 * Every company's calls on three New York days, as production listed them on
 * Wednesday Oct 21, 2026, for `calls=calendar` and `calls=META`:
 * the day from today in New York, the start on New York's clock (null for a
 * call known by its day alone), ticker, company, fiscal year and quarter,
 * status, then length, words and tone for a transcribed one. Each start is
 * put on today's date when the page loads, so a picture shows the day's calls
 * gone and to come around the time it is taken.
 */
type DayCall = [day: number, clock: string | null, ticker: string, company: string, year: number | null, quarter: number | null,
  status: string, seconds: number | null, words: number | null, tone: number | null];
const DAY_CALLS: DayCall[] = [
  [0, "07:00", "TMO", "THERMO FISHER SCIENTIFIC INC.", 2026, 3, "published", 3433, 8409, 0.83],
  [0, "08:30", "CB", "Chubb Limited", 2026, 3, "published", 3440, 6860, 0.72],
  [0, "08:30", "CME", "CME Group", 2026, 3, "published", 900, 94, 0],
  [0, "08:30", "ELV", "Elevance Health", 2026, 3, "published", 3517, 9099, 0.68],
  [0, "08:30", "HCSG", "HEALTHCARE SERVICES GROUP INC", 2026, 3, "published", 2496, 6087, 0.72],
  [0, "08:30", "IART", "INTEGRA LIFESCIENCES HOLDINGS CORP", 2026, 3, "published", 900, 67, 0],
  [0, "08:30", "WAB", "Wabtec", 2026, 3, "published", 3300, 7950, 0.76],
  [0, "09:00", "ADC", "AGREE REALTY CORP", 2026, 3, "published", 2983, 7527, 0.65],
  [0, "09:00", "BKU", "BankUnited, Inc.", 2026, 3, "published", 3459, 8810, 0.68],
  [0, "09:00", "BWB", "Bridgewater Bancshares Inc", 2026, 3, "published", 2431, 6597, 0.78],
  [0, "09:00", "MCO", "Moody's Corporation", 2026, 3, "published", 3688, 9020, 0.7],
  [0, "09:00", "NEE", "NextEra Energy", 2026, 3, "published", 3654, 8672, 0.78],
  [0, "09:00", "ORRF", "ORRSTOWN FINANCIAL SERVICES INC", 2026, 4, "published", 2098, 4721, 0.74],
  [0, "09:00", "SSB", "SouthState Bank Corp", null, null, "capturing", null, null, null],
  [0, "10:30", "MHO", "M/I HOMES, INC.", 2026, 3, "published", 2015, 4962, -0.25],
  [0, "10:30", "UAL", "United Airlines Holdings", 2026, 3, "published", 3752, 10909, 0.55],
  [0, "10:44", "TDY", "Teledyne Technologies", null, 3, "published", 2956, 6201, 0.82],
  [0, "11:00", "AMX", "AMERICA MOVIL SAB DE CV/", 2026, 3, "published", 2699, 5631, 0.55],
  [0, "11:30", "ALK", "ALASKA AIR GROUP, INC.", 2026, 3, "published", 3181, 8576, -0.25],
  [0, "16:30", "CSX", "CSX Corporation", 2026, 3, "discovered", null, null, null],
  [0, "16:30", "KMI", "Kinder Morgan", 2026, 3, "discovered", null, null, null],
  [0, "16:30", "LVS", "Las Vegas Sands", 2026, 3, "discovered", null, null, null],
  [0, "16:30", "META", "Meta Platforms, Inc.", 2026, 3, "discovered", null, null, null],
  [0, "16:30", "TXN", "Texas Instruments", 2026, 3, "discovered", null, null, null],
  [0, "16:45", "CCI", "Crown Castle", 2026, 3, "discovered", null, null, null],
  [0, "17:00", "IBM", "IBM", 2026, 3, "discovered", null, null, null],
  [0, "17:00", "QS", "QuantumScape Corp", 2026, 3, "discovered", null, null, null],
  [0, "17:00", "SEIC", "SEI INVESTMENTS CO", null, null, "discovered", null, null, null],
  [0, "17:00", "WDFC", "WD 40 CO", 2026, 4, "discovered", null, null, null],
  [0, "17:30", "KNX", "Knight-Swift Transportation Holdings Inc.", 2026, 3, "discovered", null, null, null],
  [0, null, "DHR", "Danaher Corporation", 2026, 2, "discovered", null, null, null],
  [0, null, "NTRS", "Northern Trust", 2026, 3, "discovered", null, null, null],
  [0, null, "ONB", "OLD NATIONAL BANCORP /IN/", 2026, 3, "discovered", null, null, null],
  [0, null, "PM", "Philip Morris International", 2026, 3, "failed", null, null, null],
  [1, "08:00", "CURB", "Curbline Properties Corp.", 2026, 3, "discovered", null, null, null],
  [1, "08:00", "DOW", "Dow Inc.", 2026, 3, "discovered", null, null, null],
  [1, "08:00", "MOH", "MOLINA HEALTHCARE, INC.", 2026, 3, "discovered", null, null, null],
  [1, "08:00", "NDAQ", "Nasdaq, Inc.", 2026, 3, "discovered", null, null, null],
  [1, "08:00", "ROP", "Roper Technologies", 2026, 3, "discovered", null, null, null],
  [1, "08:00", "SPOT", "Spotify Technology S.A.", null, 3, "discovered", null, null, null],
  [1, "08:00", "THRM", "Gentherm Inc", 2026, 3, "discovered", null, null, null],
  [1, "08:30", "BFH", "BREAD FINANCIAL HOLDINGS, INC.", 2026, 3, "discovered", null, null, null],
  [1, "08:30", "CCZ", "COMCAST CORP", 2026, 3, "discovered", null, null, null],
  [1, "08:30", "DGX", "Quest Diagnostics", 2026, 3, "discovered", null, null, null],
  [1, "08:30", "HON", "Honeywell Technologies", 2026, 3, "discovered", null, null, null],
  [1, "08:30", "LMT", "Lockheed Martin", 2026, 3, "discovered", null, null, null],
  [1, "08:30", "PG", "PROCTER & GAMBLE Co", 2027, 1, "discovered", null, null, null],
  [1, "08:30", "PHM", "PulteGroup", 2026, 3, "discovered", null, null, null],
  [1, "08:30", "STC", "STEWART INFORMATION SERVICES CORP", 2026, 3, "discovered", null, null, null],
  [1, "08:30", "URI", "United Rentals", 2026, 3, "discovered", null, null, null],
  [1, "08:30", "WCN", "Waste Connections, Inc.", 2026, 3, "discovered", null, null, null],
  [1, "08:30", "WH", "WYNDHAM HOTELS & RESORTS, INC.", 2026, 3, "discovered", null, null, null],
  [1, "09:00", "BX", "Blackstone Inc.", 2026, 3, "discovered", null, null, null],
  [1, "09:00", "FRMEP", "FIRST MERCHANTS CORP", 2026, 3, "discovered", null, null, null],
  [1, "09:00", "LOB", "Live Oak Bancshares, Inc.", 2026, 3, "discovered", null, null, null],
  [1, "09:00", "MEDP", "Medpace Holdings, Inc.", 2026, 3, "discovered", null, null, null],
  [2, "08:00", "BAH", "Booz Allen Hamilton Holding Corp", 2027, 2, "discovered", null, null, null],
  [2, "08:00", "RITM", "Rithm Capital Corp.", 2026, 3, "discovered", null, null, null],
  [2, "08:30", "AXP", "AMERICAN EXPRESS CO", 2026, 3, "discovered", null, null, null],
  [2, "09:00", "EBC", "Eastern Bankshares, Inc.", 2026, 3, "discovered", null, null, null],
  [2, "09:00", "FCNCA", "FIRST CITIZENS BANCSHARES INC /DE/", 2026, 3, "discovered", null, null, null],
  [2, "09:00", "HTH", "Hilltop Holdings Inc.", null, 3, "discovered", null, null, null],
  [2, "09:00", "PINE", "Alpine Income Property Trust, Inc.", 2026, 3, "discovered", null, null, null],
  [2, "09:30", "FIBK", "FIRST INTERSTATE BANCSYSTEM INC", 2026, 3, "discovered", null, null, null],
  [2, "09:30", "GNTX", "GENTEX CORP", 2026, 3, "discovered", null, null, null],
  [2, "10:00", "EAF", "GRAFTECH INTERNATIONAL LTD", 2026, 3, "discovered", null, null, null],
  [2, "10:00", "ORC", "Orchid Island Capital, Inc.", 2026, 3, "discovered", null, null, null],
  [2, "11:00", "FIX", "Comfort Systems USA", 2026, 3, "discovered", null, null, null],
];

/** META's calls before today's, newest first, as production lists them. */
const META_PAST: Array<[callAt: string, year: number | null, quarter: number, seconds: number | null, words: number, tone: number]> = [
  ["2026-07-29T20:30:00Z", null, 2, 3792, 10431, 0.82],
  ["2026-04-29T21:30:00Z", 2026, 1, null, 9991, 0.82],
  ["2026-01-28T21:30:00Z", 2025, 4, null, 9830, 0.82],
  ["2025-10-29T20:30:00Z", 2025, 3, null, 9480, 0.82],
  ["2025-07-30T21:00:00Z", 2025, 2, null, 9424, 0.82],
  ["2025-04-30T21:00:00Z", 2025, 1, null, 9164, 0.72],
  ["2025-01-29T22:00:00Z", 2024, 4, null, 9346, 0.85],
  ["2024-10-30T21:00:00Z", 2024, 3, null, 8935, 0.78],
];

const NEW_YORK_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const NEW_YORK_CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The instant of `clock` on New York's `date`, or its day alone at 00:00 UTC. */
function newYorkInstant(date: string, clock: string | null): string {
  if (!clock) return `${date}T00:00:00.000Z`;
  const [hour, minute] = clock.split(":").map(Number) as [number, number];
  // New York is four or five hours behind UTC; take the guess its clock reads back.
  for (const offset of [4, 5]) {
    const at = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour + offset, minute));
    if (NEW_YORK_CLOCK.format(at) === clock && NEW_YORK_DAY.format(at) === date) return at.toISOString();
  }
  return `${date}T${clock}:00.000Z`;
}

function dayCalls(): Array<CloudEarningsCallPayload & { day: string }> {
  const today = NEW_YORK_DAY.format(new Date());
  return DAY_CALLS.map(([day, clock, ticker, companyName, fiscalYear, fiscalQuarter, status, seconds, words, tone]) => {
    const date = shiftDay(today, day);
    const published = status === "published";
    return {
      id: `${ticker}-${date}`, ticker, companyName, fiscalYear, fiscalQuarter, callAt: newYorkInstant(date, clock), status,
      durationSeconds: seconds, wordCount: words, hasTranscript: published, sentiment: published ? tone : null,
      webcastUrl: `https://example.invalid/${ticker.toLowerCase()}/webcast`, callTimeKnown: clock !== null, day: date,
    };
  });
}

/** What the calls list answers: the days asked for, a company's calls, or the shelf of transcripts. */
function callList(search: URLSearchParams): CloudEarningsCallPayload[] {
  const calls = dayCalls();
  const strip = ({ day: _day, ...call }: CloudEarningsCallPayload & { day: string }) => call;
  if (search.get("upcoming") === "true") {
    const from = search.get("from") ?? "";
    const to = search.get("to") ?? "9999-12-31";
    return calls.filter((call) => call.day >= from && call.day <= to).map(strip);
  }
  const ticker = search.get("ticker")?.toUpperCase();
  if (ticker) {
    const past = ticker === "META" ? META_PAST.map(([callAt, fiscalYear, fiscalQuarter, durationSeconds, wordCount, sentiment], index) => ({
      id: `META-past-${index}`, ticker: "META", companyName: "Meta Platforms, Inc.", fiscalYear, fiscalQuarter, callAt, status: "published",
      durationSeconds, wordCount, hasTranscript: true, sentiment, webcastUrl: "https://example.invalid/meta/webcast",
    })) : [];
    return [...calls.filter((call) => call.ticker === ticker).map(strip), ...past];
  }
  // The shelf: transcribed calls, newest first.
  return calls.filter((call) => call.hasTranscript).map(strip).reverse();
}

/**
 * Gloom Cloud for the Calls pane: signed in on Pro, the invented shelf and
 * transcript, and the recording at `audio` (a call without one with `none`).
 * With `calls`, the production-like day of calls above instead.
 */
function installCallFetches(params: URLSearchParams): void {
  const audio = params.get("audio") ?? "none";
  const production = params.has("calls");
  apiClient.setSessionToken("fixture-session");
  apiClient.restoreCachedUser({
    id: "fixture-user", name: "Fixture", email: "fixture@example.invalid", emailVerified: true, plan: "pro", effectivePlan: "pro",
  } as never);
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/audio")) {
      return audio === "none"
        ? Response.json({ message: "No recording for this call." }, { status: 404 })
        : Response.json({ kind: "recording", url: audio, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), durationSeconds: 240 });
    }
    if (path.includes("/transcripts/")) return Response.json(CALL_TRANSCRIPT);
    if (path.endsWith("/transcripts")) return Response.json({ calls: production ? callList(new URL(String(url)).searchParams) : CALLS });
    return Response.json({ message: "Not in the fixture" }, { status: 404 });
  });
}

const RUNTIME = createTestPluginRuntime();

function CallsFixturePane(props: PaneProps) {
  return (
    <PluginRenderProvider pluginId="research" runtime={RUNTIME}>
      <EarningsCallsPane {...props} />
    </PluginRenderProvider>
  );
}

function TrialsFixturePane(props: PaneProps) {
  return (
    <PluginRenderProvider pluginId="clinical-trials" runtime={RUNTIME}>
      <TrialsPane {...props} />
    </PluginRenderProvider>
  );
}

const ChangelogPane = changelogModule.panes![0]!.component;

function ChangelogFixturePane(props: PaneProps) {
  return (
    <PluginRenderProvider pluginId="changelog" runtime={RUNTIME}>
      <ChangelogPane {...props} />
    </PluginRenderProvider>
  );
}

/** A document as Search opens one: sections under their headings, key facts above them, the match marked in one. */
const ARTICLE = parseArticle([
  { heading: "Results", text: Array.from({ length: 4 }, (_, index) => SENTENCES.slice(index % 3).join(" ")).join("\n\n") },
  { heading: "Outlook", text: Array.from({ length: 4 }, (_, index) => SENTENCES.slice((index + 1) % 3).join(" ")).join("\n\n") },
]);
const FACTS = ["Enrolment of 240 participants at four sites", "Results expected 12 months after the last visit", "Distance walked up 18% at twelve weeks"];

function ReaderFixturePane({ focused, width, height }: PaneProps) {
  return (
    <ArticleReader
      articleKey="invented"
      title="An invented story about a workshop that builds instruments"
      meta={["Workshop News", "Oct 12, 2026"]}
      lead={SENTENCES.slice(0, 2).join(" ")}
      facts={FACTS}
      body={ARTICLE}
      highlight={{ section: 1, terms: ["outcome"] }}
      focused={focused}
      width={width}
      height={height}
    />
  );
}

function MarkdownFixturePane({ width }: PaneProps) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  return (
    <DetailScrollBody ref={scrollRef}>
      <MarkdownText text={RELEASE_BODY} lineWidth={Math.max(12, width - 2)} />
    </DetailScrollBody>
  );
}

function ProseFixturePane({ width }: PaneProps) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  return (
    <DetailScrollBody ref={scrollRef}>
      <Box flexDirection="column" gap={1}>
        {Array.from({ length: 4 }, (_, index) => <Prose key={index} text={[...SENTENCES, ...SENTENCES].slice(index).join(" ")} width={Math.max(12, width - 2)} />)}
        <BulletList items={SENTENCES} width={Math.max(12, width - 2)} />
      </Box>
    </DetailScrollBody>
  );
}

type InlineRow = SectionedRow<{ id: string; key: string; does: string }>;
const INLINE_ROWS: InlineRow[] = buildSectionedRows([
  { label: "Start here", items: SENTENCES.slice(0, 4).map((does, index) => ({ id: `s${index}`, key: `K${index}`, does })) },
  { label: "More keys", items: SENTENCES.slice(2).map((does, index) => ({ id: `m${index}`, key: `M${index}`, does })) },
], (item) => item.id);
const INLINE_COLUMNS = [
  { id: "key", label: "KEY", width: 8, align: "left" as const },
  { id: "does", label: "DOES", width: 20, align: "left" as const, flexGrow: 1 },
];
/** Words that run a few characters past a count of cells, and fit the pixels those cells take. */
const valueFor = (columns: number, index: number) => `${SENTENCES[index % SENTENCES.length]} ${SENTENCES[(index + 1) % SENTENCES.length]}`.slice(0, Math.max(4, columns + 3)).trimEnd();

/**
 * A page that sets things inline, as Help, the account plans and executive
 * pay do: prose, a table as tall as its rows, label and value rows, prose.
 */
function InlineFixturePane({ width }: PaneProps) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const { nativePaneChrome } = useUiCapabilities();
  const inner = Math.max(12, width - 2);
  const tableHeight = sectionedRowsHeight(INLINE_ROWS);
  return (
    <DetailScrollBody ref={scrollRef}>
      <Box flexDirection="column" gap={1}>
        <Prose text={SENTENCES.slice(0, 2).join(" ")} width={inner} />
        <Box flexDirection="column" height={nativePaneChrome ? undefined : tableHeight}>
          <DataTableView<InlineRow>
            columns={INLINE_COLUMNS}
            items={INLINE_ROWS}
            selection={{ kind: "none" }}
            rootWidth={inner}
            rootHeight={tableHeight}
            horizontalPadding={0}
            virtualize={false}
            fitRows
            sortColumnId={null}
            sortDirection="asc"
            getItemKey={(row) => row.key}
            renderSectionHeader={renderSectionedRowHeader}
            renderCell={(row, column) => (isSectionedItemRow(row) ? { text: column.id === "key" ? row.item.key : row.item.does } : { text: "" })}
            emptyStateTitle="Nothing"
          />
        </Box>
        <Box flexDirection="column">
          {Array.from({ length: 5 }, (_, index) => (
            <KeyValueRow key={index} label={`Field ${index + 1}`} value={valueFor(inner - 12, index)} width={inner} labelWidth={12} />
          ))}
        </Box>
        <Prose text={SENTENCES.slice(3).join(" ")} width={inner} />
      </Box>
    </DetailScrollBody>
  );
}

interface ListRow { id: string; name: string; value: string }
const LIST_ROWS: ListRow[] = Array.from({ length: 24 }, (_, index) => ({
  id: `r${index}`,
  name: `Invented series ${index + 1}`,
  value: (100 + index * 3.7).toFixed(1),
}));
const LIST_RANGE = { value: "1y", options: [{ value: "1y", label: "1Y" }, { value: "5y", label: "5Y" }], onChange: () => {} };
const listMatches = (row: ListRow, query: string) => row.name.toLowerCase().includes(query);
const listColumns = (width: number) => [
  { id: "name", label: "SERIES", width: Math.max(8, width - 12), align: "left" as const },
  { id: "value", label: "LAST", width: 8, align: "right" as const },
];

/**
 * A series list beside its detail under a query bar, as the economic
 * statistics, GPU history and market valuation panes lay it out: the bar is
 * taller than a row on the desktop, and the list and detail end at the footer.
 */
function ListDetailFixturePane({ focused, width, height }: PaneProps) {
  const [selectedId, setSelectedId] = useState("r0");
  const list = useSeriesList({ focused, items: LIST_ROWS, getId: (row) => row.id, matchesQuery: listMatches, selectedId, onSelect: setSelectedId, reload: () => {}, range: LIST_RANGE });
  return (
    <SeriesListDetail
      list={list}
      width={width}
      height={height}
      focused={focused}
      listWidth={40}
      searchPlaceholder="filter series"
      columns={listColumns}
      rows={list.visible}
      getRowId={(row) => row.id}
      renderCell={(row, column) => ({ text: column.id === "name" ? row.name : row.value })}
      emptyStateTitle="No series"
      renderDetail={(size) => (
        <Box flexDirection="column" paddingX={1}>
          <Prose text={[...SENTENCES, ...SENTENCES, ...SENTENCES].join(" ")} width={Math.max(12, size.width - 2)} />
        </Box>
      )}
    />
  );
}

export const LAYOUT_PANES = {
  inline: { name: "Inline", component: InlineFixturePane },
  list: { name: "List and detail", component: ListDetailFixturePane },
  trials: { name: "Trials", component: TrialsFixturePane },
  changelog: { name: "Changelog", component: ChangelogFixturePane },
  calls: { name: "Earnings Calls", component: CallsFixturePane },
  reader: { name: "Reader", component: ReaderFixturePane },
  markdown: { name: "Markdown", component: MarkdownFixturePane },
  prose: { name: "Prose", component: ProseFixturePane },
};

/** One pane, docked alone or floating over an empty dock at a size off the cell grid. */
export function layoutLayout(params: URLSearchParams): LayoutConfig {
  const paneId = params.get("pane") ?? "trials";
  const instanceId = `${paneId}:layout`;
  // The Calls pane opens on the newest call's transcript, as a layout can ask it to;
  // `calls=calendar` opens it alone, and `calls=<ticker>` on that company's calls.
  const production = paneId === "calls" ? params.get("calls") : null;
  const settings = paneId === "calls" && !production ? { quarter: "latest", reader: params.get("reader") ?? "transcript" } : undefined;
  const binding = production && production !== "calendar" ? { kind: "fixed" as const, symbol: production } : { kind: "none" as const };
  const instance = { instanceId, paneId, binding, ...(settings ? { settings } : {}) };
  if (params.get("mode") !== "float") return { dockRoot: { kind: "pane", instanceId }, instances: [instance], floating: [], detached: [] };
  const columns = window.innerWidth / WEB_CELL_WIDTH;
  const rows = window.innerHeight / WEB_CELL_HEIGHT;
  return {
    dockRoot: null,
    instances: [instance],
    floating: [{ instanceId, x: 2.5, y: 2.25, width: Math.round(columns * 78) / 100 + 0.37, height: Math.round(rows * 78) / 100 + 0.41, zIndex: 50 }],
    detached: [],
  } as LayoutConfig;
}
