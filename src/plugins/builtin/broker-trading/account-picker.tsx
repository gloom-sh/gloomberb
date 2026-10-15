import { useMemo, type Ref } from "react";
import { Badge, SelectButton, type SelectControl } from "../../../components";
import type { BrokerTradingMode } from "../../../types/trading";
import { Box } from "../../../ui";

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
const modeLabel = (mode?: BrokerTradingMode) => mode === "simulation" ? "SIM" : mode === "live" ? "LIVE" : "MODE UNKNOWN";

/** Shared picker, with simulation first and no implicit account selection. */
export function BrokerAccountPicker({ accounts, value, onChange, disabled, controlRef, active, width, showMode = false }: BrokerAccountPickerProps) {
  const choices = useMemo(() => [...accounts].sort((a, b) => Number(b.tradingMode === "simulation") - Number(a.tradingMode === "simulation")), [accounts]);
  const current = accounts.find((account) => account.value === value);
  return <Box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
    <SelectButton label="Choose account" title="Choose an account" showLabel={false} value={value ?? "__choose_account__"} disabled={disabled || !choices.length}
      emphasized={active} controlRef={controlRef} width={width === undefined ? undefined : Math.max(12, width - (showMode ? 8 : 0))}
      options={[...(!current ? [{ value: "__choose_account__", label: "Choose an account", disabled: true }] : []), ...choices.map((account) => ({
        value: account.value, label: `${account.label} · ${account.tradingMode === "simulation" ? "SIMULATION" : modeLabel(account.tradingMode)}`, short: account.label, description: account.profileLabel,
      }))]} onChange={onChange} />
    {showMode && current ? <Badge label={modeLabel(current.tradingMode)} tone={current.tradingMode === "simulation" ? "accent" : "negative"} /> : null}
  </Box>;
}
