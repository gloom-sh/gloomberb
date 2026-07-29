import { Box, Text } from "../../ui";
import type { ReactNode } from "react";
import type { PaneSettingField } from "../../types/plugin";
import { blendHex, colors } from "../../theme/colors";
import { NativeSelect, type NativeSelectElement } from "../ui/native-select";
import { summarizePaneSettingValue } from "./value";

const DESKTOP_TEXT_STYLE = {
  letterSpacing: 0,
  lineHeight: "var(--cell-h)",
} as const;

export function desktopText(weight?: number) {
  return weight ? { ...DESKTOP_TEXT_STYLE, fontWeight: weight } : DESKTOP_TEXT_STYLE;
}

function desktopSubtleSurface(): string {
  return blendHex(colors.panel, colors.bg, 0.22);
}

function desktopHoverSurface(): string {
  return blendHex(colors.bg, colors.borderFocused, 0.08);
}

export function DesktopDialogSurface({
  title,
  subtitle,
  dismiss,
  children,
}: {
  title: string;
  subtitle?: string;
  dismiss: () => void;
  children: ReactNode;
}) {
  return (
    <Box
      width={68}
      maxWidth="calc(100vw - 72px)"
      flexDirection="column"
      style={{
        padding: 12,
      }}
    >
      <Box flexDirection="row" alignItems="flex-start" style={{ marginBottom: 10 }}>
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          <Text fg={colors.textBright} style={desktopText(700)}>{title}</Text>
          {subtitle && (
            <Text fg={colors.textMuted} wrapText style={{ ...desktopText(), marginTop: 3 }}>
              {subtitle}
            </Text>
          )}
        </Box>
        <Box
          width={3}
          height={1}
          alignItems="center"
          justifyContent="center"
          onMouseDown={(event: any) => {
            event.stopPropagation?.();
            event.preventDefault?.();
            dismiss();
          }}
          data-gloom-interactive="true"
          style={{
            borderRadius: 6,
            cursor: "pointer",
            marginLeft: 16,
            color: colors.textMuted,
          }}
        >
          <Text fg={colors.textMuted} style={desktopText(700)}>x</Text>
        </Box>
      </Box>
      {children}
    </Box>
  );
}

function DesktopSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Box
      width="42px"
      height="18px"
      flexDirection="row"
      alignItems="center"
      justifyContent={checked ? "flex-end" : "flex-start"}
      backgroundColor={checked ? colors.selected : desktopSubtleSurface()}
      onMouseDown={(event: any) => {
        event.stopPropagation?.();
        event.preventDefault?.();
        onChange(!checked);
      }}
      data-gloom-interactive="true"
      style={{
        border: `1px solid ${checked ? colors.borderFocused : colors.border}`,
        borderRadius: 999,
        boxShadow: checked
          ? `inset 0 1px 0 ${blendHex(colors.selected, colors.textBright, 0.1)}`
          : `inset 0 1px 0 ${blendHex(colors.bg, colors.textBright, 0.05)}`,
        cursor: "pointer",
        paddingInline: 2,
      }}
    >
      <Box
        width="14px"
        height="14px"
        backgroundColor={checked ? colors.selectedText : colors.textMuted}
        style={{
          borderRadius: 999,
          boxShadow: `0 1px 2px ${blendHex(colors.panel, colors.bg, 0.35)}`,
        }}
      />
    </Box>
  );
}

function DesktopValuePill({ value }: { value: string }) {
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      backgroundColor={desktopSubtleSurface()}
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        padding: "1px 7px",
      }}
    >
      <Text fg={colors.textDim} style={desktopText(600)}>{value}</Text>
    </Box>
  );
}

function DesktopActionPill({ disabled, label }: { disabled: boolean; label: string }) {
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      backgroundColor={disabled ? "transparent" : desktopSubtleSurface()}
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        padding: "1px 7px",
      }}
    >
      <Text fg={disabled ? colors.textMuted : colors.text} style={desktopText(650)}>{label}</Text>
    </Box>
  );
}

