import type { PricePoint, TickerFinancials } from "../../types/financials";
import type { QueryEntry } from "../result-types";

const BAR_COLUMNS = 6;
const optionalColumns = ["open", "high", "low", "volume"] as const;
const barFields = new Set<string>(["date", "close", ...optionalColumns]);
const packedHistories = new WeakMap<PricePoint[], PackedBars>();

interface PackedBars {
  values: Float64Array;
  missing: Uint8Array;
  decoded: WeakRef<PricePoint[]>;
  /** Nonstandard points, such as bars carrying a venue breakout, are kept as served. */
  other: Map<number, PricePoint>;
}

function packBars(points: PricePoint[]): PackedBars {
  const values = new Float64Array(points.length * BAR_COLUMNS);
  const missing = new Uint8Array(points.length);
  const other = new Map<number, PricePoint>();
  bars: for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    if (!(point.date instanceof Date) || typeof point.close !== "number") {
      other.set(index, point);
      continue;
    }
    for (const key of Object.keys(point)) {
      if (barFields.has(key)) continue;
      other.set(index, point);
      continue bars;
    }
    const offset = index * BAR_COLUMNS;
    let mask = 0;
    for (let column = 0; column < optionalColumns.length; column++) {
      const key = optionalColumns[column]!;
      const value = point[key];
      if (value !== undefined && (typeof value !== "number" || Number.isNaN(value))) {
        other.set(index, point);
        continue bars;
      }
      if (!Object.hasOwn(point, key)) mask |= 1 << column;
      values[offset + 2 + column] = value ?? Number.NaN;
    }
    missing[index] = mask;
    values[offset] = point.date.getTime();
    values[offset + 1] = point.close;
  }
  return { values, missing, other, decoded: new WeakRef(points) };
}

function unpackBars(packed: PackedBars): PricePoint[] {
  const decoded = packed.decoded.deref();
  if (decoded) return decoded;
  const { values, missing, other } = packed;
  const irregular = other.size ? other : null;
  const points: PricePoint[] = new Array(missing.length);
  for (let index = 0; index < missing.length; index++) {
    const kept = irregular?.get(index);
    if (kept) {
      points[index] = kept;
      continue;
    }
    const mask = missing[index]!;
    const offset = index * BAR_COLUMNS;
    const point: PricePoint = { date: new Date(values[offset]!), close: values[offset + 1]! };
    for (let column = 0; column < optionalColumns.length; column++) {
      if (mask & (1 << column)) continue;
      const value = values[offset + 2 + column]!;
      point[optionalColumns[column]!] = Number.isNaN(value) ? undefined : value;
    }
    points[index] = point;
  }
  packed.decoded = new WeakRef(points);
  packedHistories.set(points, packed);
  return points;
}

function archiveEntry<T>(entry: QueryEntry<T>, archiveValue: (value: T) => (() => T) | null): (() => QueryEntry<T>) | null {
  const { data, lastGoodData, ...metadata } = entry;
  const archivedData = data == null ? null : archiveValue(data);
  const shared = data === lastGoodData;
  const archivedLast = shared || lastGoodData == null ? null : archiveValue(lastGoodData);
  if (!archivedData && !archivedLast) return null;
  return restoreEntry(metadata, archivedData ?? readValue(data), shared ? null : archivedLast ?? readValue(lastGoodData));
}

function readValue<T>(value: T): () => T {
  return () => value;
}

function restoreEntry<T>(metadata: Omit<QueryEntry<T>, "data" | "lastGoodData">, read: () => T | null, readLast: (() => T | null) | null): () => QueryEntry<T> {
  return () => {
    const data = read();
    return { ...metadata, data, lastGoodData: readLast ? readLast() : data };
  };
}

function archiveBars(points: PricePoint[]): (() => PricePoint[]) | null {
  if (!points.length) return null;
  let packed = packedHistories.get(points);
  if (!packed) packedHistories.set(points, packed = packBars(points));
  return readPackedBars(packed);
}

function readPackedBars(packed: PackedBars): () => PricePoint[] {
  return () => unpackBars(packed);
}

export function archiveChartEntry(entry: QueryEntry<PricePoint[]>): (() => QueryEntry<PricePoint[]>) | null {
  return archiveEntry(entry, archiveBars);
}

export function archiveSnapshotEntry(entry: QueryEntry<TickerFinancials>): (() => QueryEntry<TickerFinancials>) | null {
  return archiveEntry(entry, ({ priceHistory, ...snapshot }) => {
    const read = archiveBars(priceHistory);
    return read && (() => ({ ...snapshot, priceHistory: read() }));
  });
}
