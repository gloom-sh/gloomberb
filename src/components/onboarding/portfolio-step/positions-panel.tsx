import { useEffect, useRef, useState, type ComponentProps, type RefObject } from "react";
import { Box, Text, TextAttributes, useUiCapabilities, type InputRenderable } from "../../../ui";
import { useThemeColors } from "../../../theme/theme-context";
import { shownPriceColor } from "../../../theme/colors";
import { t, tf } from "../../../i18n";
import { formatMarketPrice } from "../../../market-data/market/format";
import { getRegularSessionDisplay } from "../../../market-data/market/status";
import { formatPercentRaw } from "../../../utils/format";
import { Button, NumberField, TextField } from "../../ui";
import { DelayedMark } from "../../ui/delayed-mark";
import { useFreeQuoteDelay } from "../../../api-client/plan-access";
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
  currency: "Currency",
};

const FIELD_PLACEHOLDERS: Record<Exclude<PositionFieldId, "currency">, string> = {
  ticker: "e.g. AAPL",
  shares: "optional",
  avgCost: "last price",
};

/** A field's label; the size counts contracts once the symbol is a future. */
function fieldLabel(field: PositionFieldId, state: Pick<OnboardingPositionsState, "quantityLabel">): string {
  return t(field === "shares" ? state.quantityLabel : FIELD_LABELS[field]);
}

/** A blank Currency shows the code it will save, as the AP form does. */
function fieldPlaceholder(field: PositionFieldId, state: OnboardingPositionsState): string {
  return field === "currency" ? state.blankCurrency : t(FIELD_PLACEHOLDERS[field]);
}

/** Company name and last price for the symbol being typed, or why it will not resolve. */
function PreviewLine({ preview, error }: Pick<OnboardingPositionsState, "preview" | "error">) {
  const colors = useThemeColors();
  // Signed out or free, the price is the delayed one, and says so.
  const delay = useFreeQuoteDelay(preview.status === "ready" ? preview.quote : null);
  if (error) return <Text fg={colors.negative} wrapText>{error}</Text>;
  if (preview.status === "idle") return null;
  if (preview.status === "checking") {
    return <Text fg={colors.textDim}>{tf("{query} checking...", { query: preview.query })}</Text>;
  }
  if (preview.status === "missing") return <Text fg={colors.textMuted}>{preview.message}</Text>;
  // The regular session's last and move, as `ticker` headlines them: after the close, that close.
  const headline = getRegularSessionDisplay(preview.quote);
  const price = headline?.price;
  const change = headline?.changePercent;
  // Only the name gives way to a narrow row, clipped on its right: the symbol, price and move keep every cell.
  return (
    <Box flexDirection="row" alignItems="center" minWidth={0} overflow="hidden">
      <Box flexShrink={0}><Text fg={colors.text} attributes={TextAttributes.BOLD}>{preview.symbol}</Text></Box>
      {preview.name ? (
        <Box flexShrink={1} minWidth={0} overflow="hidden" paddingLeft={2}><Text fg={colors.textDim}>{preview.name}</Text></Box>
      ) : null}
      {price != null ? <Box flexShrink={0} paddingLeft={2}><Text fg={colors.text}>{formatMarketPrice(price, { maxWidth: 12 })}</Text></Box> : null}
      {change != null ? <Box flexShrink={0} paddingLeft={1}><Text fg={shownPriceColor(change, 2, colors)}>{formatPercentRaw(change)}</Text></Box> : null}
      {price != null && delay != null ? <Box flexShrink={0} paddingLeft={1}><DelayedMark minutes={delay} /></Box> : null}
      {preview.duplicate ? <Box flexShrink={0}><Text fg={colors.textMuted}>{t("  already added")}</Text></Box> : null}
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
        padding: "0 var(--gloom-space-sm)",
        borderRadius: "var(--gloom-radius-md)",
        backgroundColor: lit ? "var(--gloom-hover-fill)" : "transparent",
      }}
      data-gloom-role="onboarding-position"
    >
      <Box style={{ width: 64, flexShrink: 0 }}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{row.symbol}</Text>
      </Box>
      <Box flexGrow={1} minWidth={0} overflow="hidden">
        <Text fg={colors.textDim}>{row.name}</Text>
      </Box>
      <Box flexShrink={0} style={{ marginLeft: "var(--gloom-space-lg)" }}>
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
    label: fieldLabel(field, state),
    inputRef: index === state.fieldIdx ? inputRef : undefined,
    value: state.draft[field],
    placeholder: fieldPlaceholder(field, state),
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
          <NumberField {...fieldProps("shares", 1)} allowNegative onChange={(value) => state.setField("shares", value)} />
        </Box>
        <Box style={{ width: 128, flexShrink: 0 }}>
          <NumberField {...fieldProps("avgCost", 2)} onChange={(value) => state.setField("avgCost", value)} />
        </Box>
        <Box style={{ width: 80, flexShrink: 0 }}>
          <TextField {...fieldProps("currency", 3)} onChange={(value) => state.setField("currency", value)} />
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
  const Field = field === "ticker" || field === "currency" ? TextField : field === "shares" ? SignedNumberField : NumberField;
  return (
    <Box height={1} flexDirection="row">
      <Box width={10} flexShrink={0}>
        <Text fg={active ? colors.text : colors.textDim} attributes={active ? TextAttributes.BOLD : 0}>
          {fieldLabel(field, state)}
        </Text>
      </Box>
      <Box width={14} flexShrink={0} onMouseDown={() => state.focusField(index)}>
        {active ? (
          <Field
            inputRef={inputRef}
            value={value}
            placeholder={fieldPlaceholder(field, state)}
            focused={!state.submitting}
            backgroundColor={colors.panel}
            textColor={colors.text}
            placeholderColor={colors.textDim}
            onChange={(next) => state.setField(field, next)}
          />
        ) : (
          <Text fg={value ? colors.text : colors.textMuted}>{value || fieldPlaceholder(field, state)}</Text>
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

/**
 * The line under the form: what Enter does, and how the step goes on. It
 * needs one ticker, and while a field has the keyboard Enter adds, so Esc
 * comes first.
 */
function positionsHint(editing: boolean, count: number): string {
  if (!editing && count > 0) return tf("Enter continues · a adds another{broker}", { broker: "" });
  const enter = editing ? t("Enter: next field, then add") : t("Enter to add a ticker");
  return `${enter} · ${count > 0 ? t("Esc, then Enter: continue") : t("Add one ticker to continue")}`;
}

/** The size held: negative for a short. */
function SignedNumberField(props: ComponentProps<typeof NumberField>) {
  return <NumberField {...props} allowNegative />;
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
          <Text fg={colors.textMuted}>{positionsHint(editing, state.positions.length)}</Text>
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
  const desktop = useUiCapabilities().nativePaneChrome === true;
  return desktop ? <DesktopPositionsPanel {...props} /> : <TuiPositionsPanel {...props} />;
}
