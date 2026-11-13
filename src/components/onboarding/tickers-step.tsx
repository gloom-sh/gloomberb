import type { RefObject } from "react";
import { Box, Text, useUiCapabilities, type InputRenderable } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import { t, tf } from "../../i18n";
import { TextField, fieldFrameStyle } from "../ui/fields";
import { Icon } from "../ui/icon";
import { ToggleList } from "../toggle-list";
import { SPACE } from "../../theme/ui-tokens";
import { MAX_TICKER_PICKS, TICKER_STEP_ROWS } from "./tickers-step-model";
import type { OnboardingTickersState } from "./wizard-tickers";

const TERMINAL_PADDING_X = 2;
/** The terminal search field's label column, as the company picker's. */
const SEARCH_LABEL_WIDTH = 8;

/**
 * "Which tickers do you follow?": the app's ticker search over one checkbox
 * list, as the Desks step lists desks. With nothing typed the list is the
 * picks and the suggestions for the desks picked; while a search is typed it
 * is what search found. Up to three are ticked; the rest wait until one is
 * unticked.
 */
export function TickersStep({
  state,
  inputRef,
  width,
}: {
  state: OnboardingTickersState;
  inputRef: RefObject<InputRenderable | null>;
  /** The terminal card's content width in cells. */
  width?: number;
}) {
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const colors = useThemeColors();
  const picked = new Set(state.picks.map((pick) => pick.symbol));
  const full = state.picks.length >= MAX_TICKER_PICKS;
  const query = state.query.trim();
  const rowWidth = desktop || width == null ? undefined : width - 2 * TERMINAL_PADDING_X;
  // Typed, with nothing found yet: what the search is doing, where its rows go.
  const status = query && state.rows.length === 0
    ? state.searching ? t("Searching…") : state.searchError ?? tf("No company matches {query}.", { query })
    : null;

  const field = (
    <TextField
      value={state.query}
      placeholder={t("Search any company or ticker")}
      focused
      inputRef={inputRef}
      onChange={state.setQuery}
      variant={desktop ? "plain" : "default"}
      {...(desktop
        ? { accessibleLabel: t("Search") }
        : { label: t("Search"), labelWidth: SEARCH_LABEL_WIDTH, width: rowWidth })}
    />
  );
  // The onboarding's search, as "Which companies do you follow?" draws it: the DOM card frames it with its icon.
  const search = desktop ? (
    <Box
      flexDirection="row"
      alignItems="center"
      style={{
        ...fieldFrameStyle(true),
        height: 38,
        padding: "0 var(--gloom-space-md)",
        gap: "var(--gloom-space-sm)",
        boxSizing: "border-box",
      }}
    >
      <Icon name="search" size={13} color={colors.textMuted} />
      <Box flexGrow={1} minWidth={0}>{field}</Box>
    </Box>
  ) : field;
  const list = status ? (
    <Text fg={colors.textMuted}>{status}</Text>
  ) : (
    <ToggleList
      items={state.rows.map((row) => ({
        id: row.symbol,
        label: row.symbol,
        enabled: picked.has(row.symbol),
        // Once three are ticked, the rest wait until one is unticked.
        disabled: full && !picked.has(row.symbol),
        detail: row.name,
      }))}
      selectedIdx={state.cursor}
      onSelect={state.setCursor}
      onToggle={(id) => state.toggleRow(state.rows.findIndex((row) => row.symbol === id))}
      showSelectedDescription={false}
      surface={desktop ? "framed" : undefined}
      remoteLabel="Tickers"
      width={rowWidth}
    />
  );

  if (desktop) {
    return (
      // The Desks step's offset under the title, so the two cards line up.
      <Box flexDirection="column" flexShrink={0} style={{ marginTop: 14 }}>
        {search}
        {/* The rows and a row for the list's frame, so the card keeps its height while a search lists fewer. */}
        <Box flexDirection="column" minHeight={TICKER_STEP_ROWS + 1} style={{ marginTop: SPACE.sm }}>
          {list}
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" flexShrink={0} paddingX={TERMINAL_PADDING_X}>
      <Box height={1}>{field}</Box>
      <Box height={1} />
      <Box height={TICKER_STEP_ROWS} flexDirection="column" overflow="hidden">{list}</Box>
      <Box height={1} />
    </Box>
  );
}
