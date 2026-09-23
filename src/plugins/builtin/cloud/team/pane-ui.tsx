import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { TeamAccentColor, TeamSummary } from "../../../../api-client";
import { Badge, Button, Checkbox, SectionHeading, TextField, type ButtonVariant } from "../../../../components";
import { colors } from "../../../../theme/colors";
import { Box, Span, Text, TextAttributes, type BoxRenderable } from "../../../../ui";
import { TEAM_ACCENT_COLORS, teamAccentHex, teamPrefix } from "./model";

/**
 * Every control in the pane registers under a field id. The pane keeps one
 * active id and walks the ring with Tab and the arrows; Enter fires the
 * registered action. Mouse users click; keyboard users reach every control.
 */
export interface TeamPaneFocus {
  activeField: string | null;
  setActiveField: (id: string) => void;
  /** True while the pane itself has focus; inputs only take keys then. */
  focused: boolean;
  register: (id: string, action: (() => void) | null) => () => void;
  /** Where the control sits, so the pane can scroll it into view. */
  registerNode: (id: string, node: BoxRenderable | null) => void;
}

export const TeamPaneFocusContext = createContext<TeamPaneFocus>({
  activeField: null,
  setActiveField: () => {},
  focused: false,
  register: () => () => {},
  registerNode: () => {},
});

export function useTeamPaneFocus(): TeamPaneFocus {
  return useContext(TeamPaneFocusContext);
}

function useFieldAction(id: string, action: (() => void) | null) {
  const { register } = useTeamPaneFocus();
  useEffect(() => register(id, action), [action, id, register]);
}

function useFieldNode(id: string): (node: BoxRenderable | null) => void {
  const { registerNode } = useTeamPaneFocus();
  return useCallback((node: BoxRenderable | null) => registerNode(id, node), [id, registerNode]);
}

