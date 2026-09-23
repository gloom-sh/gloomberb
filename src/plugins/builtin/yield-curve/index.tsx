import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CurveSurface, Notice, PaneStatusBody, QueryBar, usePaneNoticeFooter, type PaneFooterSegment } from "../../../components";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { usePaneSettingValue } from "../../../state/app/context";
import type { PaneProps } from "../../../types/plugin";
import { Box, type InputRenderable } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import type { PluginModule } from "../plugin-module";
import { useAutoRefresh } from "../shared/auto-refresh";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { yieldCurveHeadless } from "./headless";
import { buildYieldCurveSeries, formatMaturityYears } from "./chart";
import { completeYieldCurve, loadHistoricalYieldCurve, yieldCurveDate } from "./history";
import {
  curveAsOf,
  loadYieldCurve,
  spreadBasisPoints,
  type YieldPoint,
  yieldCurveErrors,
} from "./treasury-data";

export { yieldCurveHeadless } from "./headless";

const EMPTY_POINTS: YieldPoint[] = [];
function formatYieldAxis(value: number): string {
  return `${value.toFixed(2)}%`;
}

export function YieldCurvePane({ focused, width, height }: PaneProps) {
  const [requestedDate, setRequestedDate] = usePaneSettingValue<string>("asOfDate", "");
  const [draftDate, setDraftDate] = useState(requestedDate);
  const [dateError, setDateError] = useState<string | null>(null);
  const [dateActive, setDateActive] = useState(false);
  const [dateFocusToken, setDateFocusToken] = useState(0);
  const dateInput = useRef<InputRenderable>(null);
  // Leaving the field without Enter puts back the date the curve shows.
  useEffect(() => { if (!dateActive) setDraftDate(requestedDate); }, [dateActive, requestedDate]);
  const loadCurve = useCallback(async () => ({
    requestedDate,
    points: completeYieldCurve(requestedDate
      ? await loadHistoricalYieldCurve(requestedDate)
      : await loadYieldCurve()),
  }), [requestedDate]);
  const { data, loading, error, updatedAt: lastUpdated, load } = useAsyncResource(loadCurve);
  // A pending date change must never relabel the previous curve as the new one.
  const points = data?.requestedDate === requestedDate ? data.points : EMPTY_POINTS;
  const refreshLatest = useCallback(() => { if (!requestedDate) void load(); }, [requestedDate, load]);
  useAutoRefresh(lastUpdated, refreshLatest);
  const selectDate = (value: string) => {
    try {
      const nextDate = yieldCurveDate(value);
      setRequestedDate(nextDate);
      setDraftDate(nextDate);
      setDateError(null);
      setDateActive(false);
      // Show the start of the date once the field is left, not the scrolled tail.
      if (dateInput.current?.setCursorOffset) dateInput.current.setCursorOffset(0);
      else if (dateInput.current) dateInput.current.cursorOffset = 0;
      dateInput.current?.blur?.();
      if (nextDate === requestedDate) void load();
    } catch (error) {
      setDateError(error instanceof Error ? error.message : String(error));
    }
  };
  const editDate = () => {
    setDateActive(true);
    setDateFocusToken((token) => token + 1);
  };

  // The [d]ate and [c]urrent hints bind their own keys; Esc in the date field
  // is the query bar's.
  useShortcut((ev) => {
    if (!focused || dateActive || !isPlainKey(ev, "r")) return;
    void load();
  });

  const bp = spreadBasisPoints(points);
  // Treasury series are daily closes, so which session the curve represents is
  // context the query bar carries; "updated Xm ago" only says when we fetched it.
  const asOf = curveAsOf(points);
  const sourceError = yieldCurveErrors(points).join("; ");

  const yieldStatus = useMemo<PaneFooterSegment[]>(() => [
      ...(bp != null ? [{ id: "spread", parts: [{ text: `10Y−2Y ${bp >= 0 ? "+" : ""}${bp}bp`, tone: bp < 0 ? "warning" as const : "muted" as const }] }] : []),
  ], [bp]);
  // Limitations of a curve that is still drawn sit behind one warning indicator.
  const missingTenors = points.filter((point) => point.yield == null).map((point) => point.maturity);
  usePaneNoticeFooter({
    registrationId: "yield-curve:notices",
    notices: [
      !asOf && points.length ? "The tenors carry mixed or unknown observation dates, so the curve is not one session." : null,
      missingTenors.length ? `Unavailable tenors: ${missingTenors.join(", ")}.` : null,
      points.some((point) => point.stale) ? "Some tenors are cached values because their refresh failed." : null,
    ].filter((notice): notice is string => notice !== null),
    focused,
    enabled: !error && !sourceError,
  });
  usePaneStatusFooter({
    registrationId: "yield-curve",
    loading,
    error: error || sourceError || null,
    info: error || sourceError ? [] : yieldStatus,
    hints: [
      { id: "date", key: "d", label: "ate", onPress: editDate },
      ...(requestedDate ? [{ id: "latest", key: "c", label: "urrent", title: "Current Curve", onPress: () => selectDate("") }] : []),
    ],
  });

  // The query bar carries the session date, so the legend does not repeat it;
  // each point keeps its own date for the table when the tenors differ.
  const series = useMemo(() => [{ ...buildYieldCurveSeries(points), asOf: undefined }], [points]);
  const queryBar = (
    <QueryBar
      width={width}
      filters={[{
        id: "date",
        kind: "text",
        label: "Date",
        value: draftDate,
        placeholder: "latest",
        width: 10,
        debounceMs: 0,
        focused,
        active: dateActive,
        onActiveChange: setDateActive,
        focusToken: dateFocusToken,
        inputRef: dateInput,
        // Typing only edits the draft; Enter applies it. Clearing the chip
        // (outside the field) goes back to the latest session.
        onChange: (value: string) => {
          setDraftDate(value);
          if (!dateActive && !value.trim() && requestedDate) selectDate("");
        },
        onSubmit: selectDate,
      }]}
      // The session actually shown; a requested date the field already shows is not repeated.
      meta={asOf && asOf !== requestedDate ? `as of ${asOf}` : undefined}
    />
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      {queryBar}
      {dateError ? <Notice tone="negative">{dateError}</Notice> : null}
      <PaneStatusBody loading={loading && points.length === 0} error={points.length === 0 ? error : null}
        loadingLabel="Loading yield curve..." subject="yield curve">
        {/* Mixed tenor dates still draw the curve: the table's As of column and
            the footer warning say which tenors differ. */}
        <CurveSurface series={series} width={width} height={Math.max(1, height - 1 - (dateError ? 1 : 0))}
          focused={focused && !dateActive} display="both" valueLabel="Yield (%)"
          formatValue={formatYieldAxis} formatX={formatMaturityYears} />
      </PaneStatusBody>
    </Box>
  );
}

export const yieldCurveModule: PluginModule = {
  panes: [{
    id: "yield-curve",
    name: "US Treasury Yield Curve",
    icon: "Y",
    component: YieldCurvePane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 80, height: 28 },
  }],
  paneTemplates: [{
    id: "yield-curve-pane",
    paneId: "yield-curve",
    label: "Yield Curve",
    description: "US Treasury yield curve charted from FRED data.",
    keywords: ["yield", "curve", "treasury", "bonds", "rates", "gc", "interest"],
    shortcut: { prefix: "GC", argPlaceholder: "YYYY-MM-DD", argKind: "text", argOptional: true },
    headless: yieldCurveHeadless,
    createInstance: (_context, options) => ({ settings: { asOfDate: yieldCurveDate(options?.arg) } }),
  }],
};
