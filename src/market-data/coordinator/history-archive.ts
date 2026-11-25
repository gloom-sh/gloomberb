import type { PricePoint, TickerFinancials } from "../../types/financials";
import type { QueryEntry } from "../result-types";

const BAR_COLUMNS = 6;
const optionalColumns = ["open", "high", "low", "volume"] as const;
const barFields = new Set<string>(["date", "close", ...optionalColumns]);
const packedHistories = new WeakMap<PricePoint[], PackedBars | null>();

interface PackedBars {
  values: Float64Array;
  missing: Uint8Array;
  decoded: WeakRef<PricePoint[]>;
  /** Nonstandard points, such as bars carrying a venue breakout, are kept as served. */
  other: Map<number, PricePoint>;
}

function readBarOptions(point: PricePoint, optional: number[]): number | null {
  if (!(point.date instanceof Date) || typeof point.close !== "number") return null;
  for (const key of Object.keys(point)) {
    if (!barFields.has(key)) return null;
  }
  let mask = 0;
  for (let column = 0; column < optionalColumns.length; column++) {
    const key = optionalColumns[column]!;
    const value = point[key];
    if (value !== undefined && (typeof value !== "number" || Number.isNaN(value))) return null;
    if (!Object.hasOwn(point, key)) mask |= 1 << column;
    optional[column] = value ?? Number.NaN;
  }
  return mask;
}

function packBars(points: PricePoint[]): PackedBars | null {
  let packed: PackedBars | null = null;
  const optional = new Array<number>(optionalColumns.length);
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    const mask = readBarOptions(point, optional);
    if (mask === null) {
      packed?.other.set(index, point);
      continue;
    }
    if (!packed) {
      const other = new Map<number, PricePoint>();
      for (let earlier = 0; earlier < index; earlier++) other.set(earlier, points[earlier]!);
      packed = {
        values: new Float64Array(points.length * BAR_COLUMNS),
        missing: new Uint8Array(points.length),
        decoded: new WeakRef(points),
        other,
      };
    }
    const { values, missing } = packed;
    const offset = index * BAR_COLUMNS;
    missing[index] = mask;
    values[offset] = point.date.getTime();
    values[offset + 1] = point.close;
    values.set(optional, offset + 2);
  }
  return packed;
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
  if (packed === undefined) packedHistories.set(points, packed = packBars(points));
  return packed && readPackedBars(packed);
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
