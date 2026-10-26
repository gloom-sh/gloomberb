import { ApiRequestError } from "../../../api-client/errors";
import type {
  ScannerFlowEvent,
  ScannerFlowHistoryPage,
  ScannerFlowPayload,
  ScannerFlowSession,
  ScannerHiloPayload,
  ScannerKind,
  ScannerPayload,
} from "../../../api-client";
import type {
  HeadlessBundleSection,
  HeadlessPaneApiClient,
  HeadlessPaneColumn,
  HeadlessPaneDefinition,
  HeadlessPaneFreshness,
  HeadlessPaneLoadArgs,
  HeadlessPaneOptionDef,
  HeadlessSnapshotResult,
} from "../../../types/plugin";
import {
  DEFAULT_FLOW_FILTERS,
  FLOW_FILTER_OPTIONS,
  filterFlowEvents,
  flowHistoryQuery,
  flowHistorySearch,
  flowScopeSymbol,
  flowSessionSearch,
  formatFlowPremium,
  formatFlowVolOi,
  mergeFlowRows,
  type FlowFilters,
  type FlowScope,
} from "./flow-model";
import { flowStrikeRows, flowTideMoves, flowTideRows, formatSignedFlowPremium } from "./flow-session";
import { signalWithTimeout } from "../../../utils/async-deadline";
import { errorMessage } from "../../../utils/errors";
import { explainRefusal, refusedLock } from "../shared/cloud-denied";
import { captureScannerEvent, SCANNER_SNAPSHOT_TIMEOUT_MS } from "../shared/scanner-capture";
import { flowLockNote } from "./lock-note";
import { buildHiloBarRows, filterHiloRows, formatHiloPrice, type HiloMinPrice, type HiloSort } from "./hilo-model";

function loadScannerSnapshot<T extends ScannerPayload>(
  client: Pick<HeadlessPaneApiClient, "subscribeScanner">,
  scanner: ScannerKind,
  signal: AbortSignal,
  timeoutMs = SCANNER_SNAPSHOT_TIMEOUT_MS,
): Promise<T> {
  return captureScannerEvent(client, scanner, signal, timeoutMs).then((event) => {
    if (event.type !== "denied") return event.payload as T;
    // The refusal a read gets from the server: 402 for a plan without access, 401 for no session.
    throw event.reason === "pro_required"
      ? new ApiRequestError("Pro access required", 402)
      : new ApiRequestError("Sign in required", 401);
  });
}

export function loadHiloSnapshot(
  client: Pick<HeadlessPaneApiClient, "subscribeScanner">,
  signal: AbortSignal,
  timeoutMs = SCANNER_SNAPSHOT_TIMEOUT_MS,
): Promise<ScannerHiloPayload> {
  return loadScannerSnapshot<ScannerHiloPayload>(client, "hilo", signal, timeoutMs);
}

/**
 * The scanner says which instance served it, real-time or the delayed one free
 * accounts get, and whether it is running: a closed session's scan is final,
 * and a degraded one may have fallen behind.
 */
function scannerFreshness(payload: Pick<ScannerHiloPayload, "access" | "delayMinutes" | "status">): HeadlessPaneFreshness {
  if (payload.status === "closed") return { status: "not-a-feed", basis: "closed session" };
  if (payload.status === "degraded") return { status: "stale" };
  return payload.access === "realtime" ? { status: "live" } : { status: "delayed", delayMinutes: payload.delayMinutes };
}

