import { withDeadline } from "../utils/async-deadline";
import type { CloudApiRequest } from "./request";

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

export class CloudTelemetryApi {
  constructor(private readonly request: CloudApiRequest) {}

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
}
