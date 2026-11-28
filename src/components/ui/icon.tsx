import { type ComponentType } from "react";
import { Box, Text, useUiHost } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import { useRemoteUiNode, useRemoteUiScope } from "../../remote/semantic-tree";
import { t } from "../../i18n";

export type IconName =
  | "more"
  | "help"
  | "close"
  | "zap"
  | "sqrt"
  | "bell"
  | "marker"
  | "lock"
  | "warning"
  | "back"
  | "chevron-down"
  | "chevron-right"
  | "search"
  | "plus"
  | "check"
  | "minimize"
  | "maximize"
  | "restore"
  | "cloud"
  | "sound-on"
  | "sound-off"
  | "play"
  | "pause"
  | "user"
  | "sort-up"
  | "sort-down"
  | "grip"
  | "image"
  | "thumbs-up"
  | "thumbs-down"
  | "ask"
  | "bot"
  | "team"
  | "pro"
  | "clock"
  | "edit"
  | "mail"
  | "reply"
  | "react";

/** Terminal glyph for each icon; the desktop host draws SVG. */
export const ICON_GLYPHS: Record<IconName, string> = {
  more: "...",
  help: "?",
  close: "x",
  // Live data, and nothing else: the live-streaming quick setting.
  zap: "⚡",
  sqrt: "√",
  // A notice the pane sends you (an alert), and a reading marked over the
  // data (the current IV on a volatility history). Text symbols, one cell
  // wide in any terminal, unlike the bell emoji or the bullseye.
  bell: "⍾",
  marker: "⌖",
  lock: "🔒",
  warning: "⚠",
  back: "←",
  "chevron-down": "▾",
  "chevron-right": "›",
  search: "/",
  plus: "+",
  check: "✓",
  minimize: "_",
  maximize: "□",
  restore: "❐",
  cloud: "☁",
  "sound-on": "◖)",
  "sound-off": "◖·",
  play: "▸",
  pause: "‖",
  user: "@",
  "sort-up": "▲",
  "sort-down": "▼",
  grip: "::",
  image: "▣",
  // Votes rather than emoji: an emoji keeps its own colours, so it could not
  // show which thumb is chosen.
  "thumbs-up": "+1",
  "thumbs-down": "-1",
  // Ask Gloom: a four-point spark.
  ask: "✦",
  // Who someone is in chat: a bot's square face, the Gloom mark (a core in a
  // ring) for the team, a gem for Pro. Three shapes, so they read without
  // colour, each one cell wide in any terminal: none is an emoji or a
  // character East Asian terminals widen to two cells.
  bot: "⍠",
  team: "◉",
  pro: "◊",
  // Time, for data that arrives late (a delayed quote).
  clock: "◷",
  edit: "✎",
  // A message written to you (a DM): text presentation, one cell.
  mail: "✉",
  // Answer a message, and add a reaction to it: the keys that do it, Enter's
  // return symbol and the plus. Menlo, SF Mono, Cascadia and DejaVu Sans Mono
  // each draw the return symbol themselves, at the size of the glyphs beside
  // it; ↵ is missing from SF Mono and Cascadia and comes small from a
  // fallback font, and a face shrinks to a dot at text size. One cell each:
  // the hooked arrow and the outlined face are emoji-capable and take two.
  reply: "⏎",
  react: "+",
};

export interface IconProps {
  name: IconName;
  /** Pixel size on the desktop; the terminal draws one glyph. */
  size?: number;
  color?: string;
  /**
   * Desktop: takes its row's full height and draws in the middle of it. A
   * box centred in a row an odd number of pixels taller lands on a whole
   * pixel, half a pixel off; the drawing inside the box does not.
   */
  fullHeight?: boolean;
}

/** One glyph from the app's icon set. */
export function Icon({ name, size = 12, color, fullHeight }: IconProps) {
  const colors = useThemeColors();
  const HostIcon = useUiHost().Icon as ComponentType<IconProps> | undefined;
  if (HostIcon) return <HostIcon name={name} size={size} color={color} fullHeight={fullHeight} />;
  return <Text fg={color ?? colors.textDim} selectable={false}>{ICON_GLYPHS[name]}</Text>;
}

