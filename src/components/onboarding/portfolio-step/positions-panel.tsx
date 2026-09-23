import { useEffect, useRef, useState, type RefObject } from "react";
import { Box, Text, TextAttributes, useUiHost, type InputRenderable } from "../../../ui";
import { useThemeColors } from "../../../theme/theme-context";
import { blendHex, priceColor } from "../../../theme/colors";
import { t, tf } from "../../../i18n";
import { formatMarketPrice } from "../../../market-data/market/format";
import { formatPercentRaw } from "../../../utils/format";
import { Button, NumberField, TextField } from "../../ui";
import { ONBOARDING_DESKTOP } from "../onboarding-frame";
import {
  POSITION_FIELDS,
  type OnboardingPositionRow,
  type OnboardingPositionsState,
  type PositionFieldId,
} from "../wizard-positions";

/** Removes the position under the keyboard cursor; the wizard binds it. */
export const REMOVE_POSITION_KEY = "d";

/** Rows the terminal card has room for. */
const TUI_VISIBLE_ROWS = 4;

const FIELD_LABELS: Record<PositionFieldId, string> = {
  ticker: "Ticker",
  shares: "Shares",
  avgCost: "Avg cost",
};

const FIELD_PLACEHOLDERS: Record<PositionFieldId, string> = {
  ticker: "e.g. AAPL",
  shares: "optional",
  avgCost: "current price",
};

/** Company name and last price for the symbol being typed, or why it will not resolve. */
function PreviewLine({ preview, error }: Pick<OnboardingPositionsState, "preview" | "error">) {
  const colors = useThemeColors();
  if (error) return <Text fg={colors.negative} wrapText>{error}</Text>;
  if (preview.status === "idle") return null;
  if (preview.status === "checking") {
    return <Text fg={colors.textDim}>{tf("{query} checking...", { query: preview.query })}</Text>;
  }
  if (preview.status === "missing") return <Text fg={colors.textMuted}>{preview.message}</Text>;
  const price = preview.quote?.price;
  const change = preview.quote?.changePercent;
  return (
    <Box flexDirection="row" minWidth={0} overflow="hidden">
      <Text fg={colors.text} attributes={TextAttributes.BOLD}>{preview.symbol}</Text>
      {preview.name ? <Text fg={colors.textDim}>{`  ${preview.name}`}</Text> : null}
      {price != null ? <Text fg={colors.text}>{`  ${formatMarketPrice(price, { maxWidth: 12 })}`}</Text> : null}
      {change != null ? <Text fg={priceColor(change, colors)}>{` ${formatPercentRaw(change)}`}</Text> : null}
      {preview.duplicate ? <Text fg={colors.textMuted}>{t("  already added")}</Text> : null}
    </Box>
  );
}

const wholeCurrencyFormatters = new Map<string, Intl.NumberFormat>();

/** Position value rounded to whole units: cents add noise next to a share count. */
function formatWholeCurrency(value: number, currency: string): string {
  let formatter = wholeCurrencyFormatters.get(currency);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      });
    } catch {
      formatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }
    wholeCurrencyFormatters.set(currency, formatter);
  }
  return formatter.format(value);
}

function positionSummary(row: OnboardingPositionRow): string {
  if (row.shares === null) return t("following");
  const shares = Number.isInteger(row.shares) ? String(row.shares) : row.shares.toFixed(4).replace(/\.?0+$/, "");
  const cost = row.avgCost === null ? "" : ` @ ${formatMarketPrice(row.avgCost, { maxWidth: 12 })}`;
  return `${shares}${cost}`;
}

type ScrollTarget = {
  matches?(selector: string): boolean;
  scrollIntoView?(options: { block: "nearest" }): void;
};

