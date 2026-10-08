import { Box, Text, useUiCapabilities } from "../ui";
import { colors } from "../theme/colors";
import { Checkbox } from "./ui/checkbox";
import { ListView, type ListRowState, type ListViewItem } from "./ui/list-view";

interface ToggleListItem {
  id: string;
  label: string;
  enabled: boolean;
  description?: string;
  /** Muted text at the row's right edge, always shown. */
  detail?: string;
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
  /** Each row's description in muted text before its detail, cut to fit. */
  showDescriptions?: boolean;
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
  showDescription,
  onPress,
}: {
  item: ListViewItem;
  state: ListRowState;
  rowIdPrefix?: string;
  enabled: boolean;
  showDescription: boolean;
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
      <Box flexGrow={1} minWidth={0} flexDirection="row" alignItems="center" style={{ gap: 12 }}>
        <Box flexGrow={showDescription ? 0 : 1} flexShrink={showDescription ? 0 : 1} minWidth={0}>
          <Checkbox
            label={item.label}
            checked={enabled}
            disabled={state.disabled}
            active={state.selected}
            width={showDescription ? undefined : "100%"}
            variant="desktop"
            onChange={onPress}
          />
        </Box>
        {showDescription && item.description ? (
          <Text
            fg={colors.textMuted}
            onMouseDown={(event?: { preventDefault?: () => void; stopPropagation?: () => void }) => {
              event?.preventDefault?.();
              event?.stopPropagation?.();
              if (!state.disabled) onPress();
            }}
            style={{ flexShrink: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}
          >
            {item.description}
          </Text>
        ) : null}
      </Box>
      {item.detail ? <Text fg={colors.textMuted} style={{ flexShrink: 0, minWidth: "2ch", textAlign: "right" }}>{item.detail}</Text> : null}
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
  showDescriptions = false,
  rowIdPrefix,
  rowGap,
  rowHeight,
  surface,
  remoteLabel,
  remoteScope,
  remoteMetadata,
}: ToggleListProps) {
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  const listItems: ListViewItem[] = items.map((item) => ({
    id: item.id,
    label: item.label,
    description: item.description,
    detail: item.detail,
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
              showDescription={showDescriptions}
              onPress={() => activate()}
            />
          );
        }

        return (
          <Box
            id={rowIdPrefix ? `${rowIdPrefix}:${item.id}` : undefined}
            flexDirection="row"
            justifyContent="space-between"
            onMouseDown={activate}
          >
            <Checkbox
              label={item.label}
              checked={toggleItem?.enabled === true}
              disabled={state.disabled}
              active={state.selected}
              onChange={() => activate()}
            />
            {showDescriptions ? (
              <Box flexDirection="row" gap={2}>
                {item.description ? <Text fg={colors.textMuted}>{item.description}</Text> : null}
                {item.detail ? <Text fg={colors.textMuted}>{item.detail}</Text> : null}
              </Box>
            ) : item.detail ? <Text fg={colors.textMuted}>{item.detail}</Text> : null}
          </Box>
        );
      }}
    />
  );
}
