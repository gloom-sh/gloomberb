/**
 * The feedback report the app sends to Gloom Cloud (`POST /feedback`) and the
 * summaries it reads back (`GET /feedback`). The server validates the same
 * limits, so keep the two sides in step.
 */

export type FeedbackSource = "tui" | "desktop" | "web" | "cli" | "mobile";

export type FeedbackStatus = "received" | "in_progress" | "resolved";

/** One styled run of a terminal row. Colours are `#rrggbb` or `#rrggbbaa`. */
export interface TerminalFrameSpan {
  t: string;
  fg?: string;
  bg?: string;
  /** OpenTUI `TextAttributes` bitmask. */
  a?: number;
}

export type FeedbackScreenshot =
  | { kind: "image"; mimeType: "image/jpeg" | "image/png"; data: string }
  | { kind: "terminal"; cols: number; rows: number; lines: TerminalFrameSpan[][] };

export interface FeedbackSubmitRequest {
  title: string;
  message: string;
  source: FeedbackSource;
  appVersion?: string;
  diagnostics?: Record<string, unknown>;
  logs?: string;
  screenshot?: FeedbackScreenshot;
}

export interface FeedbackSubmitResponse {
  id: string;
  status: "received";
  /** The verified account email the team will write to, when there is one. */
  replyTo: string | null;
}

export interface FeedbackReportSummary {
  id: string;
  title: string;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  latestReply: string | null;
}

export interface FeedbackListResponse {
  reports: FeedbackReportSummary[];
}

export const FEEDBACK_MESSAGE_MAX = 5000;
export const FEEDBACK_LOGS_MAX = 60_000;
/** Base64 characters; the server also caps decoded bytes at 520 KB. */
export const FEEDBACK_IMAGE_BASE64_MAX = 700_000;
export const FEEDBACK_FRAME_MAX_ROWS = 500;
export const FEEDBACK_FRAME_MAX_COLS = 1000;
