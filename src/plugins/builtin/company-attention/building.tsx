import { useCallback } from "react";
import type { HiringBuildingFilter } from "../../../api-client/hiring";
import { shareCell, signedColor, toneColor } from "../shared/research-cells";
import { BUILDING_FILTERS, BUILDING_SIGNED_COLUMNS, BUILDING_VIEWS, buildingBoardModel, buildingNumber, buildingSign, companyBuildingModel, isBuildingFilter, isBuildingView, shiftFacts, type BuildingRow } from "./building-model";
import { cachedBuilding, fetchBuilding, loadBuilding, validateBuilding, type BuildingPayload } from "./client";
import { HiringFeedView, postingDetailFacts, type HiringTabProps } from "./feed-view";

/** A company with no shift leaves the Note column out. */
const QUIET_COLUMNS: Record<string, readonly string[]> = { note: [""], title: [""] };
const FILTER_CFG = { setting: "buildingDimension", stateKey: "hiring:building:filter", queryId: "dimension", fallback: "all" as HiringBuildingFilter, is: isBuildingFilter, options: BUILDING_FILTERS };
const VIEW_CFG = { setting: "buildingView", fallback: "families" as const, is: isBuildingView, options: BUILDING_VIEWS };

const toModel = (data: BuildingPayload, filter: HiringBuildingFilter) => "filter" in data ? buildingBoardModel(data, filter) : companyBuildingModel(data);
const pageInfo = (payload: BuildingPayload) => "filter" in payload ? { count: payload.shifts.length, total: payload.total, preview: payload.preview } : null;
const fetchPage = (filter: HiringBuildingFilter, offset: number, signal: AbortSignal) => fetchBuilding(undefined, { filter, offset, limit: 100 }, undefined, signal);
const sourceUrl = (opened: BuildingRow | null, selected: BuildingRow | null) => {
  // A shift opens its first posting; a posting row its own.
  const sourceRow = opened ?? selected;
  return sourceRow?.jobPosting?.url ?? sourceRow?.shift?.postings[0]?.url ?? null;
};
const evidenceTitle = (selected: BuildingRow) => selected.shift ? "Why it shifted" : null;

/**
 * HIRE's Building tab. Alone, the latest week's shifts: role families and
 * themes whose share of a company's new roles rose against its own weeks.
 * Enter opens the company, `e` says why. On a ticker, the company's whole
 * mix by role family and by theme, now and before, its shifts this week and
 * earlier, and the postings behind this week's.
 */
export function HiringBuildingView(props: HiringTabProps) {
  const { symbol, accessKey } = props;
  const matches = useCallback((p: BuildingPayload) => "filter" in p ? !symbol : p.symbol.toUpperCase() === symbol?.toUpperCase(), [symbol]);
  const load = useCallback((f: HiringBuildingFilter, force: boolean) => loadBuilding(symbol, accessKey, f, force), [symbol, accessKey]);
  const cached = useCallback((f: HiringBuildingFilter) => cachedBuilding(symbol, accessKey, f), [symbol, accessKey]);
  return <HiringFeedView {...props} scope={`hiring:building:${symbol ?? "board"}`} filter={FILTER_CFG} view={VIEW_CFG}
    snapshot={{ setting: "buildingSnapshot", logScope: "company-attention.building", logLabel: "Validate hiring building snapshot failed", validate: validateBuilding, matches }}
    load={load} cached={cached} fetchPage={fetchPage} pageInfo={pageInfo} toModel={toModel} quietColumns={QUIET_COLUMNS}
    subjectLabel="what companies are building" upgradeText={symbol ? "Upgrade for the whole mix" : "Upgrade for all shifts"}
    sourceUrl={sourceUrl} evidenceTitle={evidenceTitle}
    onActivateRow={(row, { model, setView, setOpenRow }) => {
      // A mix row opens its shift, when it has one this week.
      const target = row.shift || row.jobPosting ? row
        : row.mix ? model?.sections.shifts?.rows.find((entry) => entry.shift && entry.shift.week === model.week && `${entry.shift.dimension}:${entry.shift.key}` === row.id) ?? null : null;
      if (!target) return;
      // A mix row's shift opens from the Shifts view, where its detail lives.
      if (row.mix) setView("shifts");
      setOpenRow(target.id);
    }}
    detailOf={(opened, openUrl) => ({
      title: opened.jobPosting ? opened.jobPosting.title.trim() : opened.shift ? `${opened.shift.symbol} · ${opened.shift.label}` : undefined,
      facts: opened.jobPosting ? opened.details ?? [] : opened.shift ? [...shiftFacts(opened.shift), ...postingDetailFacts(opened.shift.postings, symbol, openUrl)] : [],
      body: opened.jobPosting ? null : opened.shift?.why ?? null,
      note: opened.jobPosting?.url ?? null,
    })}
    // A family or theme with no shift has nothing to note.
    renderEmptyCell={(_row, column) => column.id === "note" ? { text: "" } : undefined}
    renderValueCell={(_row, column, value, selected, { colors, dataRows }) => {
      // Every shift is news, as a first or a spike is on the other tabs.
      if (column.id === "kind" && typeof value === "string") return { text: value, color: toneColor("positive", colors), keepColorWhenSelected: true };
      if (column.id === "note" && typeof value === "string") return { text: value, value, color: toneColor(value === "Shift" ? "positive" : "muted", colors), keepColorWhenSelected: value === "Shift" };
      if (typeof value === "number") {
        const text = buildingNumber(column.id, value);
        if (column.id === "share") {
          const maxShare = Math.max(0, ...dataRows.map((entry) => typeof entry.values.share === "number" ? entry.values.share : 0));
          return { ...shareCell(text, maxShare ? value / maxShare : null, column.width, colors, selected), value };
        }
        return { text, value, color: BUILDING_SIGNED_COLUMNS.has(column.id) ? signedColor(buildingSign(column.id, value), colors) : column.id === "before" || column.id === "beforeRoles" ? colors.textDim : colors.text };
      }
      return undefined;
    }} />;
}
