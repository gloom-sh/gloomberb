import type { HeadlessPaneColumn, HeadlessPaneDefinition, HeadlessPaneRow } from "../../../types/plugin";
import type { DataTableColumn } from "../../../components";
import type { AppAttentionPayload, AppChart } from "../../../api-client/app-attention";
import type { HiringBoard, HiringPayload } from "../../../api-client/hiring";
import { fetchAppRank, fetchAttention, fetchMoves, fetchSignals, type SignalsPayload } from "./client";
import { appsModel, appsPreviewNote, attentionNumber, attentionSectionTitle, attentionTabs, hiringModel, hiringPreviewNote, remoteText, type AttentionKind } from "./model";
import { companyMovesModel, isMovesFilter, movesBoardModel, movesNumber, movesPreviewNote, MOVES_FILTERS, MOVES_VIEWS, type MovesSection } from "./moves-model";
import type { HiringMovesFilter, HiringSignalGroup } from "../../../api-client/hiring";
import { companySignalsModel, holdText, isSignalsFilter, signalsBoardModel, signalsNumber, signalsPreviewNote, SIGNAL_FILTERS, SIGNAL_GROUPS, SIGNALS_VIEWS, type SignalsSection } from "./signals-model";
import { REPORT_PAGE, REPORT_ROWS } from "../shared/headless-options";

/**
 * Numbers print as the pane draws them: shares to a tenth, ratings and
 * z-scores to a hundredth, counts whole, and a remote share with the roles it
 * is measured on. Exports keep the full value.
 */
function reportColumn(column: DataTableColumn): HeadlessPaneColumn {
  if (column.align !== "right") return { key: column.id, header: column.label, align: column.align };
  const format = (value: unknown) => typeof value === "number" ? attentionNumber(column.id, value) : value == null ? "-" : String(value);
  return { key: column.id, header: column.label, align: column.align, format,
    ...(column.id === "remote" ? { textFormat: (value: unknown, row: HeadlessPaneRow) => typeof value === "number"
      ? remoteText(value, typeof row.remoteKnown === "number" ? row.remoteKnown : null) ?? "-" : "-" } : {}) };
}

/** A moves view as a report section: paces as `3.4x`, scores signed, and on the board each move's why. */
function movesSection(title: string, section: MovesSection, why: boolean) {
  return {
    title, empty: section.empty, ...(section.locked ? { locked: true } : {}),
    columns: [...section.columns.map((column): HeadlessPaneColumn => column.align !== "right" ? { key: column.id, header: column.label, align: column.align }
      : { key: column.id, header: column.label, align: column.align, format: (value: unknown) => typeof value === "number" ? movesNumber(column.id, value) : value == null ? "-" : String(value) }),
    ...(why ? [{ key: "why", header: "Why", align: "left" as const }] : [])],
    rows: section.rows.map((row) => ({ ...row.values, ...(row.move ? { why: row.move.why } : {}), ...(row.url ? { sourceUrl: row.url } : {}) })),
  };
}

/** A signals view as a report section: paces as `3.4x`, and each signal's why. */
function signalsSection(title: string, section: SignalsSection) {
  return {
    title, empty: section.empty, ...(section.locked ? { locked: true } : {}),
    columns: [...section.columns.map((column): HeadlessPaneColumn => column.align !== "right" ? { key: column.id, header: column.label, align: column.align }
      : { key: column.id, header: column.label, align: column.align, format: (value: unknown) => typeof value === "number" ? signalsNumber(column.id, value) : value == null ? "-" : String(value) }),
    ...(section.rows.some((row) => row.signal && !row.jobPosting) ? [{ key: "why", header: "Why", align: "left" as const }] : [])],
    rows: section.rows.map((row) => ({ ...row.values, ...(row.signal && !row.jobPosting ? { why: row.signal.why } : {}), ...(row.url ? { sourceUrl: row.url } : {}) })),
  };
}
const SIGNAL_TITLES: Record<HiringSignalGroup, string> = { expansion: "Expansion", anomalies: "Anomalies" };
/** A board's two groups, or a company's signals of both, as report sections. */
function signalsSections(reads: Array<{ group: HiringSignalGroup; data: SignalsPayload }>, kind: string): ReturnType<typeof signalsSection>[] {
  return reads.flatMap(({ group, data }) => {
    if ("group" in data) return [signalsSection(SIGNAL_TITLES[group], signalsBoardModel(data, isSignalsFilter(group, kind) ? kind : "all").sections.board!)];
    const model = companySignalsModel(data, group);
    return [signalsSection(SIGNAL_TITLES[group], model.sections.signals!),
      ...(model.sections.postings!.rows.length ? [signalsSection(`${SIGNAL_TITLES[group]} postings`, model.sections.postings!)] : [])];
  });
}

