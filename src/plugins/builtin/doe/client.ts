import { apiClient } from "../../../api-client";
import type { DoeBoardPayload, DoeSeriesRow } from "../../../api-client/doe";
import { hasUniqueIds, isCalendarDay, isFiniteNumber, isNullableCalendarDay, isNullableFinite, isNullableIsoInstant, isNullableString, isStringArray } from "../../../utils/guards";
import { createCloudEndpoint } from "../shared/cloud-resource";

/** What the pane says while the server has no EIA weeks to serve: before the backend ships, or before its first read. */
export const DOE_NOT_AVAILABLE = "Oil and gas inventories are not available yet.";

const UNITS = new Set(["kb", "kbd", "pct", "bcf"]);
const TABS = new Set(["crude", "products", "gas"]);
/** A field older servers leave out: absent, null or a number. */
const optionalFinite = (value: unknown) => value === undefined || isNullableFinite(value);
const pairs = (value: unknown) => Array.isArray(value)
  && value.every((pair) => Array.isArray(pair) && Number.isInteger(pair[0]) && isFiniteNumber(pair[1]));

function validRow(row: DoeSeriesRow): boolean {
  const five = row.fiveYear, ago = row.yearAgo, seasonal = row.seasonal;
  return typeof row.id === "string" && typeof row.label === "string" && UNITS.has(row.unit) && TABS.has(row.tab)
    && isNullableCalendarDay(row.weekEnding) && isNullableFinite(row.value) && isNullableFinite(row.weekChange) && (row.value == null) === (row.weekEnding == null)
    && isNullableString(row.read)
    && (row.basis === undefined || row.basis === "published" || row.basis === "computed")
    && (ago === null || isCalendarDay(ago.weekEnding) && isFiniteNumber(ago.value) && isFiniteNumber(ago.change) && isNullableFinite(ago.changePercent))
    && (five === null || Array.isArray(five.years) && five.years.length > 0 && [five.min, five.max, five.average, five.vsAverage].every(isFiniteNumber)
      && five.min <= five.max && isNullableFinite(five.averageChange) && isNullableFinite(five.vsAveragePercent) && isNullableFinite(five.position))
    && (seasonal === null || Number.isInteger(seasonal.year) && (seasonal.weeks === 52 || seasonal.weeks === 53)
      && pairs(seasonal.current) && pairs(seasonal.previous) && Array.isArray(seasonal.band)
      && seasonal.band.every((week) => Array.isArray(week) && Number.isInteger(week[0]) && week.slice(1).every(isNullableFinite)));
}

/** A board that breaks the contract is refused whole rather than drawn with holes in it. */
function validateDoeBoard(payload: DoeBoardPayload): DoeBoardPayload {
  if (!payload || payload.source !== "EIA" || !Number.isFinite(Date.parse(payload.generatedAt))
    || !["available", "partial", "unavailable"].includes(payload.status) || !isStringArray(payload.gaps)
    || !Array.isArray(payload.reports) || !payload.reports.every((report) => (report.id === "petroleum" || report.id === "gas")
      && isNullableCalendarDay(report.weekEnding) && isNullableCalendarDay(report.nextWeekEnding)
      && isNullableIsoInstant(report.releasedAt) && isNullableIsoInstant(report.nextReleaseAt)
      && optionalFinite(report.nextConsensus) && optionalFinite(report.nextPrior))
    || !Array.isArray(payload.series) || !hasUniqueIds(payload.series) || !payload.series.every(validRow)) {
    throw new Error("The server returned an invalid EIA weekly board");
  }
  return payload;
}

const doeBoardEndpoint = createCloudEndpoint<void, DoeBoardPayload, Pick<typeof apiClient, "getCloudDoeBoard">>({
  kind: "doe-board", schemaVersion: 1,
  // Weekly data: a quarter hour is soon enough to catch a release.
  policy: { staleMs: 15 * 60_000, expireMs: 14 * 24 * 60 * 60_000 },
  key: "board", defaultClient: apiClient,
  fetch: (_args, client) => client.getCloudDoeBoard(),
  validate: validateDoeBoard,
  unavailableMessage: DOE_NOT_AVAILABLE, unavailableStatuses: [404, 503],
  isEmptyAnswer: (board) => board.status === "unavailable",
});

export const doeBoardCache = doeBoardEndpoint.cache;

/** The board, or the not-available message when the server does not serve the route yet (404), cannot read its tables yet (503) or has no weeks stored. */
export async function fetchDoeBoard(client: Pick<typeof apiClient, "getCloudDoeBoard"> = apiClient): Promise<DoeBoardPayload> {
  const board = await doeBoardEndpoint.fetch(undefined, { client });
  if (!board.series.some((row) => row.value != null)) throw new Error(DOE_NOT_AVAILABLE);
  return board;
}

export const getCachedDoeBoard = () => doeBoardEndpoint.cached();
export const loadDoeBoard = (force = false) => doeBoardEndpoint.load(undefined, { force });
