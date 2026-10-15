import type { PluginTarget } from "../types/plugin";
import { truncateWithEllipsis } from "../utils/text-wrap";

/** The public chat channel bug reports go to. */
export const BUG_REPORT_CHANNEL_ID = "bugs";
/** One line: what went wrong. The field takes no more, so nothing typed is cut. The rest of the message is the pane and the app. */
export const BUG_REPORT_MAX_CHARS = 300;
/** The pane's name in a report, as the form shows it and the message says it. */
const BUG_REPORT_PANE_LABEL_MAX_CHARS = 60;

const SURFACE_NAMES: Record<PluginTarget, string> = {
  tui: "terminal",
  cli: "terminal",
  desktop: "desktop",
  web: "web",
};

export interface BugReportContext {
  /** The pane by its function and what it shows, such as `GP AAPL`. */
  paneLabel: string;
  version: string;
  surface: PluginTarget;
}

/**
 * What a report says besides the line: the pane, the app version and where
 * it runs, `GP AAPL · v0.17.3 · desktop`. The form shows this same line
 * under the picture, so a long pane title is cut here, for both.
 */
export function bugReportContextLine({ paneLabel, version, surface }: BugReportContext): string {
  return `${truncateWithEllipsis(paneLabel, BUG_REPORT_PANE_LABEL_MAX_CHARS)} · v${version} · ${SURFACE_NAMES[surface]}`;
}

/** The person's line as it is posted: one line, cut to the limit. */
export function bugReportLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, BUG_REPORT_MAX_CHARS).trim();
}

/** The message a report posts to #bugs, under the person's own account, with the pane's picture attached. */
export function bugReportMessage(text: string, context: BugReportContext): string {
  return `${bugReportLine(text)}\n\nPane: ${bugReportContextLine(context)}`;
}