/** What a press hands back: where it happened, so a menu can open from the button. */
export interface IconButtonPressEvent {
  target?: unknown;
  pixelX?: number;
  pixelY?: number;
  button?: number;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface IconButtonProps {
  icon: IconName;
  /** Accessible name. Also the tooltip unless `title` is given. */
  label: string;
  /** Tooltip when it should say more than the name (a count, a state). */
  title?: string;
  /**
   * Key that triggers the same action, announced to assistive tech and named
   * in the tooltip. Give it only while the key acts on what this button acts
   * on: a row's action names its key on the row the keyboard is on, while its
   * pane has the keys, and on no other row.
   */
  shortcut?: string;
  /** The press opens a menu or dialog. */
  hasPopup?: "menu" | "dialog";
  /** The menu or dialog it opens is open. */
  expanded?: boolean;
  onPress?: (event?: IconButtonPressEvent) => void;
  /** Toggle state for a pressed/unpressed icon (quick settings). */
  pressed?: boolean;
  color?: string;
  disabled?: boolean;
  size?: number;
  /** Keep the press from also reaching a row or header behind the button. */
  stopPropagation?: boolean;
  /**
   * The pointer moved onto or off it. The terminal draws no tooltip, so a row
   * of icons names the one under the pointer beside itself with this.
   */
  onHoverChange?: (hovered: boolean) => void;
  /**
   * Desktop: while keyboard focus is on it, show its tooltip text beside it in
   * the tooltip surface, since a tooltip shows only under the pointer. For
   * icons with no other visible name (a row's actions that show only when
   * used). The label goes beside the nearest `ICON_GROUP_ATTRIBUTE` element
   * holding the button, so it never covers the icons next to it, follows the
   * group as its row moves, and hides while a list has the group scrolled
   * out of view. A pointer press, which focuses the button too, shows
   * nothing. When its pane gives up the app's focus (Tab to the next pane),
   * the button lets go of the page's focus as well.
   */
  focusLabel?: boolean;
}

/**
 * Marks a row of icon buttons whose `focusLabel` goes beside the whole row,
 * not over the icons next to the focused one.
 */
export const ICON_GROUP_ATTRIBUTE = "data-gloom-icon-group";

/**
 * The one icon-only button: pane header actions, footer indicators, dialog
 * close, window controls. Desktop draws a hover-washed square with an SVG;
 * the terminal draws the glyph with a space either side.
 */
export function IconButton({
  icon,
  label: rawLabel,
  title,
  shortcut,
  hasPopup,
  expanded,
  onPress,
  pressed,
  color,
  disabled = false,
  size = 12,
  stopPropagation = true,
  onHoverChange,
  focusLabel,
}: IconButtonProps) {
  const colors = useThemeColors();
  const label = t(rawLabel);
  // Of the surface it is drawn in, as a kit Button is: a prompt's dialog's close is that prompt's.
  const remoteScope = useRemoteUiScope();
  useRemoteUiNode({
    role: "button",
    label,
    disabled,
    actions: { press: () => { if (!disabled) onPress?.(); } },
    metadata: { icon, pressed, expanded, ...(remoteScope ? { scope: remoteScope } : {}) },
  });
  const HostIconButton = useUiHost().IconButton as ComponentType<IconButtonProps> | undefined;
  if (HostIconButton) {
    return (
      <HostIconButton
        icon={icon}
        label={label}
        title={title}
        shortcut={shortcut}
        hasPopup={hasPopup}
        expanded={expanded}
        onPress={onPress}
        pressed={pressed}
        color={color}
        disabled={disabled}
        size={size}
        stopPropagation={stopPropagation}
        onHoverChange={onHoverChange}
        focusLabel={focusLabel}
      />
    );
  }
  return (
    <Box
      height={1}
      flexDirection="row"
      cursor={disabled || !onPress ? "default" : "pointer"}
      data-gloom-interactive={onPress && !disabled ? "true" : undefined}
      onMouseDown={(event: IconButtonPressEvent) => {
        if (stopPropagation) {
          event.preventDefault?.();
          event.stopPropagation?.();
        }
        if (!disabled) onPress?.(event);
      }}
      {...(onHoverChange ? { onMouseOver: () => onHoverChange(true), onMouseOut: () => onHoverChange(false) } : {})}
    >
      {/* Pressed takes the colour the desktop and the terminal pane header give an active toggle. */}
      <Text fg={disabled ? colors.textMuted : color ?? (pressed ? colors.warning : colors.textDim)} selectable={false}>
        {` ${ICON_GLYPHS[icon]} `}
      </Text>
    </Box>
  );
}
