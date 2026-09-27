import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Tabs,
  usePaneHeaderTabs,
  type PaneHint,
  type QueryBarFilter,
} from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { useShortcut } from "../../../react/input";
import { Box, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { scrollByLines } from "../../../state/pane-scroll-registry";
import { isPlainKey } from "../../../utils/keyboard";

export interface FilingYearReaderOptions {
  /** Filing years in the order the strip shows them. */
  years: number[];
  year: number | null;
  onSelectYear: (year: number) => void;
  /** The form after the year on a tab, such as "10-K" in "2024 10-K". */
  tabForm: string;
  /** The year filter's label on the desktop query bar. */
  filterLabel: string;
  focused: boolean;
  /** Inside Ticker Research, whose own tab strip keeps h/l and the arrows. */
  nested: boolean;
  /** Shortcut scope of the pane. */
  scope: string;
  /** Changes when another document is shown, which starts it at the top. */
  documentKey: string;
  refresh: () => void;
}

/**
 * The shell of a pane that reads one yearly filing at a time: the year strip,
 * the `y` hint that steps years and j/k scrolling the document a line at a
 * time. Call it above any early return.
 */
export function useFilingYearReader({
  years,
  year,
  onSelectYear,
  tabForm,
  filterLabel,
  focused,
  nested,
  scope,
  documentKey,
  refresh,
}: FilingYearReaderOptions) {
  const nativePaneChrome = useUiCapabilities().nativePaneChrome === true;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  useEffect(() => {
    const scrollBox = scrollRef.current;
    if (scrollBox) scrollBox.scrollTop = 0;
  }, [documentKey]);

  const nextYear = useCallback(() => {
    if (years.length < 2) return;
    const index = years.findIndex((entry) => entry === year);
    onSelectYear(years[(index + 1) % years.length]!);
  }, [onSelectYear, year, years]);

  // The pane footer binds the `o` and `y` hints.
  useShortcut(
    (event) => {
      if (handleRefreshKey(event, refresh)) return;
      // One line per press; marked handled so the pane scroll keys, which
      // page the document, do not scroll it again.
      const delta = isPlainKey(event, "j", "down") ? 1 : isPlainKey(event, "k", "up") ? -1 : 0;
      if (!delta) return;
      event.preventDefault();
      if (scrollRef.current) scrollByLines(scrollRef.current, delta);
    },
    { enabled: focused, scope },
  );

  const activeValue = year === null ? "" : String(year);
  const tabs = useMemo(() => years.map((entry) => ({
    label: `${entry} ${tabForm}`,
    value: String(entry),
  })), [tabForm, years]);
  const selectYear = useCallback((value: string) => onSelectYear(Number(value)), [onSelectYear]);
  const tabsInHeader = usePaneHeaderTabs(years.length > 1 ? {
    tabs,
    activeValue,
    onSelect: selectYear,
    focused,
  } : null);

  // Nested in Ticker Research the years stay in the body: the terminal keeps
  // its tab row, the desktop picks the year from the query bar.
  const yearsInBody = years.length > 1 && !tabsInHeader;
  const yearFilters = useMemo<QueryBarFilter[]>(() => yearsInBody && nativePaneChrome ? [{
    id: "year",
    label: filterLabel,
    inline: years.length <= 4,
    value: activeValue,
    options: years.map((entry) => ({ label: String(entry), value: String(entry) })),
    onChange: selectYear,
  }] : [], [activeValue, filterLabel, nativePaneChrome, selectYear, years, yearsInBody]);
  const yearStrip = yearsInBody && !nativePaneChrome ? (
    <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
      <Tabs
        tabs={tabs}
        activeValue={activeValue}
        onSelect={selectYear}
        compact
        variant="bare"
        focused={focused}
        keyboardNavigation={!nested}
      />
    </Box>
  ) : null;
  // The year strip answers h/l only where it is the pane's own strip; `y`
  // steps it everywhere, including under Ticker Research's strip.
  const hasYearChoice = years.length > 1;
  const yearHint = useMemo<PaneHint | null>(() => hasYearChoice
    ? { id: "year", key: "y", label: "ear", onPress: nextYear }
    : null, [hasYearChoice, nextYear]);

  return { scrollRef, yearStrip, yearFilters, yearHint };
}
