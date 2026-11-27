import { useCallback } from "react";
import type { HiringMovesFilter } from "../../../api-client/hiring";
import { openFormModal } from "../../../components/form-modal/request";
import { getSharedRegistry } from "../../registry/shared";
import { signedColor, toneColor } from "../shared/research-cells";
import { cachedMoves, fetchMoves, loadMoves, validateMoves, type MovesPayload } from "./client";
import { HiringFeedView, type HiringTabProps } from "./feed-view";
import { companyMovesModel, isMovesFilter, isMovesView, moveFacts, movesBoardModel, movesNumber, MOVES_FILTERS, MOVES_SIGNED_COLUMNS, MOVES_VIEWS, SIGNAL_TONE, type MovesRow } from "./moves-model";

/** Every row of the board reads the same week; a company's weeks before any move have no pace yet. */
const QUIET_COLUMNS: Record<string, readonly string[]> = { pace: [""], z: [""], signal: [""], excluded: [""], driver: [""] };
const FILTER_CFG = { setting: "movesFilter", stateKey: "hiring:moves:filter", queryId: "signal", fallback: "moves" as HiringMovesFilter, is: isMovesFilter, options: MOVES_FILTERS };
const VIEW_CFG = { setting: "movesView", fallback: "weeks" as const, is: isMovesView, options: MOVES_VIEWS };

const toModel = (data: MovesPayload, filter: HiringMovesFilter) => "moves" in data ? movesBoardModel(data, filter) : companyMovesModel(data);
const pageInfo = (payload: MovesPayload) => "moves" in payload ? { count: payload.moves.length, total: payload.total, preview: payload.preview } : null;
const fetchPage = (filter: HiringMovesFilter, offset: number, signal: AbortSignal) => fetchMoves(undefined, { filter, offset, limit: 100 }, undefined, signal);
const canOpenRow = (row: MovesRow) => !!(row.move || row.jobPosting);
const sourceUrl = (opened: MovesRow | null, selected: MovesRow | null) => opened?.jobPosting?.url ?? (opened ? null : selected?.jobPosting?.url);
const evidenceTitle = (selected: MovesRow) => selected.move ? "Why it moved" : null;
// ALRT's hiring move alert on the company, as ERN's `n` opens an earnings one.
const extraCompanyHints = (subject: string, desktop: boolean) => desktop && getSharedRegistry()?.commands.has("set-event-alert") === true
  ? [{ id: "alert", key: "n", label: "otify", title: "Hiring move alert", onPress: () => { openFormModal({ kind: "plugin-command", commandId: "set-event-alert", values: { event: "hiring_move", "hiring_move:symbol": subject } }); } }]
  : [];
const detailOf = (opened: MovesRow) => ({
  title: opened.move ? `${opened.move.symbol} · week of ${opened.move.week}` : opened.jobPosting?.title.trim(),
  facts: opened.move ? moveFacts(opened.move) : opened.details ?? [],
  body: opened.move?.why ?? null,
  note: opened.jobPosting?.url ?? null,
});

/**
 * HIRE's Moves tab. Alone it lists the companies whose new roles moved
 * against their own weeks in the latest week; Enter opens one, `e` says why.
 * On a ticker it shows the company's weeks (and why a week is not measured),
 * the role families and titles behind its move and the postings first seen
 * and closed that week.
 */
export function HiringMovesView(props: HiringTabProps) {
  const { symbol, accessKey } = props;
  const matches = useCallback((p: MovesPayload) => "moves" in p ? !symbol : p.symbol.toUpperCase() === symbol?.toUpperCase(), [symbol]);
  const load = useCallback((f: HiringMovesFilter, force: boolean) => loadMoves(symbol, accessKey, f, force), [symbol, accessKey]);
  const cached = useCallback((f: HiringMovesFilter) => cachedMoves(symbol, accessKey, f), [symbol, accessKey]);
  return <HiringFeedView {...props} scope={`hiring:moves:${symbol ?? "board"}`} filter={FILTER_CFG} view={VIEW_CFG}
    snapshot={{ setting: "movesSnapshot", logScope: "company-attention.moves", logLabel: "Validate hiring moves snapshot failed", validate: validateMoves, matches }}
    load={load} cached={cached} fetchPage={fetchPage} pageInfo={pageInfo} toModel={toModel} quietColumns={QUIET_COLUMNS}
    subjectLabel="hiring moves" upgradeText={symbol ? "Upgrade for all observations" : "Upgrade for all moves"}
    canOpenRow={canOpenRow} sourceUrl={sourceUrl} evidenceTitle={evidenceTitle} extraCompanyHints={extraCompanyHints} detailOf={detailOf}
    renderValueCell={(_row, column, value, _selected, { colors }) => {
      if (column.id === "signal" && typeof value === "string") {
        const tone = SIGNAL_TONE[value] ?? "muted";
        return { text: value, color: toneColor(tone, colors), keepColorWhenSelected: tone !== "muted" };
      }
      // A flagged move is shown, not alerted.
      if (column.id === "check" && typeof value === "string") return { text: value, value, color: toneColor("warning", colors), keepColorWhenSelected: true };
      if (typeof value === "number") return { text: movesNumber(column.id, value), value, color: MOVES_SIGNED_COLUMNS.has(column.id) ? signedColor(value, colors) : column.id === "mean" ? colors.textDim : colors.text };
      return undefined;
    }} />;
}
