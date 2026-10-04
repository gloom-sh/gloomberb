import { apiClient } from "../../../api-client";
import type { CpiBoardPayload, CpiRow } from "../../../api-client/cpi";
import { ApiRequestError } from "../../../api-client/errors";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource } from "../shared/cloud-resource";

/** What the pane says while the server has no months to serve: before the backend ships, or before its first read. */
export const CPI_NOT_AVAILABLE = "US consumer prices are not available yet.";

export const cpiBoardCache = createPluginCache<CpiBoardPayload>({
  kind: "cpi-board", source: "gloom-cloud", schemaVersion: 1,
  // Monthly data: a quarter hour is soon enough to catch a release.
  policy: { staleMs: 15 * 60_000, expireMs: 45 * 24 * 60 * 60_000 },
});

const month = (value: unknown) => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const monthOrNull = (value: unknown) => value === null || month(value);
const instantOrNull = (value: unknown) => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const finiteOrNull = (value: unknown) => value === null || finite(value);

function validRow(row: CpiRow): boolean {
  return typeof row.id === "string" && typeof row.label === "string" && Number.isInteger(row.depth) && row.depth >= 0
    && (row.code === null || typeof row.code === "string") && (row.parent === null || typeof row.parent === "string")
    && typeof row.pinned === "boolean" && typeof row.derived === "boolean"
    && [row.weight, row.change, row.annualized3m, row.annualized6m, row.yoy, row.contribution, row.contributionYoy].every(finiteOrNull)
    && (row.read === null || typeof row.read === "string")
    && Array.isArray(row.history) && row.history.every((point) => Array.isArray(point) && month(point[0])
      && finiteOrNull(point[1]) && finiteOrNull(point[2]));
}

/** A board that breaks the contract is refused whole rather than drawn with holes in it. */
function validateCpiBoard(payload: CpiBoardPayload): CpiBoardPayload {
  const release = payload?.release;
  if (!payload || payload.source !== "BLS" || !Number.isFinite(Date.parse(payload.generatedAt))
    || !instantOrNull(payload.retrievedAt ?? null)
    || !["available", "partial", "unavailable"].includes(payload.status)
    || !Array.isArray(payload.gaps) || !payload.gaps.every((gap) => typeof gap === "string")
    || !release || !monthOrNull(release.period) || !monthOrNull(release.weightsPeriod) || !monthOrNull(release.nextPeriod)
    || !instantOrNull(release.releasedAt) || !instantOrNull(release.nextReleaseAt)
    || !Array.isArray(payload.rows) || new Set(payload.rows.map((row) => row.id)).size !== payload.rows.length
    || !payload.rows.every(validRow)) {
    throw new Error("The server returned an invalid consumer price board");
  }
  return payload;
}

/**
 * The board, or the not-available message when the server does not serve the
 * route yet (404), cannot read its tables yet (503) or has no months stored.
 */
export async function fetchCpiBoard(client: Pick<typeof apiClient, "getCloudCpiBoard"> = apiClient): Promise<CpiBoardPayload> {
  let payload: CpiBoardPayload;
  try {
    payload = await client.getCloudCpiBoard();
  } catch (error) {
    if (error instanceof ApiRequestError && (error.status === 404 || error.status === 503)) throw new Error(CPI_NOT_AVAILABLE);
    throw error;
  }
  const board = validateCpiBoard(payload);
  if (board.status === "unavailable" || !board.release.period || !board.rows.length) throw new Error(CPI_NOT_AVAILABLE);
  return board;
}

export const getCachedCpiBoard = () => cachedCloudResource(cpiBoardCache, "board", validateCpiBoard);
export const loadCpiBoard = (force = false) => loadCloudResource(cpiBoardCache, "board", () => fetchCpiBoard(), { force, validate: validateCpiBoard });
