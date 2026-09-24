import { canonicalExchange, normalizeSymbol } from "../../../utils/exchanges";
import { apiClient } from "../../../api-client";
import type {
  CloudMarketResponse,
  CloudPricePointPayload,
  CloudQuotePayload,
} from "../../../api-client/types";
import { createPluginCache } from "../../../data/plugin-cache";
import { ApiRequestError } from "../../../api-client/errors";
import {
  buildRotation,
  rotationId,
  type RotationHistory,
  type RotationInstrument,
  type RotationPayload,
} from "./model";

export const rotationCache = createPluginCache<RotationPayload>({
  kind: "relative-rotation",
  source: "gloom-cloud",
  schemaVersion: 2,
  policy: { staleMs: 30 * 60_000, expireMs: 7 * 86_400_000 },
});
type RotationClient = Pick<
  typeof apiClient,
  "getCloudHistory" | "getCloudQuotesBatch"
>;
export function validateRotationHistory(
  response: CloudMarketResponse<CloudPricePointPayload[]>,
  instrument?: RotationInstrument,
  currency?: string | null,
): CloudPricePointPayload[] {
  if (
    response.status !== "success" ||
    !Array.isArray(response.data) ||
    !response.data.length
  )
    throw new Error(response.reasonCode ?? "Daily history unavailable.");
  if (
    response.providerMeta?.servedResolution &&
    !["1d", "1day"].includes(response.providerMeta.servedResolution)
  )
    throw new Error("Cloud did not return daily bars.");
  const metadata = response.providerMeta;
  if (
    instrument &&
    ((metadata?.normalizedSymbol &&
      normalizeSymbol(metadata.normalizedSymbol) !==
        normalizeSymbol(instrument.symbol)) ||
      (metadata?.normalizedExchange &&
        instrument.exchange &&
        canonicalExchange(metadata.normalizedExchange) !==
          canonicalExchange(instrument.exchange)))
  )
    throw new Error(
      "History listing identity does not match the requested instrument.",
    );
  const units = [response.currency, metadata?.currency].filter(
    (value): value is string => !!value,
  );
  if (currency && units.some((value) => value !== currency))
    throw new Error("History currency does not match the listing currency.");
  if (
    response.data.length > 1500 ||
    response.data.some(
      (row) =>
        !row ||
        typeof row.date !== "string" ||
        !Number.isFinite(Date.parse(row.date)) ||
        !Number.isFinite(row.close) ||
        row.close <= 0,
    )
  )
    throw new Error("Invalid daily history from Gloom Cloud.");
  return response.data;
}
export async function fetchRotation(
  benchmark: RotationInstrument,
  instruments: RotationInstrument[],
  trail = 6,
  client: RotationClient = apiClient,
  now = new Date(),
): Promise<RotationPayload> {
  const unique = [
    ...new Map(
      [benchmark, ...instruments].map((row) => [rotationId(row), row]),
    ).values(),
  ];
  const quotes = new Map<string, CloudQuotePayload>();
  let quoteError: string | null = null;
  try {
    const result = await client.getCloudQuotesBatch(unique, "cache-first");
    for (const item of result.data?.items ?? []) {
      const instrument = unique.find(
        (row) =>
          row.symbol === item.symbol &&
          (canonicalExchange(row.exchange) ===
            canonicalExchange(item.exchange) ||
            !row.exchange),
      );
      if (instrument && item.status === "success" && item.data)
        quotes.set(rotationId(instrument), item.data);
    }
  } catch (error) {
    if (
      error instanceof ApiRequestError &&
      [401, 403].includes(error.status ?? 0)
    )
      throw error;
    quoteError = "Listing currencies unavailable.";
  }
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - 3);
  start.setUTCDate(1);
  const end = now.toISOString().slice(0, 10),
    startDate = start.toISOString().slice(0, 10);
  const results = new Map<string, RotationHistory>();
  let next = 0;
  // Bound Cloud history requests; shared server caches batch upstream demand.
  await Promise.all(
    Array.from({ length: Math.min(4, unique.length) }, async () => {
      while (next < unique.length) {
        const instrument = unique[next++]!,
          id = rotationId(instrument),
          currency = quotes.get(id)?.currency ?? null;
        try {
          const response = await client.getCloudHistory(
            instrument.symbol,
            instrument.exchange,
            {
              interval: "1day",
              outputsize: 1000,
              startDate,
              endDate: end,
              rangeKey: "3Y",
            },
          );
          results.set(id, {
            instrument,
            currency,
            points: validateRotationHistory(response, instrument, currency),
            asOf: response.asOf ?? null,
            stale: response.stale === true,
            error: quoteError,
          });
        } catch (error) {
          if (
            error instanceof ApiRequestError &&
            [401, 403].includes(error.status ?? 0)
          )
            throw error;
          results.set(id, {
            instrument,
            currency,
            points: [],
            asOf: null,
            stale: false,
            error:
              error instanceof Error ? error.message : "History unavailable.",
          });
        }
      }
    }),
  );
  return buildRotation(
    results.get(rotationId(benchmark))!,
    instruments.map((row) => results.get(rotationId(row))!),
    trail,
    now,
  );
}
const key = (
  benchmark: RotationInstrument,
  instruments: RotationInstrument[],
  trail: number,
) =>
  `${rotationId(benchmark)}|${instruments.map(rotationId).join(",")}|${trail}`;
export function cachedRotation(
  benchmark: RotationInstrument,
  instruments: RotationInstrument[],
  trail: number,
) {
  const value = rotationCache.get(key(benchmark, instruments, trail), {
    allowExpired: true,
  });
  return value
    ? {
        payload: value.data,
        // The pane revalidates this copy on mount; only a failed refresh makes it stale.
        stale: false,
        refreshError: null as string | null,
      }
    : null;
}
export async function loadRotation(
  benchmark: RotationInstrument,
  instruments: RotationInstrument[],
  trail: number,
  force = false,
) {
  const result = await rotationCache.load(
    key(benchmark, instruments, trail),
    () => fetchRotation(benchmark, instruments, trail),
    { force },
  );
  if (
    result.error instanceof ApiRequestError &&
    [401, 403].includes(result.error.status ?? 0)
  )
    throw result.error;
  return {
    payload: result.data,
    stale: result.stale,
    refreshError: result.refreshError ?? null,
  };
}
