import { Box, useUiHost } from "../ui";
import { colors } from "../theme/colors";
import { Checkbox } from "./ui/checkbox";
import { ListView, type ListRowState, type ListViewItem } from "./ui/list-view";

interface ToggleListItem {
  id: string;
  label: string;
  enabled: boolean;
  description?: string;
  disabled?: boolean;
}

export interface ToggleListProps {
  items: ToggleListItem[];
  selectedIdx: number;
  onToggle?: (id: string) => void;
  onSelect?: (idx: number) => void;
  /** Background color for non-selected rows (defaults to colors.bg) */
  bgColor?: string;
  height?: number;
  flexGrow?: number;
  scrollable?: boolean;
  showSelectedDescription?: boolean;
  rowIdPrefix?: string;
  rowGap?: number;
  rowHeight?: number;
  surface?: "framed" | "plain";
  remoteLabel?: string;
  remoteScope?: string;
  remoteMetadata?: Record<string, unknown>;
}

function DesktopToggleRow({
  item,
  state,
  rowIdPrefix,
  enabled,
  onPress,
}: {
  item: ListViewItem;
  state: ListRowState;
  rowIdPrefix?: string;
  enabled: boolean;
  onPress: () => void;
}) {
  return (
    <Box
      id={rowIdPrefix ? `${rowIdPrefix}:${item.id}` : undefined}
      flexDirection="row"
      alignItems="center"
      width="100%"
      minWidth={0}
      style={{
        height: "100%",
        gap: 10,
        paddingInline: 10,
        opacity: state.disabled ? 0.55 : 1,
      }}
    >
      <Checkbox
        label={item.label}
        checked={enabled}
        disabled={state.disabled}
        active={state.selected}
        width="100%"
        variant="desktop"
        onChange={onPress}
      />
    </Box>
  );
}

export function ToggleList({
  items,
  selectedIdx,
  onToggle,
  onSelect,
  bgColor,
  height,
  flexGrow,
  scrollable,
  showSelectedDescription = true,
  rowIdPrefix,
  rowGap,
  rowHeight,
  surface,
  remoteLabel,
  remoteScope,
  remoteMetadata,
}: ToggleListProps) {
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const listItems: ListViewItem[] = items.map((item) => ({
    id: item.id,
    label: item.label,
    description: item.description,
    disabled: item.disabled,
  }));

  return (
    <ListView
      items={listItems}
      selectedIndex={selectedIdx}
      bgColor={bgColor ?? colors.bg}
      showSelectedDescription={showSelectedDescription}
      height={height}
      flexGrow={flexGrow}
      scrollable={scrollable}
      rowGap={rowGap ?? (isDesktopWeb ? 0 : undefined)}
      rowHeight={rowHeight}
      surface={surface}
      remoteLabel={remoteLabel}
      remoteScope={remoteScope}
      remoteMetadata={remoteMetadata}
      remoteItemKind="toggle"
      checkboxRows
      onSelect={onSelect}
      onActivate={(item) => {
        onToggle?.(item.id);
      }}
      renderRow={(item, state, index) => {
        const toggleItem = items.find((entry) => entry.id === item.id);
        const activate = (event?: { stopPropagation?: () => void; preventDefault?: () => void }) => {
          event?.stopPropagation?.();
          event?.preventDefault?.();
          if (state.disabled) return;
          onSelect?.(index);
          onToggle?.(item.id);
        };
        if (isDesktopWeb) {
          return (
            <DesktopToggleRow
              item={item}
              state={state}
              rowIdPrefix={rowIdPrefix}
              enabled={toggleItem?.enabled === true}
              onPress={() => activate()}
            />
          );
        }

        return (
          <Box
            id={rowIdPrefix ? `${rowIdPrefix}:${item.id}` : undefined}
            flexDirection="row"
            onMouseDown={activate}
          >
            <Checkbox
              label={item.label}
              checked={toggleItem?.enabled === true}
              disabled={state.disabled}
              active={state.selected}
              onChange={() => activate()}
            />
          </Box>
        );
      }}
    />
  );
}
