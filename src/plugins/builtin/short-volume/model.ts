import type { ShortVolumeObservation, ShortVolumePayload } from "../../../api-client/short-volume";
import type { DataTableColumn } from "../../../components";
import { formatCompact } from "../../../utils/format";

export const volumePercent = (value: number | null) => value == null ? "--" : `${value.toFixed(2)}%`;
export const volumeChange = (value: number | null) => value == null ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}pp`;
export const volumeQuantity = (value: string | null) => value == null ? "--" : formatCompact(Number(value), { fixedDecimals: true });
export function exactQuantity(value: string | null): string {
  if (value == null) return "--";
  const [integer, fraction = ""] = value.split(".");
  const decimals = fraction.replace(/0+$/, "");
  return `${integer!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${decimals ? `.${decimals}` : ""}`;
}
export function volumePointStatus(point: ShortVolumeObservation): string {
  return point.unavailableReason === "missing_file" ? "File pending"
    : point.unavailableReason === "not_reported" ? "Not reported"
      : point.unavailableReason === "zero_volume" ? "Zero volume" : point.refreshFailed ? "Refresh failed" : "Reported";
}
export type VolumeColumnId = "date" | "ratioPercent" | "shortVolume" | "totalVolume" | "shortExemptVolume" | "status";
export type VolumeColumn = Omit<DataTableColumn, "id"> & { id: VolumeColumnId };
export const VOLUME_COLUMNS: VolumeColumn[] = [
  { id: "date", label: "DATE", width: 12, align: "left" },
  { id: "ratioPercent", label: "SHORT %", width: 10, align: "right" },
  { id: "shortVolume", label: "SHORT VOL", width: 12, align: "right" },
  { id: "totalVolume", label: "TOTAL VOL", width: 12, align: "right" },
  { id: "shortExemptVolume", label: "EXEMPT", width: 11, align: "right" },
  { id: "status", label: "STATUS", width: 15, flexGrow: 1, align: "left" },
];
export interface VolumeSort { column: VolumeColumn["id"]; direction: "asc" | "desc" }
export function sortedVolumeHistory(data: ShortVolumePayload, sort: VolumeSort): ShortVolumeObservation[] {
  function value(row: ShortVolumeObservation): string | number | bigint | null {
    if (sort.column === "status") return volumePointStatus(row);
    const raw = row[sort.column];
    if (["shortVolume", "totalVolume", "shortExemptVolume"].includes(sort.column) && raw != null) {
      const [whole, fraction = ""] = String(raw).split(".");
      return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
    }
    return raw;
  }
  return data.history.toSorted((a, b) => {
    const left = value(a), right = value(b);
    if (left == null || right == null) return left == null ? right == null ? b.date.localeCompare(a.date) : 1 : -1;
    return (left < right ? -1 : left > right ? 1 : 0) * (sort.direction === "asc" ? 1 : -1) || b.date.localeCompare(a.date);
  });
}
export function volumeHistoryPoints(data: ShortVolumePayload) {
  return data.history.flatMap((point, index) => {
    const previous = data.history[index - 1];
    const gap = previous && Date.parse(point.date) - Date.parse(previous.date) > 7 * 86_400_000
      ? [{ date: new Date(Date.parse(previous.date) + 86_400_000), observedAt: new Date(Date.parse(previous.date) + 86_400_000), value: null as number | null }] : [];
    return [...gap, { date: new Date(point.date), observedAt: new Date(point.date), value: point.ratioPercent }];
  });
}
