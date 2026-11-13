import type { HeadlessPaneContext, HeadlessPaneOptionDef } from "./headless";

/** What covers a pane when a report of it is refused: see `PaneDef.reportLockNote`. */
export interface PaneLock {
  /** Sign-in is the wall of a session that is missing or unverified; pro the one of a plan without access. */
  gate: "sign-in" | "pro";
  /** The first symbol the report was asked for, or null. */
  symbol: string | null;
  /** The function code the report was run for, for a pane that serves several (EM and GUID). */
  token?: string;
  /** The session is signed in and its email is not verified yet. */
  verifyEmail?: boolean;
  /** The text the report was asked with, for a pane whose argument is free text (ASKG's question). */
  argument?: string;
  /**
   * The functions the catalog finds for a question, best first, up to
   * `limit`, with the command that runs each: what a note can offer in place
   * of the locked pane. Absent where no catalog is at hand.
   */
  functionsFor?(question: string, limit: number): Promise<Array<{ code: string; label: string; command: string }>>;
  /**
   * Reads data as the report does, so a note can check that a free route it
   * would name has data for the symbol before naming it. Absent where nothing
   * can be read.
   */
  context?: HeadlessPaneContext;
}

/**
 * An option of a rendered-view report, which sets the pane setting of its key,
 * or of `settingKey` when the flag reads better than the setting's name
 * (`--columns` for `optionColumnIds`); with `pluginState`, the pane state the
 * view reads it from (a workspace's tab), and the setting too when it also
 * names a `settingKey`.
 */
export interface PaneReportOptionDef extends HeadlessPaneOptionDef {
  /** The value's name in the catalog's flag, `--currencies <codes>`; the type when absent. */
  placeholder?: string;
  /** The option in use as typed after the function, such as `--currencies USD,ZAR,NGN`; the catalog shows it as an example. */
  example?: string;
  /** Checks a typed value and returns it as the pane reads it; throws an Error that names what is wrong. */
  normalize?(value: string): string;
}
