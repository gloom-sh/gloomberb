import { SegmentedControl } from "../../../components";
import { MultiSelectDialogButton } from "../../../components/ui";
import { Box } from "../../../ui";
import type { CloudSearchDocType, CloudSearchSort } from "../../../api-client";
import {
  DOC_TYPE_OPTIONS,
  RANGE_OPTIONS,
  SORT_OPTIONS,
  type SearchFilters,
  type SearchRangeKey,
} from "./model";

/**
 * Pointer-driven on purpose: the tab strip and the results table already own
 * the arrow keys, so a focused segmented control here would take them away.
 */
export function SearchFilterBar({
  filters,
  onChange,
  onDialogOpenChange,
  width,
}: {
  filters: SearchFilters;
  onChange: (next: SearchFilters) => void;
  /** Lets the pane stop competing for keys while the type picker is open. */
  onDialogOpenChange: (open: boolean) => void;
  width: number;
}) {
  const compact = width < 84;
  return (
    <Box flexDirection="row" flexWrap={compact ? "wrap" : "nowrap"} gap={1} overflow="hidden">
      <MultiSelectDialogButton
        label="Types"
        title="Document types"
        options={DOC_TYPE_OPTIONS}
        selectedValues={filters.docTypes}
        emptyLabel="All"
        onOpenChange={onDialogOpenChange}
        onChange={(values: string[]) => onChange({
          ...filters,
          docTypes: values as CloudSearchDocType[],
        })}
      />
      <SegmentedControl
        options={RANGE_OPTIONS}
        value={filters.range === "custom" ? "all" : filters.range}
        onChange={(value) => onChange({
          ...filters,
          range: value as SearchRangeKey,
          // Presets own the window from here, so stored bounds must not linger.
          from: undefined,
          to: undefined,
        })}
      />
      <SegmentedControl
        options={SORT_OPTIONS}
        value={filters.sort}
        onChange={(value) => onChange({ ...filters, sort: value as CloudSearchSort })}
      />
    </Box>
  );
}