function DesktopPositionRow({
  row,
  selected,
  onRemove,
}: {
  row: OnboardingPositionRow;
  /** Under the keyboard cursor: lit like a hovered row, with its Remove key shown. */
  selected: boolean;
  onRemove: (symbol: string) => void;
}) {
  const colors = useThemeColors();
  const [hovered, setHovered] = useState(false);
  const rowRef = useRef<ScrollTarget | null>(null);
  useEffect(() => {
    // The pointer lit it: scrolling now would slide another row under it.
    if (!selected || rowRef.current?.matches?.(":hover")) return;
    rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const lit = hovered || selected;
  return (
    <Box
      ref={rowRef}
      flexDirection="row"
      alignItems="center"
      minWidth={0}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      style={{
        height: 32,
        padding: "0 10px",
        borderRadius: 6,
        backgroundColor: lit ? blendHex(colors.panel, colors.textBright, 0.05) : "transparent",
      }}
      data-gloom-role="onboarding-position"
    >
      <Box style={{ width: 64, flexShrink: 0 }}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{row.symbol}</Text>
      </Box>
      <Box flexGrow={1} minWidth={0} overflow="hidden">
        <Text fg={colors.textDim}>{row.name}</Text>
      </Box>
      <Box flexShrink={0} style={{ marginLeft: 16 }}>
        <Text fg={colors.text}>{positionSummary(row)}</Text>
      </Box>
      <Box flexShrink={0} justifyContent="flex-end" flexDirection="row" style={{ width: 96 }}>
        <Text fg={row.value === null ? colors.textMuted : colors.textBright}>
          {row.value === null ? "" : formatWholeCurrency(row.value, row.currency)}
        </Text>
      </Box>
      <Box flexShrink={0} justifyContent="flex-end" flexDirection="row" style={{ width: 64, marginLeft: 8 }}>
        {lit ? (
          <Button
            label="Remove"
            variant="plain"
            compact
            stopPropagation
            shortcut={selected ? REMOVE_POSITION_KEY : undefined}
            onPress={() => onRemove(row.symbol)}
          />
        ) : null}
      </Box>
    </Box>
  );
}

function DesktopPositionsPanel({
  state,
  inputRef,
  editing,
  selectedSymbol,
}: PositionsPanelProps) {
  const colors = useThemeColors();
  const fieldProps = (field: PositionFieldId, index: number) => ({
    label: t(FIELD_LABELS[field]),
    inputRef: index === state.fieldIdx ? inputRef : undefined,
    value: state.draft[field],
    placeholder: t(FIELD_PLACEHOLDERS[field]),
    focused: editing && index === state.fieldIdx && !state.submitting,
    size: "comfortable" as const,
    backgroundColor: colors.panel,
    textColor: colors.text,
    placeholderColor: colors.textDim,
    onMouseDown: () => state.focusField(index),
  });

  return (
    <Box flexDirection="column" style={{ marginTop: ONBOARDING_DESKTOP.afterHeader }}>
      <Box flexDirection="row" alignItems="flex-end" style={{ gap: 10 }}>
        <Box flexGrow={1} minWidth={0}>
          <TextField {...fieldProps("ticker", 0)} onChange={(value) => state.setField("ticker", value)} />
        </Box>
        <Box style={{ width: 96, flexShrink: 0 }}>
          <NumberField {...fieldProps("shares", 1)} onChange={(value) => state.setField("shares", value)} />
        </Box>
        <Box style={{ width: 128, flexShrink: 0 }}>
          <NumberField {...fieldProps("avgCost", 2)} onChange={(value) => state.setField("avgCost", value)} />
        </Box>
        <Box style={{ flexShrink: 0 }}>
          <Button
            label={state.submitting ? "Adding..." : "Add"}
            variant="secondary"
            height="26px"
            disabled={state.submitting}
            onPress={() => { void state.addPosition(); }}
          />
        </Box>
      </Box>
      <Box style={{ minHeight: 18, marginTop: 8 }}>
        <PreviewLine preview={state.preview} error={state.error} />
      </Box>
      {state.positions.length > 0 ? (
        <Box flexDirection="column" style={{ marginTop: 16, maxHeight: 200, overflowY: "auto" }}>
          {state.positions.map((row) => (
            <DesktopPositionRow
              key={row.symbol}
              row={row}
              selected={row.symbol === selectedSymbol}
              onRemove={(symbol) => { void state.removePosition(symbol); }}
            />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function TuiFieldRow({
  field,
  index,
  state,
  inputRef,
  editing,
}: {
  field: PositionFieldId;
  index: number;
  state: OnboardingPositionsState;
  inputRef: RefObject<InputRenderable | null>;
  editing: boolean;
}) {
  const colors = useThemeColors();
  const active = editing && index === state.fieldIdx;
  const value = state.draft[field];
  const Field = field === "ticker" ? TextField : NumberField;
  return (
    <Box height={1} flexDirection="row">
      <Box width={10} flexShrink={0}>
        <Text fg={active ? colors.text : colors.textDim} attributes={active ? TextAttributes.BOLD : 0}>
          {t(FIELD_LABELS[field])}
        </Text>
      </Box>
      <Box width={14} flexShrink={0} onMouseDown={() => state.focusField(index)}>
        {active ? (
          <Field
            inputRef={inputRef}
            value={value}
            placeholder={t(FIELD_PLACEHOLDERS[field])}
            focused={!state.submitting}
            backgroundColor={colors.panel}
            textColor={colors.text}
            placeholderColor={colors.textDim}
            onChange={(next) => state.setField(field, next)}
          />
        ) : (
          <Text fg={value ? colors.text : colors.textMuted}>{value || t(FIELD_PLACEHOLDERS[field])}</Text>
        )}
      </Box>
      {field === "ticker" ? (
        <Box flexGrow={1} minWidth={0} overflow="hidden" paddingLeft={1}>
          <PreviewLine preview={state.preview} error={null} />
        </Box>
      ) : null}
    </Box>
  );
}

function TuiPositionsPanel({ state, inputRef, editing, selectedSymbol, shortcut }: PositionsPanelProps) {
  const colors = useThemeColors();
  // The newest rows, until the cursor climbs above them.
  const selectedIndex = state.positions.findIndex((row) => row.symbol === selectedSymbol);
  const lastWindowStart = Math.max(0, state.positions.length - TUI_VISIBLE_ROWS);
  const windowStart = selectedIndex >= 0 ? Math.min(lastWindowStart, selectedIndex) : lastWindowStart;
  const rows = state.positions.slice(windowStart, windowStart + TUI_VISIBLE_ROWS);
  return (
    <Box flexDirection="column" paddingX={2}>
      {POSITION_FIELDS.map((field, index) => (
        <TuiFieldRow key={field} field={field} index={index} state={state} inputRef={inputRef} editing={editing} />
      ))}
      <Box height={1} overflow="hidden">
        {state.error ? (
          <Text fg={colors.negative}>{state.error}</Text>
        ) : state.submitting ? (
          <Text fg={colors.textDim}>{t("adding...")}</Text>
        ) : (
          <Text fg={colors.textMuted}>
            {editing
              ? t("Enter: next field, then add.")
              : state.positions.length > 0
                ? tf("Enter continues · a adds another{broker}", { broker: "" })
                : t("Enter to add a ticker.")}
          </Text>
        )}
      </Box>
      <Box height={1} />
      <Box height={1} flexDirection="row" overflow="hidden">
        <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>
          {tf("Positions ({count})", { count: state.positions.length })}
        </Text>
      </Box>
      {rows.map((row) => {
        const selected = row.symbol === selectedSymbol;
        return (
          <Box
            key={row.symbol}
            height={1}
            flexDirection="row"
            overflow="hidden"
            backgroundColor={selected ? colors.selected : undefined}
          >
            <Box width={8} flexShrink={0}>
              <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{row.symbol}</Text>
            </Box>
            <Box width={18} flexShrink={0} overflow="hidden">
              <Text fg={colors.text}>{positionSummary(row)}</Text>
            </Box>
            <Box flexGrow={1} minWidth={0} overflow="hidden">
              <Text fg={colors.textDim}>{row.value === null ? row.name : formatWholeCurrency(row.value, row.currency)}</Text>
            </Box>
            {selected ? (
              <Box flexShrink={0}>
                <Button
                  label="Remove"
                  variant="plain"
                  compact
                  shortcut={REMOVE_POSITION_KEY}
                  onPress={() => { void state.removePosition(row.symbol); }}
                />
              </Box>
            ) : null}
          </Box>
        );
      })}
      <Box height={1} />
      <Box height={1} overflow="hidden">
        <Text fg={colors.textMuted}>{tf("Later: {shortcut}, then AP.", { shortcut })}</Text>
      </Box>
    </Box>
  );
}

export interface PositionsPanelProps {
  state: OnboardingPositionsState;
  inputRef: RefObject<InputRenderable | null>;
  editing: boolean;
  /** The row under the keyboard cursor; null while a field has the keyboard. */
  selectedSymbol: string | null;
  /** Command bar shortcut in the host's notation, e.g. "Ctrl+K". */
  shortcut: string;
}

export function PositionsPanel(props: PositionsPanelProps) {
  const desktop = useUiHost().kind === "desktop-web";
  return desktop ? <DesktopPositionsPanel {...props} /> : <TuiPositionsPanel {...props} />;
}
