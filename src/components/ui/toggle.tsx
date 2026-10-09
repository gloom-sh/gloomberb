import { Box, Text, TextAttributes, useUiHost } from "../../ui";
import { type ComponentType } from "react";
import { useThemeColors } from "../../theme/theme-context";
import { useShortcut } from "../../react/input";
import { isPlainKey } from "../../utils/keyboard";
import { useRemoteUiNode } from "../../remote/semantic-tree";

interface SegmentedControlOption {
  label: string;
  value: string;
  disabled?: boolean;
  tone?: "positive" | "negative";
}

export interface SegmentedControlProps {
  /** Name of the choice group for assistive technology and semantic access. */
  accessibleLabel?: string;
  options: SegmentedControlOption[];
  value: string;
  onChange?: (value: string) => void;
  focused?: boolean;
  /** For controls whose owning dialog tracks focus independently of native text inputs. */
  allowEditable?: boolean;
  shortcutScope?: string;
  width?: number | "100%";
  wrap?: boolean;
  size?: "default" | "large";
}

export function SegmentedControl({
  accessibleLabel,
  options,
  value,
  onChange,
  focused = false,
  allowEditable = false,
  shortcutScope,
  width,
  wrap = false,
  size = "default",
}: SegmentedControlProps) {
  const colors = useThemeColors();
  const ui = useUiHost();
  const HostSegmentedControl = ui.SegmentedControl as ComponentType<SegmentedControlProps> | undefined;
  useRemoteUiNode({
    role: "select",
    label: accessibleLabel ?? "Segmented control",
    actions: {
      select: (input) => {
        const next = typeof input === "string" ? input : (input as { value?: string } | null)?.value;
        const option = options.find((option) => option.value === next && !option.disabled);
        if (option && option.value !== value) onChange?.(option.value);
      },
    },
    metadata: { value, options },
  });
  useShortcut((event) => {
    const direction = isPlainKey(event, "left")
      ? -1
      : isPlainKey(event, "right")
        ? 1
        : 0;
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();

    const enabled = options.filter((option) => !option.disabled);
    if (enabled.length === 0) return;
    const index = enabled.findIndex((option) => option.value === value);
    const nextIndex = index < 0
      ? 0
      : (index + direction + enabled.length) % enabled.length;
    const next = enabled[nextIndex];
    if (next && next.value !== value) onChange?.(next.value);
  }, {
    // Both hosts: a desktop option holding DOM focus handles its own arrows and
    // stops them, so the two never step twice.
    enabled: focused && !!onChange,
    phase: "before",
    scope: shortcutScope,
    allowEditable,
  });

  if (HostSegmentedControl) {
    return (
      <HostSegmentedControl
        accessibleLabel={accessibleLabel}
        options={options}
        value={value}
        onChange={onChange}
        focused={focused}
        width={width}
        wrap={wrap}
        size={size}
      />
    );
  }

  return (
    <Box
      flexDirection="row"
      flexWrap={wrap ? "wrap" : "nowrap"}
      width={width}
      overflow="hidden"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Box
            key={option.value}
            flexGrow={size === "large" ? 1 : undefined}
            justifyContent="center"
            backgroundColor={active && option.tone ? colors[option.tone] : active ? (focused ? colors.borderFocused : colors.selected) : colors.panel}
            onMouseDown={() => {
              if (!option.disabled) onChange?.(option.value);
            }}
            cursor={option.disabled ? undefined : "pointer"}
          >
            <Text
              // The focused fill is the primary button's, so its text is too:
              // selected text on it is unreadable in the white theme.
              fg={option.disabled ? colors.textMuted : active && option.tone ? colors.bg : option.tone ? colors[option.tone] : active ? (focused ? colors.bg : colors.selectedText) : colors.textDim}
              attributes={active ? TextAttributes.BOLD : 0}
            >
              {` ${option.label} `}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