function projectHiloSnapshot(
  payload: ScannerHiloPayload,
  minPrice: HiloMinPrice,
  sort: HiloSort,
): HeadlessSnapshotResult {
  const lows = filterHiloRows(payload.lows, minPrice, sort).map((row) => ({ side: "low", ...row }));
  const highs = filterHiloRows(payload.highs, minPrice, sort).map((row) => ({ side: "high", ...row }));
  return {
    asOf: new Date(payload.asOf).toISOString(),
    items: [...lows, ...highs],
    ...(payload.status === "degraded" ? { errors: ["Scanner feed degraded"] } : {}),
    freshness: scannerFreshness(payload),
    metadata: {
      ...(payload.access === "delayed" ? { notices: [`Delayed ${payload.delayMinutes} minutes`] } : {}),
      status: payload.status,
      access: payload.access,
      delayMinutes: payload.delayMinutes,
      windows: buildHiloBarRows(payload.windows),
      minPrice,
      sort,
    },
  };
}

export interface HiloHeadlessDependencies {
  load(
    args: HeadlessPaneLoadArgs,
    client: Pick<HeadlessPaneApiClient, "subscribeScanner">,
    signal: AbortSignal,
  ): Promise<ScannerHiloPayload>;
}

const defaultDependencies: HiloHeadlessDependencies = {
  load: (_args, client, signal) => loadHiloSnapshot(client, signal),
};

