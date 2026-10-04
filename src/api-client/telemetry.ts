import { withDeadline } from "../utils/async-deadline";
import type { CloudApiRequest } from "./request";
import { getCurrentPluginTarget } from "../plugins/current-target";
import { VERSION } from "../version";

/** A report is fire-and-forget; a slow uplink must not hold anything open for long. */
const REPORT_TIMEOUT_MS = 5_000;

export type CrashReportSurface = "terminal" | "desktop" | "web" | "mobile";
export type CrashReportKind = "uncaught" | "unhandled-rejection" | "render" | "plugin";

export interface CrashReportError {
  kind: CrashReportKind;
  type: string;
  message: string;
  stack?: string;
  plugin?: string;
  pane?: string;
}

/** Body of `POST /telemetry/errors`. The server forwards each error to error tracking. */
export interface CrashReportsPayload {
  installId: string;
  surface: CrashReportSurface;
  appVersion: string;
  os?: string;
  errors: CrashReportError[];
}

export type UsageCountsSurface = "terminal" | "desktop" | "web";

export type AttentionAction = "des" | "chart" | "quote" | "option_chain" | "watchlist_add";
export interface AttentionCountsPayload {
  consent: true;
  events: Array<{ symbol: string; action: AttentionAction }>;
}

/** One function's counts since the last batch; `fn` is its mnemonic, or `plugin`. */
export interface FunctionUsageCount {
  fn: string;
  opened: number;
  restored: number;
}

/** Body of `POST /telemetry/usage`. The server adds the plan and forwards each count to analytics. */
export interface UsageCountsPayload {
  installId: string;
  surface: UsageCountsSurface;
  appVersion: string;
  os?: string;
  counts: FunctionUsageCount[];
}

/** How one visit to the command bar ended. */
export type CommandSearchOutcome = "chosen" | "dismissed";

/** The row a command-bar search ended on. */
export interface CommandSearchChoice {
  /** The row's kind, or a tag for how it ran: `shortcut`, `assist`, `ask-gloom`. */
  kind: string;
  label: string;
  /** The command text that ran, for an AI candidate or a typed shortcut. */
  input?: string;
  /** Position in the list on screen, from 0. */
  rank: number;
  category?: string;
  /** The row was one of the AI's answers. */
  fromAssist: boolean;
}

/** Body of `POST /assist/searches`. */
export interface CommandSearchReport {
  query: string;
  /** The `/assist/command` answer for this same query, when there was one. */
  searchId?: string;
  outcome: CommandSearchOutcome;
  /** Only sent with `chosen`. */
  choice?: CommandSearchChoice;
  appVersion?: string;
}

/** Server caps for `/assist/searches`; text is cut here so a report is never refused for length. */
const SEARCH_QUERY_MAX_LENGTH = 200;
const SEARCH_KIND_MAX_LENGTH = 24;
const SEARCH_LABEL_MAX_LENGTH = 120;
const SEARCH_CATEGORY_MAX_LENGTH = 40;
const SEARCH_APP_VERSION_MAX_LENGTH = 32;
const SEARCH_RANK_MAX = 200;

/** One line of at most `max` characters. */
function fitText(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function fitCommandSearchChoice(choice: CommandSearchChoice): CommandSearchChoice {
  const input = choice.input ? fitText(choice.input, SEARCH_QUERY_MAX_LENGTH) : "";
  const category = choice.category ? fitText(choice.category, SEARCH_CATEGORY_MAX_LENGTH) : "";
  const rank = Number.isFinite(choice.rank) ? Math.round(choice.rank) : 0;
  return {
    kind: fitText(choice.kind, SEARCH_KIND_MAX_LENGTH),
    label: fitText(choice.label, SEARCH_LABEL_MAX_LENGTH),
    ...(input ? { input } : {}),
    rank: Math.min(Math.max(rank, 0), SEARCH_RANK_MAX),
    ...(category ? { category } : {}),
    fromAssist: choice.fromAssist,
  };
}

/** The report as the server takes it, or null when there is no query to send. */
function fitCommandSearchReport(report: CommandSearchReport): CommandSearchReport | null {
  const query = fitText(report.query, SEARCH_QUERY_MAX_LENGTH);
  if (!query) return null;
  const appVersion = report.appVersion ? fitText(report.appVersion, SEARCH_APP_VERSION_MAX_LENGTH) : "";
  return {
    query,
    ...(report.searchId ? { searchId: report.searchId } : {}),
    outcome: report.outcome,
    ...(report.outcome === "chosen" && report.choice ? { choice: fitCommandSearchChoice(report.choice) } : {}),
    ...(appVersion ? { appVersion } : {}),
  };
}

export class CloudTelemetryApi {
  constructor(private readonly request: CloudApiRequest) {}

  /** Authenticated first-party counts; never use the usage/crash install id. */
  reportAttentionCounts(payload: AttentionCountsPayload, signal: AbortSignal): Promise<void> {
    if (payload.consent !== true || signal.aborted) return Promise.resolve();
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    // Rebuild the allowlisted body so runtime extra properties cannot leak.
    const body: AttentionCountsPayload = {
      consent: true,
      events: payload.events.map(({ symbol, action }) => ({ symbol, action })),
    };
    return withDeadline(this.request<void>("/telemetry/attention", {
      method: "POST",
      body: JSON.stringify(body),
      ...(getCurrentPluginTarget() === "web" ? {} : { headers: { "User-Agent": `Gloomberb/${VERSION}` } }),
      signal: controller.signal,
    }), REPORT_TIMEOUT_MS, "Attention counts timed out.", abort)
      .finally(() => signal.removeEventListener("abort", abort));
  }

  /**
   * Sends a batch of app errors. The session goes along when one exists, so
   * a signed-in report is tied to the account; a signed-out one is identified
   * by the install id only. `keepalive` lets a browser finish the request
   * after the page unloads.
   */
  reportCrashErrors(payload: CrashReportsPayload): Promise<void> {
    const controller = new AbortController();
    return withDeadline(
      this.request<void>("/telemetry/errors", {
        method: "POST",
        body: JSON.stringify(payload),
        keepalive: true,
        signal: controller.signal,
      }),
      REPORT_TIMEOUT_MS,
      "Crash report timed out.",
      (error) => controller.abort(error),
    );
  }

  /**
   * Sends a batch of function usage counts. The server reads the plan from
   * the session and otherwise keeps the batch anonymous: it is filed under
   * the install id, never the account.
   */
  reportUsageCounts(payload: UsageCountsPayload): Promise<void> {
    const controller = new AbortController();
    return withDeadline(
      this.request<void>("/telemetry/usage", {
        method: "POST",
        body: JSON.stringify(payload),
        keepalive: true,
        signal: controller.signal,
      }),
      REPORT_TIMEOUT_MS,
      "Usage counts timed out.",
      (error) => controller.abort(error),
    );
  }

  /**
   * Stores how a command-bar search ended. The session goes along, since the
   * row is the account's; the caller checks it exists and that the Usage
   * setting allows the report.
   */
  reportCommandSearch(report: CommandSearchReport): Promise<void> {
    const body = fitCommandSearchReport(report);
    if (!body) return Promise.resolve();
    const controller = new AbortController();
    return withDeadline(
      this.request<void>("/assist/searches", {
        method: "POST",
        body: JSON.stringify(body),
        keepalive: true,
        signal: controller.signal,
      }),
      REPORT_TIMEOUT_MS,
      "Search report timed out.",
      (error) => controller.abort(error),
    );
  }
}
