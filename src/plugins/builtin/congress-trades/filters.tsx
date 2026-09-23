import type { RefObject } from "react";
import { QueryBar } from "../../../components";
import type { SelectControl } from "../../../components/ui/select-button";
import type { CloudCongressHouseParams } from "../../../api-client/paths";

/** No chamber means both. */
export type CongressFilters = Pick<CloudCongressHouseParams, "side" | "owner" | "assetType" | "minAmount"> & {
  chamber?: "house" | "senate";
};
export type CongressFilterRefs = Record<"chamber" | "side" | "owner" | "assetType" | "minAmount", RefObject<SelectControl | null>>;

const ALL = { value: "all", label: "All" };
const CHAMBERS = [ALL, { value: "house", label: "House" }, { value: "senate", label: "Senate" }];
const SIDES = [ALL, ...["BUY", "SELL", "EXCHANGE", "OTHER"].map((value) => ({ value, label: value }))];
const OWNERS = [ALL, ...["self", "spouse", "joint", "dependent", "other"].map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))];
const ASSETS = [ALL, ...["stock", "option", "other"].map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))];
const AMOUNTS = [{ value: "0", label: "Any" }, { value: "15001", label: "$15k+" }, { value: "50001", label: "$50k+" }, { value: "100001", label: "$100k+" }, { value: "250001", label: "$250k+" }, { value: "1000001", label: "$1m+" }];

export function CongressFilterBar({ filters, onChange, mine, onMine, width, controls }: {
  filters: CongressFilters; onChange: (filters: CongressFilters) => void;
  mine: boolean; onMine: (mine: boolean) => void; width: number; controls: CongressFilterRefs;
}) {
  return <QueryBar width={width} filters={[
    { id: "chamber", label: "Chamber", value: filters.chamber ?? "all", defaultValue: "all", options: CHAMBERS, controlRef: controls.chamber,
      onChange: (value: string) => onChange({ ...filters, chamber: value === "all" ? undefined : value as CongressFilters["chamber"] }) },
    { id: "side", label: "Side", value: filters.side ?? "all", defaultValue: "all", options: SIDES, controlRef: controls.side,
      onChange: (value: string) => onChange({ ...filters, side: value === "all" ? undefined : value as CongressFilters["side"] }) },
    { id: "owner", label: "Owner", value: filters.owner ?? "all", defaultValue: "all", options: OWNERS, controlRef: controls.owner,
      onChange: (value: string) => onChange({ ...filters, owner: value === "all" ? undefined : value as CongressFilters["owner"] }) },
    { id: "asset", label: "Asset", value: filters.assetType ?? "all", defaultValue: "all", options: ASSETS, controlRef: controls.assetType,
      onChange: (value: string) => onChange({ ...filters, assetType: value === "all" ? undefined : value as CongressFilters["assetType"] }) },
    { id: "min", label: "Min", value: String(filters.minAmount ?? 0), defaultValue: "0", options: AMOUNTS, controlRef: controls.minAmount,
      onChange: (value: string) => onChange({ ...filters, minAmount: Number(value) || undefined }) },
    { id: "mine", kind: "toggle", label: "Mine", value: mine, onChange: onMine },
  ]} />;
}
