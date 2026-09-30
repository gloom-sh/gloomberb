/** Government bond curves stored from their official publishers, in percent. */
export type CloudCurveId = "us" | "us-real" | "us-breakeven" | "eu-aaa" | "de" | "gb" | "jp" | "ca";

export interface CloudCurvePoint {
  tenor: string;
  years: number;
  yield: number | null;
}

export interface CloudCurveHeader {
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
