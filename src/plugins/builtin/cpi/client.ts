import { apiClient } from "../../../api-client";
import type { CpiBoardPayload, CpiRow } from "../../../api-client/cpi";
import { hasUniqueIds, isCalendarMonth, isNonNegativeInt, isNullableFinite, isNullableIsoInstant, isNullableString, isStringArray } from "../../../utils/guards";
import { createCloudEndpoint } from "../shared/cloud-resource";

/** What the pane says while the server has no months to serve: before the backend ships, or before its first read. */
export const CPI_NOT_AVAILABLE = "US consumer prices are not available yet.";

const monthOrNull = (value: unknown) => value === null || isCalendarMonth(value);

function validRow(row: CpiRow): boolean {
  return typeof row.id === "string" && typeof row.label === "string" && isNonNegativeInt(row.depth)
    && isNullableString(row.code) && isNullableString(row.parent)
    && typeof row.pinned === "boolean" && typeof row.derived === "boolean"
    && [row.weight, row.change, row.annualized3m, row.annualized6m, row.yoy, row.contribution, row.contributionYoy].every(isNullableFinite)
    && isNullableString(row.read)
    && Array.isArray(row.history) && row.history.every((point) => Array.isArray(point) && isCalendarMonth(point[0])
      && isNullableFinite(point[1]) && isNullableFinite(point[2]));
}

/** A board that breaks the contract is refused whole rather than drawn with holes in it. */
function validateCpiBoard(payload: CpiBoardPayload): CpiBoardPayload {
  const release = payload?.release;
  if (!payload || payload.source !== "BLS" || !Number.isFinite(Date.parse(payload.generatedAt))
    || !isNullableIsoInstant(payload.retrievedAt ?? null)
    || !["available", "partial", "unavailable"].includes(payload.status) || !isStringArray(payload.gaps)
    || !release || !monthOrNull(release.period) || !monthOrNull(release.weightsPeriod) || !monthOrNull(release.nextPeriod)
    || !isNullableIsoInstant(release.releasedAt) || !isNullableIsoInstant(release.nextReleaseAt)
    || !Array.isArray(payload.rows) || !hasUniqueIds(payload.rows) || !payload.rows.every(validRow)) {
    throw new Error("The server returned an invalid consumer price board");
  }
  return payload;
}

const cpiBoardEndpoint = createCloudEndpoint<void, CpiBoardPayload, Pick<typeof apiClient, "getCloudCpiBoard">>({
  kind: "cpi-board", schemaVersion: 1,
  // Monthly data: a quarter hour is soon enough to catch a release.
  policy: { staleMs: 15 * 60_000, expireMs: 45 * 24 * 60 * 60_000 },
  key: "board", defaultClient: apiClient,
  fetch: (_args, client) => client.getCloudCpiBoard(),
  validate: validateCpiBoard,
  unavailableMessage: CPI_NOT_AVAILABLE, unavailableStatuses: [404, 503],
  isEmptyAnswer: (board) => board.status === "unavailable",
});

export const cpiBoardCache = cpiBoardEndpoint.cache;

/** The board, or the not-available message when the server does not serve the route yet (404), cannot read its tables yet (503) or has no months stored. */
export async function fetchCpiBoard(client: Pick<typeof apiClient, "getCloudCpiBoard"> = apiClient): Promise<CpiBoardPayload> {
  const board = await cpiBoardEndpoint.fetch(undefined, { client });
  if (!board.release.period || !board.rows.length) throw new Error(CPI_NOT_AVAILABLE);
  return board;
}

export const getCachedCpiBoard = () => cpiBoardEndpoint.cached();
export const loadCpiBoard = (force = false) => cpiBoardEndpoint.load(undefined, { force });