function DesktopSettingsRow({
  field,
  selected,
  hovered,
  currentValue,
  onHover,
  onEdit,
  onSelectRef,
  onApply,
}: {
  field: PaneSettingField;
  selected: boolean;
  hovered: boolean;
  currentValue: unknown;
  onHover: () => void;
  onEdit: () => void;
  onSelectRef: (fieldKey: string, element: NativeSelectElement | null) => void;
  onApply: (field: PaneSettingField, value: unknown) => void;
}) {
  const isToggle = field.type === "toggle";
  const disabled = field.type === "action" && field.disabled === true;
  const summary = summarizePaneSettingValue(field, currentValue);
  const control = field.type === "toggle" ? (
    <DesktopSwitch checked={currentValue === true} onChange={(checked) => onApply(field, checked)} />
  ) : field.type === "select" ? (
    <NativeSelect
      value={typeof currentValue === "string" ? currentValue : ""}
      options={field.options}
      includeUnsetOption
      selectRef={(element) => onSelectRef(field.key, element)}
      onChange={(value) => onApply(field, value)}
    />
  ) : field.type === "action" ? (
    <DesktopActionPill disabled={disabled} label={summary} />
  ) : (
    <Box flexDirection="row" alignItems="center" gap={1}>
      <DesktopValuePill value={summary} />
      <Text fg={colors.textMuted} style={desktopText(600)}>Edit</Text>
    </Box>
  );

  return (
    <Box
      flexDirection="column"
      minHeight={field.description ? undefined : 2}
      backgroundColor={hovered || selected ? desktopHoverSurface() : "transparent"}
      onMouseOver={disabled ? undefined : onHover}
      onMouseDown={field.type === "select" ? undefined : (event: any) => {
        event.stopPropagation?.();
        event.preventDefault?.();
        if (disabled) return;
        if (isToggle) onApply(field, currentValue !== true);
        else onEdit();
      }}
      data-gloom-interactive={field.type === "select" || disabled ? undefined : "true"}
      style={{
        borderRadius: 6,
        cursor: field.type === "select" || disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        padding: "7px 4px 8px",
        transition: "background-color 100ms ease",
      }}
    >
      <Box flexDirection="row" alignItems="center" width="100%">
        <Box flexDirection="row" flexGrow={1} minWidth={0} style={{ paddingRight: 12 }}>
          <Text fg={colors.text} style={desktopText(650)}>{field.label}</Text>
        </Box>
        {control}
      </Box>
      {field.description && (
        <Text fg={colors.textMuted} wrapText style={desktopText()}>
          {field.description}
        </Text>
      )}
    </Box>
  );
}

function DesktopSettingsList({
  fields,
  selectedIndex,
  hoveredFieldKey,
  settings,
  onHover,
  onEdit,
  onSelectRef,
  onApply,
}: {
  fields: PaneSettingField[];
  selectedIndex: number;
  hoveredFieldKey: string | null;
  settings: Record<string, unknown>;
  onHover: (field: PaneSettingField, index: number) => void;
  onEdit: (field: PaneSettingField, index: number) => void;
  onSelectRef: (fieldKey: string, element: NativeSelectElement | null) => void;
  onApply: (field: PaneSettingField, value: unknown, index: number) => void;
}) {
  return (
    <Box
      flexDirection="column"
      style={{
        marginTop: 2,
      }}
    >
      {fields.map((field, index) => (
        <DesktopSettingsRow
          key={field.key}
          field={field}
          selected={index === selectedIndex && hoveredFieldKey === null}
          hovered={hoveredFieldKey === field.key}
          currentValue={settings[field.key]}
          onHover={() => onHover(field, index)}
          onEdit={() => onEdit(field, index)}
          onSelectRef={onSelectRef}
          onApply={(targetField, value) => onApply(targetField, value, index)}
        />
      ))}
    </Box>
  );
}

export function DesktopUnavailablePaneSettingsDialog({ dismiss }: { dismiss: () => void }) {
  return (
    <DesktopDialogSurface title="Pane Settings" dismiss={dismiss}>
      <Text fg={colors.textDim} wrapText style={desktopText()}>
        This pane is no longer configurable.
      </Text>
    </DesktopDialogSurface>
  );
}

export function DesktopPaneSettingsDialogBody({
  title,
  dismiss,
  fields,
  selectedIndex,
  hoveredFieldKey,
  settings,
  onHover,
  onEdit,
  onSelectRef,
  onApply,
}: {
  title: string;
  dismiss: () => void;
  fields: PaneSettingField[];
  selectedIndex: number;
  hoveredFieldKey: string | null;
  settings: Record<string, unknown>;
  onHover: (field: PaneSettingField, index: number) => void;
  onEdit: (field: PaneSettingField, index: number) => void;
  onSelectRef: (fieldKey: string, element: NativeSelectElement | null) => void;
  onApply: (field: PaneSettingField, value: unknown, index: number) => void;
}) {
  return (
    <DesktopDialogSurface
      title={title}
      dismiss={dismiss}
    >
      {fields.length === 0 ? (
        <Text fg={colors.textDim} wrapText style={desktopText()}>
          No settings available.
        </Text>
      ) : (
        <DesktopSettingsList
          fields={fields}
          selectedIndex={selectedIndex}
          hoveredFieldKey={hoveredFieldKey}
          settings={settings}
          onHover={onHover}
          onEdit={onEdit}
          onSelectRef={onSelectRef}
          onApply={onApply}
        />
      )}
    </DesktopDialogSurface>
  );
}
