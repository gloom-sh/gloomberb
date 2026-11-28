import { useCallback } from "react";
import type { HiringSignalGroup, HiringSignalsFilter } from "../../../api-client/hiring";
import { withCountryFlag } from "../../../components";
import { isoDay } from "../../../utils/day-format";
import { signedColor, toneColor } from "../shared/research-cells";
import { cachedSignals, fetchSignals, loadSignals, validateSignals, type SignalsPayload } from "./client";
import { HiringFeedView, postingDetailFacts, type HiringTabProps } from "./feed-view";
import { companySignalsModel, isSignalsFilter, isSignalsView, signalFacts, signalsBoardModel, signalsNumber, SIGNAL_FILTERS, SIGNALS_SIGNED_COLUMNS, SIGNALS_VIEWS, type SignalsRow } from "./signals-model";

/** A board with no first, or a company with no spike, leaves those columns out. */
const QUIET_COLUMNS: Record<string, readonly string[]> = { prior: [""], since: [""], mean: [""], pace: [""], z: [""], companyPace: [""], title: [""] };
const VIEW_CFG = { setting: "signalsView", fallback: "signals" as const, is: isSignalsView, options: SIGNALS_VIEWS };

const pageInfo = (payload: SignalsPayload) => "group" in payload ? { count: payload.signals.length, total: payload.total, preview: payload.preview } : null;
const sourceUrl = (opened: SignalsRow | null, selected: SignalsRow | null) => {
  // A signal opens its first posting; a posting row its own.
  const sourceRow = opened ?? selected;
  return sourceRow?.jobPosting?.url ?? sourceRow?.signal?.postings[0]?.url ?? null;
};
const evidenceTitle = (selected: SignalsRow) => selected.signal ? "Why it fired" : null;

/**
 * HIRE's Expansion and Anomalies tabs. Alone, the latest week's signals of
 * the group: Enter opens the company, `e` says why. On a ticker, the
 * company's own signals of the group, this week's and earlier, and the
 * postings behind this week's, each linking to the employer's page.
 */
export function HiringSignalsView({ group, ...props }: HiringTabProps & { group: HiringSignalGroup }) {
  const { symbol, accessKey } = props;
  const isFilter = useCallback((v: string): v is HiringSignalsFilter => isSignalsFilter(group, v), [group]);
  const matches = useCallback((p: SignalsPayload) => "group" in p ? !symbol && p.group === group : p.symbol.toUpperCase() === symbol?.toUpperCase(), [symbol, group]);
  const load = useCallback((f: HiringSignalsFilter, force: boolean) => loadSignals(group, symbol, accessKey, f, force), [group, symbol, accessKey]);
  const cached = useCallback((f: HiringSignalsFilter) => cachedSignals(group, symbol, accessKey, f), [group, symbol, accessKey]);
  const fetchPage = useCallback((f: HiringSignalsFilter, offset: number, signal: AbortSignal) => fetchSignals(group, undefined, { filter: f, offset, limit: 100 }, undefined, signal), [group]);
  const toModel = useCallback((data: SignalsPayload, f: HiringSignalsFilter) => "group" in data ? signalsBoardModel(data, f) : companySignalsModel(data, group), [group]);
  return <HiringFeedView {...props} scope={`hiring:${group}:${symbol ?? "board"}`}
    filter={{ setting: "signalsKind", stateKey: `hiring:${group}:filter`, queryId: "kind", fallback: "all", is: isFilter, options: SIGNAL_FILTERS[group] }}
    view={VIEW_CFG} snapshot={{ setting: `${group}Snapshot`, logScope: "company-attention.signals", logLabel: "Validate hiring signals snapshot failed", validate: validateSignals, matches }}
    load={load} cached={cached} fetchPage={fetchPage} pageInfo={pageInfo} toModel={toModel} quietColumns={QUIET_COLUMNS}
    subjectLabel="hiring signals" upgradeText={symbol ? "Upgrade for all signals" : `Upgrade for all ${group === "expansion" ? "expansion" : "anomaly"} signals`}
    sourceUrl={sourceUrl} evidenceTitle={evidenceTitle}
    detailOf={(opened, openUrl) => ({
      title: opened.jobPosting ? opened.jobPosting.title.trim() : opened.signal ? `${opened.signal.symbol} · ${opened.signal.label}` : undefined,
      facts: opened.jobPosting ? opened.details ?? [] : opened.signal ? [...signalFacts(opened.signal), ...postingDetailFacts(opened.signal.postings, symbol, openUrl)] : [],
      body: opened.jobPosting ? null : opened.signal?.why ?? null,
      note: opened.jobPosting?.url ?? null,
    })}
    renderValueCell={(row, column, value, _selected, { colors, desktop }) => {
      // A first is news; a flagged spike is shown, ranked last.
      if (column.id === "kind" && typeof value === "string") {
        const tone = row.signal?.flags.length ? "muted" : "positive";
        return { text: value, color: toneColor(tone, colors), keepColorWhenSelected: tone !== "muted" };
      }
      if (column.id === "check" && typeof value === "string") return { text: value, value, color: toneColor("warning", colors), keepColorWhenSelected: true };
      if (typeof value === "number") return { text: signalsNumber(column.id, value), value, color: SIGNALS_SIGNED_COLUMNS.has(column.id) ? signedColor(value, colors) : column.id === "mean" || column.id === "prior" ? colors.textDim : colors.text };
      if (column.id === "label" && row.values.country) return withCountryFlag({ text: value, value, color: colors.textBright }, String(row.values.country), desktop);
      // Since draws the first watched week without its year; an export keeps the ISO day.
      if (column.id === "since" && typeof value === "string") return { text: value, value: isoDay(row.signal?.history.watchedSince) ?? value, color: colors.textDim };
      return undefined;
    }} />;
}
