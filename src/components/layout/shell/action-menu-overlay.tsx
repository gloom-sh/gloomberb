import { useRef } from "react";
import { Box, Text, useUiCapabilities } from "../../../ui";
import { MenuPopover } from "../../ui/menu";
import { colors } from "../../../theme/colors";
import { MENU_Z_INDEX, truncateMenuText, type PaneMenuEntry } from "./menu";
import { t } from "../../../i18n";
import { displayWidth, padTo } from "../../../utils/format";

export interface ActionMenuState {
  paneId: string;
  x: number;
  y: number;
  width: number;
  items: PaneMenuEntry[];
  /** Terminal: the most rows the menu may take before it scrolls. */
  maxRows?: number;
  /** Desktop: where the menu pops out from, in px (the `...` button or the pointer). */
  anchor?: { x: number; y: number; placement: "bottom-start" | "bottom-end" };
}

/** Under the pane's "..." button, for a menu the keyboard opened. */
export function paneMenuButtonAnchor(paneId: string): ActionMenuState["anchor"] {
  type Bounds = { getBoundingClientRect(): { right: number; bottom: number } };
  const doc = (globalThis as { document?: { querySelector?(selector: string): Bounds | null } }).document;
  const id = paneId.replace(/["\\]/g, "\\$&");
  const button = doc?.querySelector?.(`[data-gloom-pane-id="${id}"] [data-gloom-role=pane-action]`);
  if (!button) return undefined;
  const rect = button.getBoundingClientRect();
  return { x: rect.right, y: rect.bottom, placement: "bottom-end" };
}

export function ShellActionMenuOverlay({
  menuState,
  hoveredMenuItemId,
  onClose,
  onHoverItem,
}: {
  menuState: ActionMenuState | null;
  hoveredMenuItemId: string | null;
  onClose: () => void;
  onHoverItem: (itemId: string) => void;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const startRef = useRef(0);
  if (!menuState) {
    startRef.current = 0;
    return null;
  }

  if (nativePaneChrome) {
    return (
      <MenuPopover
        open
        onOpenChange={(open) => { if (!open) onClose(); }}
        anchorPoint={menuState.anchor ?? null}
        placement={menuState.anchor?.placement ?? "bottom-start"}
        label="Pane"
        items={menuState.items.map((item) => item.divider
          ? { id: item.id, label: "", kind: "divider" as const }
          : { id: item.id, label: t(item.label), hint: item.accelerator, checked: item.checked })}
        onSelect={(id) => {
          const item = menuState.items.find((entry) => entry.id === id);
          onClose();
          item?.action();
        }}
      />
    );
  }

  // When the menu is taller than the room it scrolls, only as far as keeps the
  // highlight in view. Recentring on every move would slide rows under a
  // pointer that is hovering them.
  const rows = Math.max(1, Math.min(menuState.items.length, menuState.maxRows ?? menuState.items.length));
  const highlightIndex = Math.max(0, menuState.items.findIndex((item) => item.id === hoveredMenuItemId));
  let start = Math.max(0, Math.min(menuState.items.length - rows, startRef.current));
  if (highlightIndex < start) start = highlightIndex;
  else if (highlightIndex >= start + rows) start = highlightIndex - rows + 1;
  startRef.current = start;
  const visibleItems = menuState.items.slice(start, start + rows);
  const swallowPress = (event: { stopPropagation?: () => void; preventDefault?: () => void }) => {
    event.stopPropagation?.();
    event.preventDefault?.();
  };

  return (
    <Box
      position="absolute"
      left={menuState.x}
      top={menuState.y}
      width={menuState.width}
      height={rows + 2}
      backgroundColor={colors.panel}
      border
      borderStyle="single"
      borderColor={colors.borderFocused}
      zIndex={MENU_Z_INDEX}
      flexDirection="column"
      onMouseDown={swallowPress}
      onMouseScroll={(event: { scroll?: { direction?: string }; stopPropagation?: () => void }) => {
        // The wheel scrolls a menu taller than the room, as the keys do.
        event.stopPropagation?.();
        const choices = menuState.items.filter((item) => !item.divider);
        const index = choices.findIndex((item) => item.id === hoveredMenuItemId);
        const step = event.scroll?.direction === "up" ? -1 : 1;
        const next = choices[Math.max(0, Math.min(choices.length - 1, index + step))];
        if (next) onHoverItem(next.id);
      }}
    >
      {visibleItems.map((item) => {
        const innerWidth = Math.max(1, menuState.width - 2);
        if (item.divider) {
          return (
            <Box key={item.id} height={1} width={innerWidth} onMouseDown={swallowPress}>
              <Text fg={colors.border}>{"─".repeat(innerWidth)}</Text>
            </Box>
          );
        }
        const hovered = hoveredMenuItemId === item.id;
        const accelerator = item.accelerator ?? "";
        const acceleratorWidth = accelerator.length;
        const labelWidth = accelerator ? Math.max(1, innerWidth - acceleratorWidth - 1) : innerWidth;
        const mark = item.checked === undefined ? "" : item.checked ? "[x] " : "[ ] ";
        const label = mark + truncateMenuText(t(item.label), Math.max(1, labelWidth - mark.length));
        const spacer = accelerator ? " ".repeat(Math.max(1, innerWidth - displayWidth(label) - acceleratorWidth)) : "";
        const line = padTo(`${label}${spacer}${accelerator}`, innerWidth);
        return (
          <Box
            key={item.id}
            height={1}
            width={innerWidth}
            backgroundColor={hovered ? colors.selected : colors.panel}
            onMouseOver={() => onHoverItem(item.id)}
            onMouseDown={(mouseEvent: any) => {
              mouseEvent.stopPropagation();
              mouseEvent.preventDefault();
              onClose();
              item.action();
            }}
            data-gloom-interactive="true"
          >
            <Text fg={hovered ? colors.selectedText : colors.text}>
              {line}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
