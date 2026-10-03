import { apiClient } from "../../../api-client";
import type { DoeBoardPayload, DoeSeriesRow } from "../../../api-client/doe";
import { ApiRequestError } from "../../../api-client/errors";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource } from "../shared/cloud-resource";

/** What the pane says while the server has no EIA weeks to serve: before the backend ships, or before its first read. */
export const DOE_NOT_AVAILABLE = "Oil and gas inventories are not available yet.";

export const doeBoardCache = createPluginCache<DoeBoardPayload>({
  kind: "doe-board", source: "gloom-cloud", schemaVersion: 1,
  // Weekly data: a quarter hour is soon enough to catch a release.
  policy: { staleMs: 15 * 60_000, expireMs: 14 * 24 * 60 * 60_000 },
});

const UNITS = new Set(["kb", "kbd", "pct", "bcf"]);
const TABS = new Set(["crude", "products", "gas"]);
const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const dateOrNull = (value: unknown) => value === null || date(value);
const instantOrNull = (value: unknown) => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const finiteOrNull = (value: unknown) => value === null || finite(value);
const pairs = (value: unknown) => Array.isArray(value)
  && value.every((pair) => Array.isArray(pair) && Number.isInteger(pair[0]) && finite(pair[1]));

function validRow(row: DoeSeriesRow): boolean {
  const five = row.fiveYear, ago = row.yearAgo, seasonal = row.seasonal;
  return typeof row.id === "string" && typeof row.label === "string" && UNITS.has(row.unit) && TABS.has(row.tab)
    && dateOrNull(row.weekEnding) && finiteOrNull(row.value) && finiteOrNull(row.weekChange) && (row.value == null) === (row.weekEnding == null)
    && (row.read === null || typeof row.read === "string")
    && (ago === null || date(ago.weekEnding) && finite(ago.value) && finite(ago.change) && finiteOrNull(ago.changePercent))
    && (five === null || Array.isArray(five.years) && five.years.length > 0 && [five.min, five.max, five.average, five.vsAverage].every(finite)
      && five.min <= five.max && finiteOrNull(five.averageChange) && finiteOrNull(five.vsAveragePercent) && finiteOrNull(five.position))
    && (seasonal === null || Number.isInteger(seasonal.year) && (seasonal.weeks === 52 || seasonal.weeks === 53)
      && pairs(seasonal.current) && pairs(seasonal.previous) && Array.isArray(seasonal.band)
      && seasonal.band.every((week) => Array.isArray(week) && Number.isInteger(week[0]) && week.slice(1).every(finiteOrNull)));
}

/** A board that breaks the contract is refused whole rather than drawn with holes in it. */
function validateDoeBoard(payload: DoeBoardPayload): DoeBoardPayload {
  if (!payload || payload.source !== "EIA" || !Number.isFinite(Date.parse(payload.generatedAt))
    || !["available", "partial", "unavailable"].includes(payload.status)
    || !Array.isArray(payload.gaps) || !payload.gaps.every((gap) => typeof gap === "string")
    || !Array.isArray(payload.reports) || !payload.reports.every((report) => (report.id === "petroleum" || report.id === "gas")
      && dateOrNull(report.weekEnding) && dateOrNull(report.nextWeekEnding)
      && instantOrNull(report.releasedAt) && instantOrNull(report.nextReleaseAt))
    || !Array.isArray(payload.series) || new Set(payload.series.map((row) => row.id)).size !== payload.series.length
    || !payload.series.every(validRow)) {
    throw new Error("The server returned an invalid EIA weekly board");
  }
  return payload;
}

/**
 * The board, or the not-available message when the server does not serve the
 * route yet (404), cannot read its tables yet (503) or has no weeks stored.
 */
export async function fetchDoeBoard(client: Pick<typeof apiClient, "getCloudDoeBoard"> = apiClient): Promise<DoeBoardPayload> {
  let payload: DoeBoardPayload;
  try {
    payload = await client.getCloudDoeBoard();
  } catch (error) {
    if (error instanceof ApiRequestError && (error.status === 404 || error.status === 503)) throw new Error(DOE_NOT_AVAILABLE);
    throw error;
  }
  const board = validateDoeBoard(payload);
  if (board.status === "unavailable" || !board.series.some((row) => row.value != null)) throw new Error(DOE_NOT_AVAILABLE);
  return board;
}

export const getCachedDoeBoard = () => cachedCloudResource(doeBoardCache, "board", validateDoeBoard);
export const loadDoeBoard = (force = false) => loadCloudResource(doeBoardCache, "board", () => fetchDoeBoard(), { force, validate: validateDoeBoard });
