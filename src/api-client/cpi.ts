/** US consumer prices by component, as GET /cloud/cpi/board serves them. */

export interface CpiRow {
  id: string;
  /** BLS item code; null for a row computed from two published ones (services ex shelter). */
  code: string | null;
  label: string;
  /** 0 at the top level. */
  depth: number;
  parent: string | null;
  /** All items and core, which stay on top whatever the sort. */
  pinned: boolean;
  derived: boolean;
  /** Relative importance of the month before, percent of all items. */
  weight: number | null;
  /** Seasonally adjusted change on the month, percent. */
  change: number | null;
  /** Seasonally adjusted change over three and six months, annualised, percent. */
  annualized3m: number | null;
  annualized6m: number | null;
  /** Unadjusted change over twelve months, percent. */
  yoy: number | null;
  /** Effect on the headline's monthly change, percentage points. */
  contribution: number | null;
  /** Effect on the headline's twelve-month change, percentage points. */
  contributionYoy: number | null;
  /** One plain sentence worked out from the numbers. */
  read: string | null;
  /** [YYYY-MM, change on the month, change over twelve months], oldest first. */
  history: Array<[string, number | null, number | null]>;
}

export interface CpiReleaseStatus {
  /** The month the board covers, YYYY-MM. */
  period: string | null;
  releasedAt: string | null;
  /** The month the weights refer to, YYYY-MM. */
  weightsPeriod: string | null;
  nextPeriod: string | null;
  nextReleaseAt: string | null;
}

export interface CpiBoardPayload {
  source: "BLS";
  generatedAt: string;
  /** When the index levels were last retrieved. */
  retrievedAt: string | null;
  status: "available" | "partial" | "unavailable";
  gaps: string[];
  release: CpiReleaseStatus;
  rows: CpiRow[];
}
