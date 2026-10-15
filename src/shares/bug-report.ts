import type { PluginTarget } from "../types/plugin";

/** The public chat channel bug reports go to. */
export const BUG_REPORT_CHANNEL_ID = "bugs";
/** One line: what went wrong. The rest of the message is the pane and the app. */
const BUG_REPORT_MAX_CHARS = 300;

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

/** What a report says besides the line: the pane, the app version and where it runs, `GP AAPL · v0.17.3 · desktop`. */
export function bugReportContextLine({ paneLabel, version, surface }: BugReportContext): string {
  return `${paneLabel} · v${version} · ${SURFACE_NAMES[surface]}`;
}

/** The person's line as it is posted: one line, cut to the limit. */
export function bugReportLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, BUG_REPORT_MAX_CHARS).trim();
}

/** The message a report posts to #bugs, under the person's own account, with the pane's picture attached. */
export function bugReportMessage(text: string, context: BugReportContext): string {
  return `${bugReportLine(text)}\n\nPane: ${bugReportContextLine(context)}`;
}
