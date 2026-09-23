import type { RefObject } from "react";
import { Box } from "../../../ui";
import { Checkbox, SelectButton } from "../../../components";
import type { SelectControl } from "../../../components/ui/select-button";
import type { CloudCongressHouseParams } from "../../../api-client/paths";

/** No chamber means both. */
export type CongressFilters = Pick<CloudCongressHouseParams, "side" | "owner" | "assetType" | "minAmount"> & {
  chamber?: "house" | "senate";
};
export type CongressFilterRefs = Record<"chamber" | "side" | "owner" | "assetType" | "minAmount", RefObject<SelectControl | null>>;

export function CongressFilterBar({ filters, onChange, mine, onMine, width, controls }: {
  filters: CongressFilters; onChange: (filters: CongressFilters) => void;
  mine: boolean; onMine: (mine: boolean) => void; width: number; controls: CongressFilterRefs;
}) {
  return <Box flexDirection={width < 100 ? "column" : "row"} gap={width < 100 ? 0 : 1}>
    <Box flexDirection="row" gap={1}>
      <SelectButton label="Chamber" value={filters.chamber ?? "all"} controlRef={controls.chamber}
        options={[{ value: "all", label: "All" }, { value: "house", label: "House" }, { value: "senate", label: "Senate" }]}
        onChange={(value) => onChange({ ...filters, chamber: value === "all" ? undefined : value as CongressFilters["chamber"] })} emphasized={!!filters.chamber} />
      <SelectButton label="Side" value={filters.side ?? "all"} controlRef={controls.side}
        options={[{ value: "all", label: "All" }, ...["BUY", "SELL", "EXCHANGE", "OTHER"].map((value) => ({ value, label: value }))]}
        onChange={(value) => onChange({ ...filters, side: value === "all" ? undefined : value as CongressFilters["side"] })} emphasized={!!filters.side} />
      <SelectButton label="Owner" value={filters.owner ?? "all"} controlRef={controls.owner}
        options={[{ value: "all", label: "All" }, ...["self", "spouse", "joint", "dependent", "other"].map((value) => ({ value, label: value }))]}
        onChange={(value) => onChange({ ...filters, owner: value === "all" ? undefined : value as CongressFilters["owner"] })} emphasized={!!filters.owner} />
    </Box>
    <Box flexDirection="row" gap={1}>
      <SelectButton label="Asset" value={filters.assetType ?? "all"} controlRef={controls.assetType}
        options={[{ value: "all", label: "All" }, ...["stock", "option", "other"].map((value) => ({ value, label: value }))]}
        onChange={(value) => onChange({ ...filters, assetType: value === "all" ? undefined : value as CongressFilters["assetType"] })} emphasized={!!filters.assetType} />
      <SelectButton label="Min" value={String(filters.minAmount ?? 0)} controlRef={controls.minAmount}
        options={[{ value: "0", label: "Any" }, { value: "15001", label: "$15k+" }, { value: "50001", label: "$50k+" }, { value: "100001", label: "$100k+" }, { value: "250001", label: "$250k+" }, { value: "1000001", label: "$1m+" }]}
        onChange={(value) => onChange({ ...filters, minAmount: Number(value) || undefined })} emphasized={!!filters.minAmount} />
      <Checkbox label="Mine" checked={mine} onChange={onMine} />
    </Box>
  </Box>;
}
