import { Box, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { hoverBg } from "../../../theme/colors";
import { useThemeColors, useThemeId } from "../../../theme/theme-context";
import { CHART_PALETTE, chartPaletteColor, chartPaletteColorName } from "../../../theme/chart-palette";
import { matchesNavigationKey, useKeybindings } from "../../../app/keybindings";
import { useShortcut } from "../../../react/input";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { isPlainKey } from "../../../utils/keyboard";
import { Button } from "../../ui/button";
import { consumeChartMouseEvent, type ChartMouseEvent } from "../core/pointer";

interface PressEventLike {
  key?: string;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

/**
 * One colour of the chart's palette, wherever a chart offers it (the drawing
 * toolbar, the Indicators dialog, the Series editor): a dot in the colour the
 * theme draws it, filled with the selection while it is the one chosen.
 */
export function ChartColorSwatch({
  color,
  active,
  isDesktopWeb,
  label,
  disabled = false,
  segment = false,
  onPress,
}: {
  color: string;
  active: boolean;
  isDesktopWeb: boolean;
  /** What it is called to assistive technology and in the desktop's tooltip. */
  label: string;
  disabled?: boolean;
  /** One segment of a terminal strip of choices, as a segmented control draws its options. */
  segment?: boolean;
  onPress: () => void;
}) {
  const colors = useThemeColors();
  const drawn = disabled ? colors.textMuted : chartPaletteColor(color, useThemeId());
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      width={segment ? 3 : 2}
      height={1}
      flexShrink={0}
      backgroundColor={active && !disabled ? colors.selected : segment ? colors.panel : undefined}
      hoverBackgroundColor={disabled ? undefined : hoverBg(colors)}
      onMouseDown={(event: ChartMouseEvent) => {
        consumeChartMouseEvent(event);
        if (!disabled) onPress();
      }}
      cursor={disabled ? undefined : "pointer"}
      data-gloom-interactive={disabled ? undefined : "true"}
      data-gloom-role="composite-chart-color"
      data-gloom-label={label}
      data-active={active ? "true" : "false"}
      title={isDesktopWeb ? label : undefined}
      role={isDesktopWeb ? "button" : undefined}
      aria-label={isDesktopWeb ? label : undefined}
      aria-pressed={isDesktopWeb ? active : undefined}
      aria-disabled={isDesktopWeb && disabled ? true : undefined}
      tabIndex={isDesktopWeb && !disabled ? 0 : undefined}
      onKeyDown={isDesktopWeb && !disabled
        ? (event: PressEventLike) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault?.();
          event.stopPropagation?.();
          onPress();
        }
        : undefined}
      // The chosen one is a ring around a smaller dot, inside the same 14px, so
      // it reads at a glance without nudging its neighbours.
      style={isDesktopWeb
        ? {
          width: 14,
          height: 14,
          borderRadius: "var(--gloom-radius-full)",
          backgroundColor: drawn,
          border: `1.5px solid ${active && !disabled ? colors.text : "transparent"}`,
          padding: active && !disabled ? 1.5 : 0,
          backgroundClip: active && !disabled ? "content-box" : "border-box",
        }
        : undefined}
    >
      {isDesktopWeb ? null : <Text fg={drawn}>{active && !disabled ? "◉" : "●"}</Text>}
    </Box>
  );
}

/**
 * A study's or a series' colour: Auto, the colour the theme gives it (and
 * keeps giving it when the theme changes), then the chart's palette. The
 * pointer picks one; while `focused`, Left and Right step through them.
 */
export function ChartColorChoice({
  label,
  value,
  onChange,
  disabled = false,
  focused = false,
  allowEditable = false,
  shortcutScope,
}: {
  /** What it colours, for assistive technology: `SMA 50 colour`. */
  label: string;
  /** The picked colour, or undefined for Auto. */
  value: string | undefined;
  onChange: (color: string | undefined) => void;
  disabled?: boolean;
  focused?: boolean;
  /** For a dialog that tracks its own focus apart from its text fields. */
  allowEditable?: boolean;
  shortcutScope?: string;
}) {
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  const colors = useThemeColors();
  const bindings = useKeybindings();
  const choices: Array<string | undefined> = [undefined, ...CHART_PALETTE];
  useRemoteUiNode({
    role: "select",
    label,
    disabled,
    actions: {
      select: (input) => {
        const next = typeof input === "string" ? input : (input as { value?: string } | null)?.value;
        if (disabled || next === undefined) return;
        const color = next === "auto" ? undefined : CHART_PALETTE.find((entry) => entry === next);
        if ((next === "auto" || color) && color !== value) onChange(color);
      },
    },
    metadata: {
      value: value ?? "auto",
      options: choices.map((color) => ({ value: color ?? "auto", label: color ? chartPaletteColorName(color) : "Auto" })),
    },
  });
  useShortcut((event) => {
    const direction = matchesNavigationKey(bindings, "left", event, { allowEditable, defaultMatches: isPlainKey(event, "left") })
      ? -1
      : matchesNavigationKey(bindings, "right", event, { allowEditable, defaultMatches: isPlainKey(event, "right") })
        ? 1
        : 0;
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const index = choices.indexOf(value);
    onChange(choices[(Math.max(0, index) + direction + choices.length) % choices.length]);
  }, {
    enabled: focused && !disabled,
    phase: "before",
    scope: shortcutScope,
    allowEditable,
  });

  const auto = value === undefined && !disabled;
  // The terminal draws the choices as a segmented control's strip, beside the
  // form's other choices; the desktop draws the toolbar's round swatches.
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      flexShrink={0}
      data-gloom-role="chart-color-choice"
      style={isDesktopWeb ? { gap: "var(--gloom-space-xs)" } : undefined}
    >
      {isDesktopWeb ? (
        <Button label="Auto" variant="quiet" active={auto} disabled={disabled} onPress={() => onChange(undefined)} />
      ) : (
        <Box
          backgroundColor={auto ? colors.selected : colors.panel}
          hoverBackgroundColor={disabled || auto ? undefined : hoverBg(colors)}
          cursor={disabled ? undefined : "pointer"}
          onMouseDown={() => {
            if (!disabled) onChange(undefined);
          }}
        >
          <Text
            fg={disabled ? colors.textMuted : auto ? colors.selectedText : colors.textDim}
            attributes={auto ? TextAttributes.BOLD : 0}
          >
            {" Auto "}
          </Text>
        </Box>
      )}
      {CHART_PALETTE.map((color) => (
        <ChartColorSwatch
          key={color}
          color={color}
          active={value === color}
          disabled={disabled}
          segment={!isDesktopWeb}
          isDesktopWeb={isDesktopWeb}
          label={`${label}: ${chartPaletteColorName(color)}`}
          onPress={() => onChange(color)}
        />
      ))}
    </Box>
  );
}
