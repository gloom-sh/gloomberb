import { apiClient } from "../../../api-client";
import type { FailsToDeliverPayload, OtcVolumePayload, ShortSidePublication } from "../../../api-client/short-side-publications";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

export type PublicationKind = "ftd" | "ats";
export type PublicationPayload = FailsToDeliverPayload | OtcVolumePayload;
export const publicationCache = createPluginCache<PublicationPayload>({
  kind: "short-side-publications", source: "gloom-cloud", schemaVersion: 2,
  policy: { staleMs: 60 * 60_000, expireMs: 30 * 24 * 60 * 60_000 },
});
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const dateOrNull = (value: unknown) => value === null || date(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const countOrNull = (value: unknown) => value === null || count(value);
const sharesOrNull = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const numberOrNull = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value) && value >= 0;
const url = (value: unknown): value is string => typeof value === "string" && /^https?:\/\//.test(value);

function validateEnvelope(payload: ShortSidePublication<unknown>, symbol: string): boolean {
  return !!payload && payload.symbol === symbol && ["available", "partial", "unavailable"].includes(payload.status)
    && dateOrNull(payload.asOf) && dateOrNull(payload.sourceAsOf)
    && (payload.loadedAt === null || typeof payload.loadedAt === "string" && Number.isFinite(Date.parse(payload.loadedAt)))
    && typeof payload.fetchedAt === "string" && Number.isFinite(Date.parse(payload.fetchedAt))
    && !!payload.source && typeof payload.source.name === "string" && url(payload.source.url) && typeof payload.source.cadence === "string"
    && Array.isArray(payload.warnings) && payload.warnings.every((warning) => typeof warning === "string")
    && Array.isArray(payload.history) && !!payload.coverage && date(payload.coverage.from) && date(payload.coverage.to)
    && payload.coverage.from <= payload.coverage.to && count(payload.coverage.publications)
    && (payload.history.length > 0 ? payload.status !== "unavailable" && payload.asOf !== null : payload.status === "unavailable" && payload.asOf === null);
}

/** Reject mixed symbols, duplicate identities and inconsistent category totals; preserve missing values. */
export function validatePublication(payload: PublicationPayload, symbol: string, kind: PublicationKind): PublicationPayload {
  const invalid = () => { throw new Error(`The server returned invalid ${kind === "ftd" ? "fails-to-deliver" : "weekly off-exchange volume"} history`); };
  if (!validateEnvelope(payload, symbol)) return invalid();
  let previous = "";
  const identities = new Set<string>();
  for (const row of payload.history) {
    if (!row || !url(row.sourceUrl)) return invalid();
    let observed: string;
    let identity: string;
    if (kind === "ftd") {
      if (!("date" in row) || !date(row.date) || (typeof row.cusip !== "string" || !row.cusip.trim()) || !count(row.quantity)
        || !numberOrNull(row.price) || typeof row.description !== "string") return invalid();
      observed = row.date;
      identity = `${row.date}:${row.cusip}`;
    } else {
      if (!("weekStart" in row) || !date(row.weekStart) || new Date(row.weekStart).getUTCDay() !== 1
        || ![row.atsShares, row.nonAtsShares, row.totalShares].every(sharesOrNull)
        || ![row.atsTrades, row.nonAtsTrades].every(countOrNull)
        || !numberOrNull(row.atsSharePercent) || row.atsSharePercent !== null && row.atsSharePercent > 100) return invalid();
      const complete = row.atsShares !== null && row.nonAtsShares !== null;
      const total = complete ? row.atsShares! + row.nonAtsShares! : null;
      if (row.totalShares !== total || (!total ? row.atsSharePercent !== null
        : row.atsSharePercent === null || Math.abs(row.atsSharePercent - row.atsShares! / total * 100) > 0.0001)) return invalid();
      observed = row.weekStart;
      identity = observed;
    }
    if (observed < previous || observed < payload.coverage.from || observed > payload.coverage.to || identities.has(identity)) return invalid();
    previous = observed;
    identities.add(identity);
  }
  if (payload.history.length && payload.asOf !== previous) return invalid();
  return payload;
}

export async function fetchPublication(symbol: string, kind: PublicationKind,
  client: Pick<typeof apiClient, "getCloudFailsToDeliver" | "getCloudOtcVolume"> = apiClient): Promise<PublicationPayload> {
  try {
    const payload = kind === "ftd" ? await client.getCloudFailsToDeliver(symbol) : await client.getCloudOtcVolume(symbol);
    return validatePublication(payload, symbol, kind);
  } catch (error) {
    throw unavailableOnServer(error, `${kind === "ftd" ? "Fails to deliver" : "Weekly off-exchange volume"} is not available yet.`, [404, 503]);
  }
}
const cacheKey = (symbol: string, kind: PublicationKind) => `${kind}:${symbol}`;
export const cachedPublication = (symbol: string, kind: PublicationKind) =>
  cachedCloudResource(publicationCache, cacheKey(symbol, kind), (data) => validatePublication(data, symbol, kind));
export const loadPublication = (symbol: string, kind: PublicationKind, force = false) =>
  loadCloudResource(publicationCache, cacheKey(symbol, kind), () => fetchPublication(symbol, kind),
    { force, validate: (data) => validatePublication(data, symbol, kind) });
