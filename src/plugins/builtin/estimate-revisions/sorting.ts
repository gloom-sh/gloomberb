import type {
  EstimateObservation,
  EstimatePeriod,
  EstimateSurprise,
} from "../../../api-client/estimate-revisions";

export interface EstimateSort {
  column: string;
  direction: "asc" | "desc";
}

export function nextEstimateSort(
  previous: EstimateSort,
  column: string,
): EstimateSort {
  return {
    column,
    direction:
      previous.column === column && previous.direction === "desc"
        ? "asc"
        : "desc",
  };
}

function ordered<T>(
  rows: readonly T[],
  sort: EstimateSort,
  value: (row: T) => string | number | null,
  identity: (row: T) => string,
): T[] {
  return [...rows].sort((a, b) => {
    const left = value(a),
      right = value(b);
    const leftMissing =
      left == null || (typeof left === "number" && !Number.isFinite(left));
    const rightMissing =
      right == null || (typeof right === "number" && !Number.isFinite(right));
    if (leftMissing || rightMissing)
      return leftMissing
        ? rightMissing
          ? identity(a).localeCompare(identity(b))
          : 1
        : -1;
    return (
      (left! < right! ? -1 : left! > right! ? 1 : 0) *
        (sort.direction === "asc" ? 1 : -1) ||
      identity(a).localeCompare(identity(b))
    );
  });
}

export function sortEstimateHistory(
  rows: readonly EstimateObservation[],
  sort: EstimateSort,
): EstimateObservation[] {
  return ordered(
    rows,
    sort,
    (row) => {
      switch (sort.column) {
        case "average":
        case "low":
        case "high":
        case "analysts":
        case "source":
          return row[sort.column];
        default:
          return row.date;
      }
    },
    (row) => `${row.date}:${row.source}`,
  );
}

export function sortEstimateSurprises(
  rows: readonly EstimateSurprise[],
  sort: EstimateSort,
): EstimateSurprise[] {
  return ordered(
    rows,
    sort,
    (row) => {
      switch (sort.column) {
        case "dateType":
        case "currency":
        case "estimate":
        case "actual":
        case "percent":
        case "percentile":
          return row[sort.column];
        default:
          return row.date;
      }
    },
    (row) => `${row.date}:${row.dateType}:${row.currency ?? ""}`,
  );
}

export function sortGuidanceSources(
  rows: readonly EstimatePeriod[],
  sort: EstimateSort,
): EstimatePeriod[] {
  return sort.column === "source"
    ? ordered(
        rows,
        sort,
        (row) => (row.current ? "Current" : "Collected"),
        (row) => row.id,
      )
    : [...rows];
}