/** A labeled single-line input, part of the keyboard ring. */
export function PaneField({
  id,
  label,
  value,
  placeholder,
  width,
  labelWidth = 12,
  onChange,
  onSubmit,
  hint,
  hintWidth,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  width: number;
  labelWidth?: number;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  hint?: string;
  /** The hint may run wider than a short input; defaults to the field width. */
  hintWidth?: number;
}) {
  const focus = useTeamPaneFocus();
  const active = focus.activeField === id;
  useFieldAction(id, null);
  const nodeRef = useFieldNode(id);
  const inputWidth = Math.max(8, width - labelWidth - 1);
  return (
    <Box ref={nodeRef} flexDirection="column" width={Math.max(width, hintWidth ?? 0)}>
      <Box height={1} flexDirection="row" alignItems="center" gap={1} onMouseDown={() => focus.setActiveField(id)}>
        <Text width={labelWidth} fg={active ? colors.textBright : colors.textDim} attributes={active ? TextAttributes.BOLD : 0}>
          {`${active ? "> " : "  "}${label}`}
        </Text>
        <TextField
          value={value}
          placeholder={placeholder}
          focused={focus.focused && active}
          width={inputWidth}
          onChange={onChange}
          onSubmit={onSubmit}
          onMouseDown={() => focus.setActiveField(id)}
        />
      </Box>
      {hint ? (
        <Box paddingLeft={labelWidth + 1} width={Math.max(width, hintWidth ?? 0)}>
          <Text fg={colors.textMuted} wrapText width={Math.max(8, (hintWidth ?? width) - labelWidth - 1)}>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** A button in the ring: highlighted when active, fired by Enter or a click. */
export function PaneButton({
  id,
  label,
  variant = "secondary",
  disabled = false,
  compact = false,
  onPress,
  width,
}: {
  id: string;
  label: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  compact?: boolean;
  onPress: () => void;
  width?: number;
}) {
  const focus = useTeamPaneFocus();
  const active = focus.activeField === id;
  useFieldAction(id, disabled ? null : onPress);
  const nodeRef = useFieldNode(id);
  return (
    <Box ref={nodeRef} flexShrink={0}>
      <Button
        label={label}
        variant={variant}
        active={active && !disabled}
        disabled={disabled}
        compact={compact}
        width={width}
        stopPropagation
        onPress={() => {
          focus.setActiveField(id);
          if (!disabled) onPress();
        }}
      />
    </Box>
  );
}

export function PaneCheckbox({
  id,
  label,
  description,
  checked,
  width,
  onChange,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  width: number;
  onChange: (checked: boolean) => void;
}) {
  const focus = useTeamPaneFocus();
  const active = focus.activeField === id;
  useFieldAction(id, () => onChange(!checked));
  const nodeRef = useFieldNode(id);
  return (
    <Box ref={nodeRef} onMouseDown={() => focus.setActiveField(id)}>
      <Checkbox
        label={label}
        description={description}
        checked={checked}
        active={active}
        width={width}
        onChange={(next) => {
          focus.setActiveField(id);
          onChange(next);
        }}
      />
    </Box>
  );
}

/**
 * The accent picker shows every color as a swatch and marks the chosen one
 * with a filled block, and it previews the team the way the rest of the app
 * will show it: the sidebar header, the status chip, a tab marker.
 */
export function AccentPicker({
  id,
  value,
  previewName,
  previewShortName,
  width,
  labelWidth = 12,
  onChange,
}: {
  id: string;
  value: TeamAccentColor;
  previewName: string;
  previewShortName: string;
  width: number;
  labelWidth?: number;
  onChange: (accent: TeamAccentColor) => void;
}) {
  const focus = useTeamPaneFocus();
  const active = focus.activeField === id;
  useFieldAction(id, null);
  const nodeRef = useFieldNode(id);
  const team = { name: previewName || "Your team", shortName: previewShortName || "TM" };
  const accent = teamAccentHex(value);
  return (
    <Box ref={nodeRef} flexDirection="column" width={width} onMouseDown={() => focus.setActiveField(id)}>
      <Box height={1} flexDirection="row" alignItems="center" gap={1}>
        <Text width={labelWidth} fg={active ? colors.textBright : colors.textDim} attributes={active ? TextAttributes.BOLD : 0}>
          {`${active ? "> " : "  "}Accent`}
        </Text>
        <Box flexDirection="row" gap={1}>
          {TEAM_ACCENT_COLORS.map((candidate) => {
            const selected = candidate === value;
            const hex = teamAccentHex(candidate);
            return (
              <Button
                key={candidate}
                label={candidate}
                variant="plain"
                compact
                flush
                stopPropagation
                onPress={() => {
                  focus.setActiveField(id);
                  onChange(candidate);
                }}
              >
                <Badge label=" " color={hex} variant={selected ? "solid" : "subtle"} />
              </Button>
            );
          })}
        </Box>
        <Text fg={accent} attributes={TextAttributes.BOLD}>{value}</Text>
        {active ? <Text fg={colors.textMuted}>{"← →"}</Text> : null}
      </Box>
      <Box height={1} flexDirection="row" gap={2} paddingLeft={labelWidth + 1}>
        <Text fg={accent}>{`${teamPrefix(team)} ${team.name}`}</Text>
        <Text fg={colors.textDim}>
          <Span fg={accent}>●</Span>
          {` ${team.shortName}`}
        </Text>
        <Text fg={colors.textDim}>
          <Span fg={accent}>▎</Span>
          {"Main"}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Destructive actions confirm in place: the button turns into the question
 * and a pair of answers, so nothing pops over the pane.
 */
export function ConfirmAction({
  id,
  label,
  question,
  confirmLabel,
  variant = "danger",
  busy = false,
  onConfirm,
}: {
  id: string;
  label: string;
  question: string;
  confirmLabel: string;
  variant?: ButtonVariant;
  busy?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const focus = useTeamPaneFocus();
  const active = focus.activeField === id;
  useEffect(() => {
    if (!active) setArmed(false);
  }, [active]);
  if (!armed) {
    return <PaneButton id={id} label={label} variant={variant === "danger" ? "ghost" : variant} onPress={() => setArmed(true)} />;
  }
  return (
    <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0} height={1}>
      <Text fg={colors.text}>{question}</Text>
      <PaneButton
        id={id}
        label={busy ? "Working…" : confirmLabel}
        variant={variant}
        disabled={busy}
        onPress={() => {
          onConfirm();
          setArmed(false);
        }}
      />
      <Button label="Cancel" variant="ghost" compact stopPropagation onPress={() => setArmed(false)} />
    </Box>
  );
}

/** The kit heading, with room for a quota beside it ("3 of 25"). */
export function SectionTitle({ children, detail }: { children: string; detail?: string }) {
  return (
    <Box height={1} flexDirection="row" gap={1}>
      <SectionHeading title={children} />
      {detail ? <Text fg={colors.textMuted}>{detail}</Text> : null}
    </Box>
  );
}

export function Muted({ children, width }: { children: ReactNode; width?: number }) {
  return <Text fg={colors.textMuted} wrapText={width !== undefined} width={width}>{children}</Text>;
}

/** A row with a leading accent dot; used for members, invites, and channels. */
export function AccentRow({
  accent,
  children,
  width,
}: {
  accent: string;
  children: ReactNode;
  width: number;
}) {
  return (
    <Box height={1} width={width} flexDirection="row" alignItems="center" gap={1} overflow="hidden">
      <Text fg={accent} flexShrink={0}>●</Text>
      {children}
    </Box>
  );
}

export function teamHeaderColor(team: Pick<TeamSummary, "accentColor">): string {
  return teamAccentHex(team.accentColor);
}