export function createHiloHeadless(
  dependencies: HiloHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"snapshot"> {
  return {
    shape: "snapshot",
    argument: { kind: "none" },
    options: [
      {
        key: "minPrice",
        aliases: ["min-price"],
        settingKey: "minPrice",
        description: "Minimum stock price.",
        type: "enum",
        values: [{ value: "off" }, { value: "1" }, { value: "5" }],
        defaultValue: "1",
      },
      {
        key: "sort",
        settingKey: "sort",
        description: "Extreme ordering.",
        type: "enum",
        values: [{ value: "recent" }, { value: "count" }],
        defaultValue: "recent",
      },
    ],
    columns: [
      { key: "side", header: "Side" },
      { key: "symbol", header: "Symbol" },
      { key: "price", header: "Price", align: "right", format: (value: unknown) => typeof value === "number" ? formatHiloPrice(value) : "" },
      { key: "count", header: "Count", align: "right" },
      {
        key: "at",
        header: "Observed at",
        format: (value: unknown) => {
          const time = Number(value);
          return Number.isFinite(time) ? `${new Date(time).toISOString().slice(0, 19).replace("T", " ")} UTC` : "-";
        },
      },
    ],
    describe: "New Highs / Lows",
    async load(args, ctx) {
      const payload = await dependencies.load(args, ctx.apiClient, ctx.signal);
      return projectHiloSnapshot(
        payload,
        args.options.minPrice as HiloMinPrice,
        args.options.sort as HiloSort,
      );
    },
  };
}

export const hiloHeadless = createHiloHeadless();

/** The pane's own filters, minus the watchlist universe that needs local lists. */
type FlowHeadlessFilterKey = Exclude<keyof FlowFilters, "universe">;

const FLOW_OPTION_DESCRIPTIONS: Record<FlowHeadlessFilterKey, string> = {
  minPremium: "Minimum print premium in dollars.",
  side: "Contract side.",
  kind: "Print kind.",
  volOi: "Day volume to open interest floor.",
  expiry: "Expiry window in days.",
};

const FLOW_OPTION_ALIASES: Partial<Record<FlowHeadlessFilterKey, string[]>> = {
  minPremium: ["min-premium"],
  volOi: ["vol-oi"],
};

function flowOption(key: FlowHeadlessFilterKey): HeadlessPaneOptionDef {
  return {
    key,
    ...(FLOW_OPTION_ALIASES[key] ? { aliases: FLOW_OPTION_ALIASES[key] } : {}),
    settingKey: key,
    description: FLOW_OPTION_DESCRIPTIONS[key],
    type: "enum",
    values: FLOW_FILTER_OPTIONS[key].map(({ value }) => ({ value })),
    defaultValue: DEFAULT_FLOW_FILTERS[key],
  };
}

/** The pane's tabs, each a section of the report; left out, the report has every one. */
type FlowReportTab = "prints" | "tide" | "strikes";

/** Recorded prints of one name a report lists under the live ones. */
const FLOW_REPORT_RECORDED = 100;

/** The side rule, said once in every report that sums prints by side. */
export const FLOW_SIDE_RULE = "Net premium counts a print at the ask as bought and one at the bid as sold; mid or unknown prints count as neither.";

const utcTime = (value: unknown) => {
  const time = Number(value);
  return Number.isFinite(time) ? `${new Date(time).toISOString().slice(0, 19).replace("T", " ")} UTC` : "-";
};
const signedPremium = (value: unknown) => typeof value === "number" ? formatSignedFlowPremium(value) : "";
/** A side's premium in the text view: `$2.1M`, blank where none traded. */
const premium = (value: unknown) => typeof value === "number" && value > 0 ? formatFlowPremium(value) : "";

const PRINT_COLUMNS: HeadlessPaneColumn[] = [
  { key: "at", header: "Time", format: utcTime },
  { key: "underlying", header: "Ticker" },
  { key: "right", header: "Right" },
  { key: "kind", header: "Kind" },
  { key: "strike", header: "Strike", align: "right" },
  { key: "expiry", header: "Expiry" },
  { key: "side", header: "Side" },
  { key: "size", header: "Size", align: "right" },
  { key: "premium", header: "Premium", align: "right", textFormat: premium },
  { key: "volOi", header: "Vol/OI", align: "right", textFormat: (value) => formatFlowVolOi(typeof value === "number" ? value : null) },
];

const TIDE_COLUMNS: HeadlessPaneColumn[] = [
  { key: "at", header: "Time", format: utcTime },
  { key: "callAsk", header: "Call ask", align: "right", description: "Call premium bought at the ask in the bucket." },
  { key: "callBid", header: "Call bid", align: "right", description: "Call premium sold at the bid in the bucket." },
  { key: "putAsk", header: "Put ask", align: "right", description: "Put premium bought at the ask in the bucket." },
  { key: "putBid", header: "Put bid", align: "right", description: "Put premium sold at the bid in the bucket." },
  { key: "netCalls", header: "Net calls", align: "right", textFormat: signedPremium, description: "Call ask less call bid premium through the bucket." },
  { key: "netPuts", header: "Net puts", align: "right", textFormat: signedPremium, description: "Put ask less put bid premium through the bucket." },
  { key: "net", header: "Net premium", align: "right", textFormat: signedPremium, description: "Net calls less net puts through the bucket: the tide." },
  { key: "change", header: "Change", align: "right", textFormat: signedPremium, description: "What the bucket added to the net premium." },
];
const TIDE_TEXT_COLUMNS = TIDE_COLUMNS.filter((column) => !["callAsk", "callBid", "putAsk", "putBid"].includes(column.key));

const STRIKE_COLUMNS: HeadlessPaneColumn[] = [
  { key: "expiry", header: "Expiry" },
  { key: "strike", header: "Strike", align: "right" },
  { key: "callPremium", header: "Calls", align: "right", textFormat: premium, description: "All call premium, mid and unknown prints included." },
  { key: "callAsk", header: "Call ask", align: "right", textFormat: premium },
  { key: "callBid", header: "Call bid", align: "right", textFormat: premium },
  { key: "putPremium", header: "Puts", align: "right", textFormat: premium, description: "All put premium, mid and unknown prints included." },
  { key: "putAsk", header: "Put ask", align: "right", textFormat: premium },
  { key: "putBid", header: "Put bid", align: "right", textFormat: premium },
  { key: "net", header: "Net", align: "right", textFormat: signedPremium, description: "Net call premium less net put premium at the strike." },
  { key: "prints", header: "Prints", align: "right" },
];

interface FlowReportData {
  payload: ScannerFlowPayload;
  /** One name's recorded prints below the live tape; null for the market. */
  recorded: ScannerFlowHistoryPage | null;
  /** The session's prints summed; null when the report leaves the tide and strikes out. */
  session: ScannerFlowSession | null;
}

/** Newest first, the buckets that moved the tide with the running totals through each, as the pane's table lists them. */
function tideReportRows(session: ScannerFlowSession | null): Array<Record<string, unknown>> {
  return flowTideMoves(flowTideRows(session)).reverse().map((row) => ({ ...row }));
}

function projectFlowReport(
  data: FlowReportData,
  filters: FlowFilters,
  scope: FlowScope,
  tab: FlowReportTab | null,
  now = Date.now(),
): { sections: HeadlessBundleSection[]; asOf: string; metadata: Record<string, unknown>; notes?: string[]; errors?: string[]; freshness: HeadlessPaneFreshness } {
  const { payload, recorded, session } = data;
  const symbol = scope.symbol ?? null;
  const live = filterFlowEvents(payload.events, filters, scope, now);
  const prints: ScannerFlowEvent[] = recorded ? mergeFlowRows(live, recorded.events) : live;
  const shows = (section: FlowReportTab) => !tab || tab === section;
  const sessionDate = session?.session ?? null;
  const sections: HeadlessBundleSection[] = [];
  if (shows("prints")) {
    sections.push({
      title: symbol ? `${symbol} prints` : "Prints",
      columns: PRINT_COLUMNS,
      rows: prints.map((event) => ({ ...event })),
      empty: symbol ? `No ${symbol} prints under these filters.` : "No prints on the tape under these filters.",
    });
  }
  if (shows("tide")) {
    sections.push({
      title: sessionDate ? `Net premium through the ${sessionDate} session` : "Net premium through the session",
      columns: TIDE_COLUMNS,
      textColumns: TIDE_TEXT_COLUMNS,
      rows: tideReportRows(session),
      unit: "USD",
      empty: "No prints under these filters this session.",
    });
  }
  if (symbol && shows("strikes")) {
    sections.push({
      title: sessionDate ? `${symbol} by expiry and strike, ${sessionDate}` : `${symbol} by expiry and strike`,
      columns: STRIKE_COLUMNS,
      rows: flowStrikeRows(session).map(({ id: _id, ...row }) => row),
      unit: "USD",
      empty: `No ${symbol} prints under these filters this session.`,
    });
  }
  const sums = shows("tide") || (!!symbol && shows("strikes"));
  return {
    sections,
    asOf: new Date(payload.asOf).toISOString(),
    ...(sums ? { notes: [FLOW_SIDE_RULE] } : {}),
    ...(payload.status === "degraded" ? { errors: ["Scanner feed degraded"] } : {}),
    freshness: scannerFreshness(payload),
    metadata: {
      status: payload.status,
      access: payload.access,
      delayMinutes: payload.delayMinutes,
      received: payload.events?.length ?? 0,
      filters,
      ...(symbol ? { symbol } : {}),
      ...(session ? { session: session.session, bucketMinutes: session.bucketMs / 60_000 } : {}),
    },
  };
}

interface FlowHeadlessDependencies {
  load(
    args: HeadlessPaneLoadArgs,
    client: Pick<HeadlessPaneApiClient, "subscribeScanner">,
    signal: AbortSignal,
  ): Promise<ScannerFlowPayload>;
  recorded(search: string, client: Pick<HeadlessPaneApiClient, "getScannerFlowHistory">, signal: AbortSignal): Promise<ScannerFlowHistoryPage>;
  session(search: string, client: Pick<HeadlessPaneApiClient, "getScannerFlowSession">, signal: AbortSignal): Promise<ScannerFlowSession>;
}

const flowDependencies: FlowHeadlessDependencies = {
  load: (_args, client, signal) => loadScannerSnapshot<ScannerFlowPayload>(client, "flow", signal),
  recorded: (search, client, signal) => client.getScannerFlowHistory(search, signalWithTimeout(signal, 20_000)),
  session: (search, client, signal) => client.getScannerFlowSession(search, signalWithTimeout(signal, 20_000)),
};

export function createFlowHeadless(
  dependencies: FlowHeadlessDependencies = flowDependencies,
): HeadlessPaneDefinition<"bundle"> {
  const keys: FlowHeadlessFilterKey[] = ["minPremium", "side", "kind", "volOi", "expiry"];
  return {
    shape: "bundle",
    argument: {
      kind: "ticker",
      optional: true,
      placeholder: "ticker",
      description: "Optional ticker: its prints and its premium by expiry and strike. Omit for the whole market.",
    },
    options: [
      ...keys.map(flowOption),
      {
        key: "tab",
        settingKey: "tab",
        description: "One section: the prints, the net-premium tide through the session, or a ticker's strikes. Every section when left out.",
        type: "enum",
        values: [{ value: "prints" }, { value: "tide" }, { value: "strikes" }],
      },
    ],
    describe: (args) => {
      const symbol = flowScopeSymbol(Array.isArray(args.argument) ? args.argument[0] : args.argument);
      return symbol ? `Options Flow: ${symbol}` : "Options Flow";
    },
    async load(args, ctx) {
      const symbol = flowScopeSymbol(Array.isArray(args.argument) ? args.argument[0] : args.argument);
      const tab = typeof args.options.tab === "string" && args.options.tab ? args.options.tab as FlowReportTab : null;
      if (tab === "strikes" && !symbol) throw new Error("--tab strikes needs a ticker: gloom fn FLOW <ticker> --tab strikes.");
      const filters: FlowFilters = {
        ...DEFAULT_FLOW_FILTERS,
        ...(args.options as Partial<FlowFilters>),
        universe: "active",
      };
      const scope: FlowScope = { symbol, watchlist: new Set() };
      const refuse = async (error: unknown): Promise<never> => {
        throw await explainRefusal(error, flowLockNote, { symbol, context: ctx });
      };
      // The live feed answers the entitlement first, as the pane's does.
      const payload = await dependencies.load(args, ctx.apiClient, ctx.signal).catch(refuse);
      // The recorded prints and the session's sums add to the tape: one that
      // fails (a timeout, a server without the route) is said under errors and
      // the rest of the report stands. A wall still refuses the whole read.
      const failures: string[] = [];
      const extra = async <T>(load: Promise<T> | null, what: string): Promise<T | null> => {
        if (!load) return null;
        try {
          return await load;
        } catch (error) {
          if (ctx.signal.aborted || refusedLock(error)) return refuse(error);
          failures.push(`${what} unavailable: ${errorMessage(error)}`);
          return null;
        }
      };
      const wantsPrints = !tab || tab === "prints";
      const wantsSession = !tab || tab === "tide" || tab === "strikes";
      const [recorded, session] = await Promise.all([
        extra(symbol && wantsPrints
          ? dependencies.recorded(flowHistorySearch(flowHistoryQuery(filters, scope, undefined, FLOW_REPORT_RECORDED)), ctx.apiClient, ctx.signal)
          : null, "Recorded prints"),
        extra(wantsSession ? dependencies.session(flowSessionSearch(filters, scope), ctx.apiClient, ctx.signal) : null, "Session totals"),
      ]);
      // Asked for the session's sums alone, a failure to read them is the report's.
      if (!wantsPrints && failures.length > 0) throw new Error(failures[0]);
      const report = projectFlowReport({ payload, recorded, session }, filters, scope, wantsSession && !session ? "prints" : tab);
      const errors = [...report.errors ?? [], ...failures];
      return {
        sections: report.sections,
        ...(report.notes ? { notes: report.notes } : {}),
        ...(errors.length > 0 ? { errors } : {}),
        ...(symbol ? { symbols: [symbol] } : {}),
        freshness: report.freshness,
        metadata: { asOf: report.asOf, ...report.metadata },
      };
    },
  };
}

export const flowHeadless = createFlowHeadless();
