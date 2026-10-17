/** Government bond curves stored from their official publishers, in percent. */
export type CloudCurveId = "us" | "us-real" | "us-breakeven" | "eu-aaa" | "de" | "gb" | "jp" | "ca";

export interface CloudCurvePoint {
  tenor: string;
  years: number;
  yield: number | null;
}

interface CloudCurveHeader {
  id: CloudCurveId;
  label: string;
  country: string;
  /** par: bonds priced at par; zero: spot rates; benchmark: named benchmark bonds; spread: nominal minus real. */
  basis: "par" | "zero" | "benchmark" | "spread";
  couponsPerYear: number;
}

export interface CloudCurveView {
  curve: CloudCurveHeader;
  requestedDate: string | null;
  /** The session the publisher dates the curve. */
  asOf: string;
  points: CloudCurvePoint[];
  lookbacks: Array<{ id: "1D" | "1W" | "1M"; requestedDate: string; asOf: string | null; points: CloudCurvePoint[] | null }>;
  spreads: Array<{
    id: string;
    short: string;
    long: string;
    /** Long minus short, percentage points. */
    value: number | null;
    change1d: number | null;
    percentile1y: number | null;
    observations1y: number;
  }>;
  /** Each tenor's 1D and 1W move ranked against its whole stored history; absent on servers older than it. */
  moves?: CloudCurveMove[];
  checkedAt: string | null;
}

/** How big a tenor's move into the session was, against every move of the same horizon through it. */
export interface CloudCurveMove {
  tenor: string;
  horizon: "1D" | "1W";
  /** The session the move is measured from (the day before, or seven days before, within ten days). */
  from: string | null;
  /** Percentage points. */
  change: number | null;
  /** Midrank percentile of the move's size, 0 to 100; null below a year of moves. */
  percentile: number | null;
  observations: number;
  /** The session the oldest ranked move ends on. */
  since: string | null;
}

/** One tenor of a stored curve over time, oldest first (`GET /cloud/econ/curves/:curve/history`). */
export interface CloudCurveHistory {
  curve: CloudCurveHeader;
  tenor: string;
  points: Array<{ date: string; value: number }>;
  checkedAt: string | null;
}

export interface CloudWorldCurves {
  curves: Array<{
    curve: CloudCurveHeader;
    asOf: string;
    points: CloudCurvePoint[];
    previous: { asOf: string; points: CloudCurvePoint[] } | null;
    checkedAt: string | null;
  }>;
}
