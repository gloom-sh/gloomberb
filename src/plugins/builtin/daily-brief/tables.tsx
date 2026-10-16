import { DataTableView, type DataTableCell, type DataTableColumn } from "../../../components";
import { getTableWidth } from "../../../components/ui/table-layout";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, TextAttributes } from "../../../ui";

export interface BriefTableRow {
  id: string;
  placeholder?: boolean;
}

function withFlex(width: number, lead: DataTableColumn[], flex: DataTableColumn, tail: DataTableColumn[] = []): DataTableColumn[] {
  const stub: DataTableColumn = { ...flex, label: "", width: 1 };
  const room = width + 1 - getTableWidth([...lead, stub, ...tail]);
  return [...lead, { ...flex, width: Math.max(12, room), flexGrow: 1 }, ...tail];
}

export function headlineColumns(width: number): DataTableColumn[] {
  return withFlex(width, [
    { id: "time", label: "TIME", width: 10, align: "left" },
    { id: "source", label: "SOURCE", width: 15, align: "left" },
  ], { id: "title", label: "HEADLINE", width: 16, align: "left" });
}

export function releaseColumns(width: number): DataTableColumn[] {
  return withFlex(width, [
    { id: "time", label: "TIME", width: 10, align: "left" },
    { id: "country", label: "COUNTRY", width: 8, align: "left" },
  ], { id: "event", label: "EVENT", width: 16, align: "left" });
}

const EARNINGS_ESTIMATES: DataTableColumn[] = [
  { id: "eps", label: "EPS EST", width: 8, align: "right" },
  { id: "sales", label: "SALES EST", width: 10, align: "right" },
];

export function earningsColumns(width: number): DataTableColumn[] {
  const lead: DataTableColumn[] = [
    { id: "when", label: "WHEN", width: 6, align: "left" },
    { id: "ticker", label: "TICKER", width: 8, align: "left" },
  ];
  const company: DataTableColumn = { id: "company", label: "COMPANY", width: 12, align: "left" };
  const tail: DataTableColumn[] = [];
  for (const column of EARNINGS_ESTIMATES) {
    const next = [...tail, column];
    if (getTableWidth(withFlex(width, lead, company, next)) > width + 1) break;
    tail.push(column);
  }
  return withFlex(width, lead, company, tail);
}

export function BriefTable<T extends BriefTableRow>({
  label,
  count,
  width,
  columns,
  items,
  focused,
  selectedId,
  onSelect,
  onActivate,
  renderCell,
  sortColumnId,
  sortDirection,
  onHeaderClick,
}: {
  label: string;
  count: number;
  width: number;
  columns: DataTableColumn[];
  items: T[];
  focused: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onActivate: (item: T) => void;
  renderCell: (item: T, column: DataTableColumn, index: number, state: { selected: boolean }) => DataTableCell;
  sortColumnId: string | null;
  sortDirection: "asc" | "desc";
  onHeaderClick: (columnId: string) => void;
}) {
  const colors = useThemeColors();
  if (items.length === 0) return null;
  const frameHeight = 1 + items.length;
  const selected = items.some((item) => item.id === selectedId) ? selectedId : null;
  return (
    <Box flexDirection="column" flexShrink={0} width={width}>
      <Box height={1} paddingX={1} flexShrink={0}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{`${label} (${count})`}</Text>
      </Box>
      <Box height={frameHeight} flexShrink={0} width={width} overflow="hidden">
        <DataTableView<T>
          focused={focused}
          keyboardNavigation={false}
          rootWidth={width}
          rootHeight={frameHeight}
          columns={columns}
          items={items}
          getItemKey={(item) => item.id}
          virtualize={false}
          showHorizontalScrollbar={false}
          selectedTextOverridesCellColor
          emptyStateTitle=" "
          sortColumnId={sortColumnId}
          sortDirection={sortDirection}
          onHeaderClick={onHeaderClick}
          isNavigable={(item) => !item.placeholder}
          renderCell={renderCell}
          selection={{
            kind: "id",
            selectedId: selected,
            getId: (item) => item.id,
            onChange: (id) => { if (id) onSelect(id); },
          }}
          onActivate={onActivate}
        />
      </Box>
    </Box>
  );
}
