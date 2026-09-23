import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Box, Text, TextAttributes, useUiHost, type HostMenuProps, type HostMenuItem } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import { useShortcut } from "../../react/input";
import { useRemoteUiNode } from "../../remote/semantic-tree";
import { Popover } from "./popover";

export type MenuItem = HostMenuItem;
export type MenuProps = HostMenuProps;

/**
 * The one list of choices used by every menu in the app: filter menus, select
 * fields, multi-selects, the pane menu. Single-select marks the current item
 * with a check; multi-select gives every item a checkbox; plain menus show an
 * optional hint (a shortcut) on the right. Keyboard: arrows or j/k move, Enter
 * or Space chooses, Esc closes (through the popover).
 */
export function Menu(props: MenuProps) {
  const HostMenu = useUiHost().Menu as ComponentType<MenuProps> | undefined;
  useRemoteUiNode({
    role: "menu",
    label: props.label ?? props.title ?? "Menu",
    actions: {
      select: (input) => {
        const id = typeof input === "string" ? input : (input as { id?: string } | null)?.id;
        const item = props.items.find((entry) => entry.id === id && entry.kind !== "divider" && entry.kind !== "heading" && !entry.disabled);
        if (item) props.onSelect(item.id);
      },
    },
    metadata: {
      selection: props.selection ?? "none",
      items: props.items.filter((item) => item.kind !== "divider").map((item) => ({ id: item.id, label: item.label, selected: item.selected, checked: item.checked })),
    },
  });
  if (HostMenu) return <HostMenu {...props} />;
  return <TerminalMenu {...props} />;
}

function selectable(item: MenuItem): boolean {
  return item.kind !== "divider" && item.kind !== "heading" && !item.disabled;
}

/** Cell-drawn fallback for the terminal, where menus usually open as dialogs. */
function TerminalMenu({ items, onSelect, selection = "none", title, onClose }: MenuProps) {
  const colors = useThemeColors();
  const enabled = useMemo(() => items.filter(selectable), [items]);
  const [highlighted, setHighlighted] = useState<string | null>(
    () => items.find((item) => item.selected)?.id ?? enabled[0]?.id ?? null,
  );
  const choose = (id: string) => {
    onSelect(id);
    if (selection !== "multi") onClose?.();
  };
  useShortcut((event) => {
    const index = enabled.findIndex((item) => item.id === highlighted);
    const key = event.name;
    if (key === "down" || key === "j") setHighlighted(enabled[Math.min(enabled.length - 1, index + 1)]?.id ?? null);
    else if (key === "up" || key === "k") setHighlighted(enabled[Math.max(0, index - 1)]?.id ?? null);
    else if ((key === "return" || key === "enter" || key === "space") && highlighted) choose(highlighted);
    else if (key === "escape") onClose?.();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }, { phase: "before" });

  return (
    <Box flexDirection="column">
      {title && <Text fg={colors.textMuted}>{title}</Text>}
      {items.map((item) => {
        if (item.kind === "divider") return <Box key={item.id} height={1} />;
        if (item.kind === "heading") return <Text key={item.id} fg={colors.textMuted}>{item.label}</Text>;
        const active = item.id === highlighted;
        const marker = selection === "multi" ? (item.checked ? "[x] " : "[ ] ") : selection === "single" ? (item.selected ? "✓ " : "  ") : "";
        return (
          <Box
            key={item.id}
            height={1}
            flexDirection="row"
            backgroundColor={active ? colors.selected : undefined}
            onMouseDown={() => { if (!item.disabled) choose(item.id); }}
          >
            <Text
              fg={item.disabled ? colors.textMuted : active ? colors.selectedText : colors.text}
              attributes={item.selected ? TextAttributes.BOLD : 0}
            >
              {`${marker}${item.label}`}
            </Text>
            {item.hint && <Box flexGrow={1} />}
            {item.hint && <Text fg={colors.textMuted}>{` ${item.hint}`}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}

export interface MenuPopoverProps extends Omit<MenuProps, "onClose"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The control the menu opens from. Omit and pass `anchorPoint` for a pointer menu. */
  trigger?: ReactNode;
  anchorPoint?: { x: number; y: number } | null;
  placement?: "bottom-start" | "bottom-end";
  minWidth?: number | string;
  maxWidth?: number | string;
  /** Close after a choice. Defaults to true except for multi-select. */
  closeOnSelect?: boolean;
  /** See Popover `focusOnOpen`; false for an autocomplete under an input. */
  focusOnOpen?: boolean;
}

/** A Menu in the kit Popover. Every dropdown and pop-up menu is one of these. */
export function MenuPopover({
  open,
  onOpenChange,
  trigger,
  anchorPoint,
  placement,
  minWidth = 170,
  maxWidth,
  closeOnSelect,
  focusOnOpen,
  ...menu
}: MenuPopoverProps) {
  const shouldClose = closeOnSelect ?? (menu.selection ?? "none") !== "multi";
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      anchorPoint={anchorPoint}
      placement={placement}
      minWidth={minWidth}
      maxWidth={maxWidth}
      label={menu.label ?? menu.title}
      density="menu"
      focusOnOpen={focusOnOpen}
    >
      <Menu
        {...menu}
        onSelect={(id) => {
          menu.onSelect(id);
          if (shouldClose) onOpenChange(false);
        }}
        onClose={() => onOpenChange(false)}
      />
    </Popover>
  );
}
