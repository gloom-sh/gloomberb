export type EconImpact = "high" | "medium" | "low";

export interface EconEvent {
  id: string;
  date: Date;
  time: string; // "08:30" or "All Day"
  country: string; // "US", "GB", etc.
  event: string;
  actual: string | null;
  forecast: string | null;
  prior: string | null;
  impact: EconImpact;
  /**
   * Rows Gloom Cloud adds beside its feeds: a central bank's kept decision or
   * a statistics office's listed release. The feeds' own rows carry none of
   * the fields below.
   */
  kind?: "central-bank-decision" | "statistics-release";
  /** The publisher's own clock time and its IANA zone; null when it states no time. */
  localTime?: string | null;
  timeZone?: string;
  /** Why a row has no time, when its publisher states none. */
  timeNote?: string | null;
  /** The day the prior level was observed. */
  priorAsOf?: string | null;
  /** The period a release covers, as its publisher names it. */
  referencePeriod?: string | null;
  /** Who publishes it (Freddie Mac for the 30-year mortgage rate), and its page when one is named. */
  source?: { name: string; url?: string };
}

/** Whether a row's time is blank because its publisher states none (a bank whose calendar gives the day only). */
export function hasNoStatedTime(event: Pick<EconEvent, "timeNote">): boolean {
  return typeof event.timeNote === "string" && event.timeNote.length > 0;
}