export function attentionHeadless(kind: AttentionKind): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    freshness: kind === "hiring"
      ? { source: "Company careers sites", status: "not-a-feed", basis: "observed job postings", dataset: true }
      : { source: "App Store and Google Play charts", status: "not-a-feed", basis: "observed chart ranks", dataset: true },
    argument: { kind: "ticker", optional: true, placeholder: "ticker", description: "Company ticker, including exchange for non-US listings. Omit for the global board." },
    options: [
      { key: "limit", shot: REPORT_ROWS, type: "string", defaultValue: "100", description: "Rows per REST page, up to 200 for hiring and 500 for apps." },
      { key: "offset", shot: REPORT_PAGE, type: "string", defaultValue: "0", description: "Continuation offset from the prior report metadata." },
      { key: "tab", type: "enum", settingKey: "tab", values: [...["table", "chart", "mix", "peers", "evidence"], ...(kind === "hiring" ? ["moves", "expansion", "anomalies"] : [])].map((value) => ({ value })), defaultValue: "table",
        description: kind === "hiring" ? "Table, dated history, role mix, peers, source evidence, moves against the company's own weeks and peers, first roles in a new country or city, or place and role-family spikes." : "Table, dated history, geographic or role mix, peers, or source evidence." },
      ...(kind === "hiring" ? [
        { key: "moves", type: "enum" as const, settingKey: "movesFilter", values: MOVES_FILTERS.map(({ value }) => ({ value })), defaultValue: "moves", description: "Which hiring moves the board lists: own moves, one direction, or every measured company." },
        { key: "view", type: "enum" as const, settingKey: "movesView", values: MOVES_VIEWS.map(({ value }) => ({ value })), defaultValue: "weeks", description: "A company's Moves tab: its weeks, the role families or titles behind the move, or the postings first seen or closed that week." },
        { key: "kind", type: "enum" as const, settingKey: "signalsKind", values: [...new Set(SIGNAL_GROUPS.flatMap((group) => SIGNAL_FILTERS[group].map(({ value }) => value)))].map((value) => ({ value })), defaultValue: "all",
          description: "Which signals the Expansion or Anomalies board lists: new countries or cities, place or role-family spikes, or new role families." },
        { key: "signalsView", aliases: ["signals-view"], type: "enum" as const, settingKey: "signalsView", values: SIGNALS_VIEWS.map(({ value }) => ({ value })), defaultValue: "signals",
          description: "A company's Expansion or Anomalies tab: its signals, or the postings behind this week's." },
      ] : []),
      ...(kind === "apps" ? [
        { key: "appId", aliases: ["app-id"], type: "string" as const, settingKey: "appId", description: "Open one app's exact country/chart rank history instead of a company." },
        { key: "store", type: "enum" as const, settingKey: "store", values: [{ value: "app-store" }, { value: "google-play" }], defaultValue: "app-store", description: "Store for an individual app history." },
        { key: "country", type: "string" as const, settingKey: "country", description: "Country ISO code; omit for every covered country." },
        { key: "chart", type: "enum" as const, settingKey: "chart", values: ["free", "paid", "unranked"].map((value) => ({ value })), description: "Chart basis. Unranked observations have no chart rank." },
        { key: "days", type: "string" as const, settingKey: "days", defaultValue: "90", description: "Calendar history window, 7 to 730 days." },
      ] : []),
    ],
    discovery: { aliases: [kind === "hiring" ? "HIRE" : "APPS"], dataRequirements: ["Gloom Cloud account"], limitations: kind === "hiring"
      ? ["Pro: full weekly history and evidence; free preview.", "Observed requisitions, not headcount or confirmed office openings.", "History begins with retained captures; incomplete snapshots cannot imply hiring freezes."]
      : ["Pro: full chart history and evidence; free preview.", "Public top charts are an observed subset, not downloads or revenue.", "Grossing feeds are unavailable; written reviews are distinct from ratings.", "Mappings use evidenced ownership; unmapped apps stay visible."] },
    describe: (args) => `${kind === "hiring" ? "Hiring momentum" : "App attention"}${args.symbols[0] ? ` | ${args.symbols[0]}` : ""}`,
    async load(args, ctx) {
      if (kind === "apps" && typeof args.options.appId === "string" && args.options.appId) {
        const store = args.options.store === "google-play" ? "google-play" : "app-store";
        const rank = await fetchAppRank({ store, appId: args.options.appId, name: args.options.appId, country: String(args.options.country || (store === "google-play" ? "GLOBAL" : "US")).toUpperCase(), chart: (args.options.chart || (store === "google-play" ? "unranked" : "free")) as AppChart }, Number(args.options.days) || 90, Number(args.options.offset) || 0, ctx.signal, ctx.apiClient, Number(args.options.limit) || 100);
        return { complete: rank.access === "pro" && rank.page.nextOffset === null, sections: [{ title: "App rank history", rows: rank.rankHistory }], metadata: { nextOffset: rank.page.nextOffset, preview: rank.access === "preview", lockedRows: rank.locked, provenance: rank } };
      }
      const movesFilter: HiringMovesFilter = typeof args.options.moves === "string" && isMovesFilter(args.options.moves) ? args.options.moves : "moves";
      // Moves are their own read; a server without them leaves the rest of the report as it was.
      const failed = (error: unknown) => error instanceof Error ? error : new Error(String(error));
      const movesRead = kind === "hiring" ? fetchMoves(args.symbols[0], { filter: movesFilter }, ctx.apiClient, ctx.signal).catch(failed) : null;
      // So are Expansion and Anomalies: a company's both groups in one read, the board one read each.
      const signalsKind = typeof args.options.kind === "string" ? args.options.kind : "all";
      const signalsRead = kind !== "hiring" ? null : Promise.all((args.symbols[0] ? ["expansion" as const] : SIGNAL_GROUPS).map((group) =>
        fetchSignals(group, args.symbols[0], { filter: isSignalsFilter(group, signalsKind) ? signalsKind : "all" }, ctx.apiClient, ctx.signal))).catch(failed);
      const data = await fetchAttention(kind, args.symbols[0], { limit: Number(args.options.limit) || 100, offset: Number(args.options.offset) || 0, ...(typeof args.options.country === "string" ? { country: args.options.country } : {}), ...(typeof args.options.chart === "string" ? { chart: args.options.chart as AppChart } : {}), days: Number(args.options.days) || 90 }, ctx.apiClient);
      const filtered = typeof args.options.country === "string" && !!args.options.country || typeof args.options.chart === "string" && !!args.options.chart;
      const model = kind === "hiring" ? hiringModel(data as HiringPayload | HiringBoard) : appsModel(data as AppAttentionPayload, undefined, filtered);
      const offset = Number(args.options.offset) || 0;
      // The free preview ignores the offset, so it has no next page to point at.
      const nextOffset = kind === "hiring" && "total" in data ? !data.preview && offset + data.companies.length < data.total ? offset + data.companies.length : null : (data as AppAttentionPayload).page?.nextOffset ?? null;
      const lock = kind === "hiring" ? hiringPreviewNote(data as HiringPayload | HiringBoard) : appsPreviewNote(data as AppAttentionPayload);
      const movesData = movesRead ? await movesRead : null;
      const movesModel = movesData && !(movesData instanceof Error) ? "moves" in movesData ? movesBoardModel(movesData, movesFilter) : companyMovesModel(movesData) : null;
      const movesLock = movesData && !(movesData instanceof Error) ? movesPreviewNote(movesData, movesFilter) : null;
      const signalsData = signalsRead ? await signalsRead : null;
      const signalsReads = !signalsData || signalsData instanceof Error ? [] : args.symbols[0] ? SIGNAL_GROUPS.map((group) => ({ group, data: signalsData[0]! })) : signalsData.map((data, index) => ({ group: SIGNAL_GROUPS[index]!, data }));
      const signalsLocks = !signalsData || signalsData instanceof Error ? [] : signalsData.map((data) => signalsPreviewNote(data, "group" in data && isSignalsFilter(data.group, signalsKind) ? signalsKind : undefined));
      // A company's move says why in one sentence; the board's rows each carry theirs.
      const why = movesModel?.latest?.why;
      const company = args.symbols[0] ? signalsReads[0]?.data : undefined;
      const held = company && !("group" in company) && company.held ? holdText(company.held) : null;
      const notes = [...model.notices, ...(nextOffset !== null ? [`Additional observations available with --offset ${nextOffset}.`] : []),
        ...(movesData instanceof Error ? [movesData.message] : []), ...(why ? [why] : []),
        ...(signalsData instanceof Error ? [signalsData.message] : []), ...(held ? [`No expansion or anomaly signal this week: ${held.toLowerCase()}.`] : [])];
      const movesSections = !movesModel ? [] : (args.symbols[0] ? ([["weeks", "Hiring moves"], ["drivers", "Move drivers"], ["added", "Postings first seen"]] as const) : ([["board", "Hiring moves"]] as const))
        .map(([id, title]) => movesSection(title, movesModel.sections[id]!, id === "board"));
      return {
        complete: !model.preview && !model.partial && nextOffset === null,
        ...(lock || movesLock || signalsLocks.some(Boolean) ? { errors: [lock, movesLock, ...signalsLocks].filter((line): line is string => !!line) } : {}),
        ...(notes.length ? { notes } : {}),
        // A ticker no observed app is mapped to says so once, not under each empty view.
        ...(model.unmapped ? { empty: model.unmapped } : {}),
        // The views the pane has tabs for, each headed by what its rows are.
        sections: attentionTabs(kind, args.symbols[0]).map((tab) => {
          const section = model.sections[tab];
          return { title: attentionSectionTitle(kind, tab, args.symbols[0]),
            columns: section.columns.map(reportColumn), empty: section.empty, ...(section.locked ? { locked: true } : {}),
            rows: section.rows.map((row) => ({ ...row.values, ...(row.url ? { sourceUrl: row.url } : {}), ...(row.details ? { evidence: row.details } : {}) })) };
        }).concat(movesSections, signalsSections(signalsReads, signalsKind)),
        metadata: { nextOffset, asOf: model.asOf, preview: model.preview, lockedRows: model.locked, unit: model.chart.unit, provenance: data },
      };
    },
  };
}
