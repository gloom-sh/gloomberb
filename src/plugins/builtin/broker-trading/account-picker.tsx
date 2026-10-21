import { useCallback, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { Badge, Button, DialogFrame, DisclosureMarker, ListView, type SelectControl } from "../../../components";
import { listCursorMove } from "../../../components/ui/list-view";
import { useThemeColors } from "../../../theme/theme-context";
import { blendForContrast, higherContrast } from "../../../theme/color-utils";
import type { BrokerTradingMode } from "../../../types/trading";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { useDialog, useDialogKeyboard, type PromptContext } from "../../../ui/dialog";

export interface BrokerAccountChoice {
  value: string;
  label: string;
  profileLabel?: string;
  tradingMode?: BrokerTradingMode;
}

export interface BrokerAccountPickerProps {
  accounts: readonly BrokerAccountChoice[];
  value?: string;
  onChange(value: string): void;
  disabled?: boolean;
  controlRef?: Ref<SelectControl>;
  active?: boolean;
  width?: number;
  showMode?: boolean;
}

export function accountModeLabel(mode: BrokerTradingMode | undefined): string {
  return mode === "simulation" ? "SIMULATION" : mode === "live" ? "LIVE" : "MODE UNKNOWN";
}

function BrokerAccountChoiceDialog({ accounts, value, resolve }: PromptContext<string> & Pick<BrokerAccountPickerProps, "accounts" | "value">) {
  const colors = useThemeColors();
  const [index, setIndex] = useState(() => accounts.findIndex((account) => account.value === value));
  // Read the latest key movement, not the last rendered account, on Enter.
  const cursor = useRef(index);
  const selectIndex = (next: number) => { cursor.current = next; setIndex(next); };
  useDialogKeyboard((event) => {
    event.stopPropagation();
    const move = listCursorMove(event, 5);
    if (move) { event.preventDefault(); selectIndex(move(accounts, cursor.current)); }
    else if (event.name === "return" || event.name === "enter") { event.preventDefault(); const selected = accounts[cursor.current]; if (selected) resolve(selected.value); }
    else if (event.name === "escape") { event.preventDefault(); resolve(""); }
  }, { allowEditable: true });
  return <DialogFrame title="Choose an account" subtitle="Simulation accounts first. Choose before trading." footer="↑↓ choose · Enter select · Esc back" onClose={() => resolve("")}>
    <Box width={64} flexDirection="column">
      <ListView items={accounts.map((account) => ({ id: account.value, label: account.label, detail: accountModeLabel(account.tradingMode) }))}
        selectedIndex={index} onSelect={selectIndex} onActivate={(item) => resolve(item.id)} selectOnHover
        height={Math.min(Math.max(accounts.length, 1), 6) * 2} rowHeight={2} rowGap={0} scrollable={accounts.length > 6}
        surface="framed" emptyMessage="No accounts available." remoteLabel="Broker accounts"
        renderRow={(_item, state, rowIndex) => {
          const account = accounts[rowIndex]!;
          return <Box flexDirection="row" alignItems="flex-start" gap={1} width="100%" minWidth={0}>
            <Box width={1}>{state.selected ? <DisclosureMarker expanded={false} color={colors.textBright} /> : null}</Box>
            <Box flexDirection="column" flexGrow={1} minWidth={0}>
              <Text fg={colors.text} attributes={state.selected ? TextAttributes.BOLD : undefined} truncate wrapMode="none">{account.label}</Text>
              <Text fg={colors.textDim} truncate wrapMode="none">{account.profileLabel ?? "Broker account"}</Text>
            </Box>
            <Box flexShrink={0}><Badge label={accountModeLabel(account.tradingMode)} tone={account.tradingMode === "simulation" ? "accent" : "negative"} /></Box>
          </Box>;
        }} />
    </Box>
  </DialogFrame>;
}

/** Keeps native and terminal choices visually identical, including account mode badges. */
export function BrokerAccountPicker({ accounts, value, onChange, disabled = false, controlRef, active, width, showMode = false }: BrokerAccountPickerProps) {
  const native = useUiCapabilities().nativePaneChrome;
  const dialog = useDialog();
  const colors = useThemeColors();
  const choices = useMemo(() => [...accounts].sort((a, b) => Number(b.tradingMode === "simulation") - Number(a.tradingMode === "simulation")), [accounts]);
  const current = accounts.find((account) => account.value === value);
  const modeColor = blendForContrast(current?.tradingMode === "simulation" ? colors.positive : colors.negative, colors.bg, higherContrast("#000000", "#ffffff", colors.bg), 4.5);
  const choose = useRef<(next: string | undefined) => void>(() => {});
  choose.current = (next) => { if (!disabled && next && next !== value && accounts.some((account) => account.value === next)) onChange(next); };
  const opened = useRef(false);
  const open = useCallback(() => {
    if (disabled || opened.current || !choices.length) return;
    opened.current = true;
    void dialog.prompt<string>({ closeOnClickOutside: true, style: { width: 72 }, content: (context) => <BrokerAccountChoiceDialog {...context} accounts={choices} value={value} /> })
      .then((next) => choose.current(next)).catch(() => {}).finally(() => { opened.current = false; });
  }, [choices, dialog, disabled, value]);
  useImperativeHandle(controlRef, () => ({ open }), [open]);
  return <Button label="Choose account" variant="quiet" flush active={active} disabled={disabled || !choices.length} width={width} onPress={open} stopPropagation>
    <Box flexDirection="row" gap={1} flexGrow={1} minWidth={0} alignItems="center">
      <Text fg={disabled ? colors.textMuted : colors.text} truncate wrapMode="none" flexShrink={1} minWidth={0}>{`${active && !native ? "> " : ""}${current?.label ?? "Choose an account"}`}</Text>
      {showMode && current ? <Text fg={modeColor} attributes={TextAttributes.BOLD}>{current.tradingMode === "simulation" ? "SIM" : accountModeLabel(current.tradingMode)}</Text> : null}
      <DisclosureMarker expanded color={colors.textDim} />
    </Box>
  </Button>;
}
