import { Box, Text, useUiCapabilities } from "../../../ui";
import { MenuPopover } from "../../ui/menu";
import { colors } from "../../../theme/colors";
import { MENU_Z_INDEX, truncateMenuText } from "./menu";
import { t } from "../../../i18n";
import { displayWidth, padTo } from "../../../utils/format";

export interface ActionMenuState {
  paneId: string;
  x: number;
  y: number;
  width: number;
  items: Array<{ id: string; label: string; accelerator?: string; action: () => void }>;
  /** Desktop: where the menu pops out from, in px (the `...` button or the pointer). */
  anchor?: { x: number; y: number; placement: "bottom-start" | "bottom-end" };
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
  if (!menuState) return null;

  if (nativePaneChrome) {
    return (
      <MenuPopover
        open
        onOpenChange={(open) => { if (!open) onClose(); }}
        anchorPoint={menuState.anchor ?? { x: 0, y: 0 }}
        placement={menuState.anchor?.placement ?? "bottom-start"}
        label="Pane"
        items={menuState.items.map((item) => ({ id: item.id, label: t(item.label), hint: item.accelerator }))}
        onSelect={(id) => {
          const item = menuState.items.find((entry) => entry.id === id);
          onClose();
          item?.action();
        }}
      />
    );
  }

  return (
    <Box
      position="absolute"
      left={menuState.x}
      top={menuState.y}
      width={menuState.width}
      height={menuState.items.length + 2}
      backgroundColor={colors.panel}
      border
      borderStyle="single"
      borderColor={colors.borderFocused}
      zIndex={MENU_Z_INDEX}
      flexDirection="column"
    >
      {menuState.items.map((item) => {
        const hovered = hoveredMenuItemId === item.id;
        const innerWidth = Math.max(1, menuState.width - 2);
        const accelerator = item.accelerator ?? "";
        const acceleratorWidth = accelerator.length;
        const labelWidth = accelerator ? Math.max(1, innerWidth - acceleratorWidth - 1) : innerWidth;
        const label = truncateMenuText(t(item.label), labelWidth);
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
