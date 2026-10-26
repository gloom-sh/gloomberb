import type { DataTableColumn, StatItem } from "../../../components";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import type { HiringBoard, HiringPayload, HiringSummary } from "../../../api-client/hiring";
import type { AppAttentionPayload, AppCompany } from "../../../api-client/app-attention";
import { humanLabel } from "../shared/research-cells";
import { formatNumber } from "../../../utils/format";
import { countOf, freePreviewNote } from "../shared/free-preview";
import { countryName, postingPlace, postingTitle } from "../shared/job-posting";
import { formatShortDate } from "../../../utils/datetime-format";

export type AttentionKind = "hiring" | "apps";
export type AttentionTab = "table" | "chart" | "mix" | "peers" | "evidence";
export interface AttentionRow {
  id: string;
  values: Record<string, string | number | null>;
  symbol?: string;
  date?: string;
  url?: string | null;
  /** What the row's detail reads: facts in words, only those the row has (no dashes, ids, revisions or confidences). */
  details?: AttentionFact[];
  /** Links the detail offers by name (an ownership filing, a ratings page), never as a bare address. */
  links?: Array<{ label: string; url: string }>;
  /** A posting whose page the detail reads: its title, place, date, pay, hours and description. */
  posting?: { ticker: string; externalId: string };
  app?: AppFocus;
}
interface AttentionFact { label: string; value: string }
export interface AppFocus { store: "app-store" | "google-play"; appId: string; name: string; country: string; chart: "free" | "paid" | "grossing" | "unranked" }
interface AttentionSection {
  columns: DataTableColumn[];
  rows: AttentionRow[];
  empty: string;
  /** The free preview holds this view's rows back: a report says so once, on its Pro line, not under the view. */
  locked?: boolean;
}
export interface AttentionModel {
  asOf: string | null;
  preview: boolean;
  locked: number;
  /** Caveats about the capture, such as incomplete coverage; they never fail a report. */
  notices: string[];
  /** The latest capture is incomplete or stale, so a report of it is not the whole picture even on Pro. */
  partial: boolean;
  figures: StatItem[];
  sections: Record<AttentionTab, AttentionSection>;
  /**
   * Why every view is empty, when one reason covers them all: a ticker no observed app is mapped to. A report says
   * it once in place of each view's own empty line.
   */
  unmapped?: string;
  /** `since`: the first capture, so a chart still collecting says when it began. */
  chart: { label: string; unit: string; points: Array<{ date: string; value: number | null }>; since?: string | null };
}
/** The views a report has: a company's hiring and every apps report all five, the hiring board only its table. */
export function attentionTabs(kind: AttentionKind, symbol: string | null | undefined): AttentionTab[] {
  return kind === "apps" || symbol ? ["table", "chart", "mix", "peers", "evidence"] : ["table"];
}

/**
 * A pane tab: a report view, or HIRE's moves, expansion, anomalies and
 * building, which have their own reads (moves-model.ts, signals-model.ts,
 * building-model.ts).
 */
export type AttentionPaneTab = AttentionTab | "moves" | "expansion" | "anomalies" | "building";
const HIRING_READ_TABS = ["moves", "expansion", "anomalies", "building"] as const;
export function attentionPaneTabs(kind: AttentionKind, symbol: string | null | undefined): AttentionPaneTab[] {
  return kind === "hiring" ? [...attentionTabs(kind, symbol), ...HIRING_READ_TABS] : attentionTabs(kind, symbol);
}

/**
 * A view's heading where the report prints it in full, as `fn HIRE` does:
 * what its rows are (Open roles, Hiring trend), where the pane's tab says it
 * in a word. The mix is the grouping the model chose.
 */
export function attentionSectionTitle(kind: AttentionKind, tab: AttentionTab, symbol: string | null | undefined, mix?: string): string {
  if (kind === "hiring") {
    return { table: symbol ? "Open roles" : "Companies hiring", chart: "Hiring trend", mix: HIRING_MIX_TITLES[mix ?? "functions"] ?? "Role family",
      peers: "Peers", evidence: "Posting evidence" }[tab];
  }
  return { table: "App ranks", chart: "Attention trend", mix: mix === "spreads" ? "Rank spreads" : "Countries",
    peers: symbol ? "Peers" : "Companies", evidence: "Chart evidence" }[tab];
}

const HIRING_MIX_TITLES: Record<string, string> = { functions: "Role family", seniority: "Seniority", countries: "Countries", locations: "Locations", signals: "Signals" };

export const count = (value: number | null | undefined) => value == null ? "--" : value.toLocaleString("en-US", { maximumFractionDigits: 0 });
/** Decimals per column: percentages and scores to one place, ratings and z-scores to two, counts and remote shares whole. */
const DECIMALS: Record<string, number> = { score: 1, remote: 0, share: 1, confidence: 0, velocity: 2, rating: 2, drift: 2, z: 2, change: 1 };
export const SIGNED_COLUMNS = new Set(["net", "change", "velocity", "drift", "growth"]);
/** A column's number as the pane and the text report print it. */
export const attentionNumber = (columnId: string, value: number) =>
  `${SIGNED_COLUMNS.has(columnId) && value > 0 ? "+" : ""}${formatNumber(value, DECIMALS[columnId] ?? 0)}`;
/**
 * A remote share with the roles it is measured on. Most postings never state a
 * work mode, so the share counts only those that do: 100% of 5 is not 100% of
 * a company's 300 roles. A capture that did not count them says "of known".
 */
export function remoteText(percentRemote: number | null | undefined, known: number | null | undefined): string | null {
  if (percentRemote == null) return null;
  return `${formatNumber(percentRemote, 0)}% of ${known == null ? "" : `${formatNumber(known, 0)} `}known`;
}
const signed = (value: number | null | undefined, decimals = 0) => value == null ? "--" : `${value > 0 ? "+" : ""}${value.toLocaleString("en-US", { maximumFractionDigits: decimals })}`;
/** A date in words ("Oct 22, 2026"), for a capture's ISO timestamp. */
const day = (value: string | null | undefined) => value ? formatShortDate(value.slice(0, 10), { utc: true, fallback: "" }) || null : null;
/** The facts that have a value, in order. */
const facts = (entries: Array<[string, string | number | null | undefined]>): AttentionFact[] =>
  entries.flatMap(([label, value]) => value == null || value === "" ? [] : [{ label, value: String(value) }]);
const CAPTURES: Record<string, string> = { complete: "Complete", partial: "Partial", unknown: "Coverage not known" };
const column = (id: string, label: string, width: number, numeric = false, flex = false): DataTableColumn => ({ id, label, width, align: numeric ? "right" : "left", ...(flex ? { flexGrow: 1 } : {}) });
const roleFamily = (value: string | null) => value === "data_ai" || value === "data ai" ? "Data / AI" : value ? humanLabel(value) : null;
const COMPANY_COLUMNS = [column("symbol", "Ticker", 12), column("name", "Company", 24, false, true), column("open", "Open roles", 12, true), column("net", "Net / week", 12, true), column("remote", "Remote %", 17, true), column("z", "Z-score", 10, true), column("signal", "Signal", 12), column("date", "As of", 12)];
const HISTORY_COLUMNS = [column("date", "Week", 12), column("open", "Open roles", 12, true), column("added", "Added", 9, true), column("removed", "Removed", 9, true), column("net", "Net", 9, true), column("change", "Change %", 11, true), column("remote", "Remote %", 17, true), column("coverage", "Capture", 13, false, true)];
/** `remoteKnown` rides along for the remote cell; it is not a column of its own. */
const companyRow = (row: HiringSummary): AttentionRow => ({ id: row.symbol, symbol: row.symbol, values: { symbol: row.symbol, name: row.name, open: row.latest?.openCount ?? null, net: row.latest?.netChange ?? null, remote: row.latest?.remoteShare == null ? null : row.latest.remoteShare * 100, remoteKnown: row.latest?.remoteKnown ?? null, z: row.zScore, signal: humanLabel(row.signal ?? row.status), date: row.latest?.observedAt.slice(0, 10) ?? null } });

/** The weeks of history a free preview holds back; the board has none to hold. */
const hiringHistoryLocked = (data: HiringBoard | HiringPayload) => !data.preview ? 0 : typeof data.locked === "number" ? data.locked : data.locked.history;

/** "a, b and c". */
const joinList = (items: readonly string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const grouped = (value: number) => value.toLocaleString("en-US");

/**
 * The lock line of a free HIRE preview: how many of its rows free shows, what
 * Pro adds and when its weekly history starts. Null when the preview holds
 * nothing back (a company with no captures has nothing to unlock).
 */
export function hiringPreviewNote(data: HiringBoard | HiringPayload): string | null {
  if (!data.preview) return null;
  if ("companies" in data) {
    if (data.locked <= 0) return null;
    return freePreviewNote({ shows: `${data.companies.length} of ${grouped(data.total)} companies`, adds: `the other ${grouped(data.locked)}` });
  }
  const { evidence, history, peers } = data.locked;
  if (evidence + history + peers <= 0) return null;
  const roles = data.evidence.length;
  return freePreviewNote({
    shows: evidence > 0 ? `${roles} of ${grouped(roles + evidence)} open roles` : countOf(roles, "open role"),
    adds: joinList([evidence > 0 ? `the other ${grouped(evidence)} roles` : "", history > 0 ? `${grouped(history)} ${history === 1 ? "week" : "weeks"} of history` : "", peers > 0 ? `${grouped(peers)} more peers` : ""].filter(Boolean)),
    historyFrom: history > 0 ? data.coverage.firstObservedAt : null,
  });
}

/**
 * The lock line of a free APPS preview: how many app ranks free shows, what
 * Pro adds and when its daily history starts. Null when nothing is held back.
 */
export function appsPreviewNote(data: AppAttentionPayload): string | null {
  if (data.access !== "preview") return null;
  const { apps, history } = data.locked;
  if (apps + history <= 0) return null;
  const ranks = data.apps.length;
  const days = data.history.length;
  return freePreviewNote({
    shows: `${apps > 0 ? `${ranks} of ${grouped(ranks + apps)} app ranks` : countOf(ranks, "app rank")}${days ? " and the latest day of history" : ""}`,
    adds: joinList([apps > 0 ? `the other ${grouped(apps)} ranks` : "", history > 0 ? `${grouped(history)} earlier ${history === 1 ? "day" : "days"} of history` : ""].filter(Boolean)),
    historyFrom: history > 0 ? data.summary.firstObservedAt : null,
  });
}

export function hiringModel(data: HiringBoard | HiringPayload, mix = "functions"): AttentionModel {
  const detail = "series" in data ? data : null;
  const companies = "companies" in data ? data.companies : [data];
  const history = detail?.series ?? [];
  const latest = detail?.latest;
  const mixKey = ["functions", "seniority", "countries", "locations", "signals"].includes(mix) ? mix as "functions" | "seniority" | "countries" | "locations" | "signals" : "functions";
  const rows = mixKey === "signals" ? (detail?.signals ?? []).map((row, i): AttentionRow => ({ id: `${row.type}:${i}`, url: row.evidenceUrls[0], values: { label: row.label, count: row.value, share: row.confidence * 100, date: row.asOf.slice(0, 10) }, details: facts([["As of", day(row.asOf)], ["Location", row.location]]) }))
    : (detail?.[mixKey] ?? []).map((row): AttentionRow => ({ id: row.id, values: { label: mixKey === "functions" ? roleFamily(row.label) : mixKey === "seniority" ? humanLabel(row.label) : row.label, count: row.count, share: row.share * 100 } }));
  const model: AttentionModel = {
    asOf: latest?.observedAt ?? data.generatedAt,
    preview: data.preview,
    locked: typeof data.locked === "number" ? data.locked : Object.values(data.locked).reduce((a, b) => a + b, 0),
    // How counts compare is methodology (docs/hiring-app-attention.md); the footer keeps only what is wrong with this capture.
    notices: detail ? [...(latest?.completeness !== "complete" ? ["The latest capture has incomplete or unknown coverage."] : []), ...(detail.status === "stale" ? ["The latest hiring capture is stale."] : [])] : [],
    partial: !!detail && (latest?.completeness !== "complete" || detail.status === "stale"),
    // A figure the first capture cannot give yet (a weekly change, a z-score) is left out, not shown as a dash.
    figures: latest ? [
      { label: "Open roles", value: count(latest.openCount) },
      ...(latest.netChange != null ? [{ label: "Net / week", value: signed(latest.netChange), tone: latest.netChange === 0 ? "muted" as const : latest.netChange > 0 ? "positive" as const : "negative" as const }] : []),
      ...(latest.remoteShare != null ? [{ label: "Remote", value: `${formatNumber(latest.remoteShare * 100, 0)}%`,
        detail: latest.remoteKnown == null ? "of known work modes" : `of ${count(latest.remoteKnown)} known` }] : []),
      ...(detail?.zScore != null ? [{ label: "Z-score", value: detail.zScore.toFixed(2), detail: detail.signal ? `hiring ${detail.signal}` : undefined,
        tone: detail.signal === "surge" ? "positive" as const : detail.signal === "freeze" ? "negative" as const : undefined }] : []),
    ] : [],
    sections: {
      table: { columns: COMPANY_COLUMNS, rows: companies.map(companyRow), empty: "Hiring observations are not available yet." },
      chart: { columns: HISTORY_COLUMNS, rows: [...history].reverse().map((row): AttentionRow => ({ id: row.week, date: row.week, values: { date: row.week, open: row.openCount, added: row.added, removed: row.removed, net: row.netChange, change: row.changePct, remote: row.remoteShare == null ? null : row.remoteShare * 100, remoteKnown: row.remoteKnown, coverage: row.completeness }, details: facts([["Captured", day(row.observedAt)], ["Coverage", CAPTURES[row.completeness] ?? null], ["Open roles", count(row.openCount)], ["Standing roles", row.evergreenCount ? count(row.evergreenCount) : null]]) })), empty: hiringHistoryLocked(data) ? "Weekly history is part of Gloom Pro." : "History is accumulating from the first capture.", ...(hiringHistoryLocked(data) ? { locked: true } : {}) },
      mix: { columns: [column("label", mixKey === "signals" ? "Signal" : "Group", 28, false, true), column("count", mixKey === "signals" ? "Value" : "Roles", 12, true), column("share", mixKey === "signals" ? "Confidence %" : "Share %", mixKey === "signals" ? 14 : 30, true), ...(mixKey === "signals" ? [column("date", "Observed", 12)] : [])], rows, empty: "No classified observations for this group yet." },
      peers: { columns: COMPANY_COLUMNS, rows: (detail?.peers ?? []).map(companyRow), empty: "No comparable mapped peers yet." },
      evidence: { columns: [column("title", "Role", 32, false, true), column("location", "Location", 24), column("function", "Function", 18), column("seniority", "Seniority", 13), column("date", "Observed", 12), column("confidence", "Confidence %", 13, true)], rows: (detail?.evidence ?? []).map((row): AttentionRow => ({ id: `${row.snapshotId}:${row.id}`, url: row.url ?? row.sourceUrl, values: { title: postingTitle(row.title, row.id), location: row.location, function: roleFamily(row.jobFunction), seniority: row.seniority ? humanLabel(row.seniority) : null, date: row.observedAt.slice(0, 10), confidence: row.confidence * 100 }, details: facts([["Place", postingPlace(row)], ["Role family", roleFamily(row.jobFunction)], ["Seniority", row.seniority ? humanLabel(row.seniority) : null], ["Seen", day(row.observedAt)]]),
        posting: { ticker: row.sourceTicker, externalId: row.id } })), empty: "No primary posting evidence is available yet." },
    },
    chart: { label: "Open roles", unit: "roles", points: history.map((point) => ({ date: point.week, value: point.openCount })), since: detail?.coverage.firstObservedAt ?? null },
  };
  if (detail) {
    model.sections.table = { ...model.sections.evidence, columns: model.sections.evidence.columns.filter((entry) => entry.id !== "confidence"), empty: "No current role evidence has been captured yet." };
  }
  return model;
}

export function attentionSeries(model: Pick<AttentionModel, "chart">, color: string) {
  // One or two captures are observations, not an established trend.
  if (model.chart.points.filter((point) => point.value !== null).length < 3) return [];
  const cadence = model.chart.unit === "roles" ? 7 * 86_400_000 : 86_400_000;
  const points = [...model.chart.points].sort((a, b) => a.date.localeCompare(b.date)).flatMap((point, i, all) => {
    const time = Date.parse(point.date), previous = i ? Date.parse(all[i - 1]!.date) : null;
    const gap = previous !== null && time - previous > cadence * 1.5;
    return [...(gap ? [scalarPoint(new Date(previous + cadence), null)] : []), scalarPoint(new Date(time), point.value)];
  });
  return [{ ...staticSeries(points, { id: "company-attention", label: model.chart.label, color, calendarSpaced: true }), unit: model.chart.unit, unitGroup: model.chart.unit }];
}

export function sortAttentionRows(rows: AttentionRow[], columnId: string, direction: "asc" | "desc") {
  return [...rows].sort((a, b) => {
    const left = a.values[columnId], right = b.values[columnId];
    if (left == null) return right == null ? a.id.localeCompare(b.id) : 1;
    if (right == null) return -1;
    const result = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    return (direction === "asc" ? result : -result) || a.id.localeCompare(b.id);
  });
}

const APP_COLUMNS = [column("name", "App", 27, false, true), column("symbol", "Ticker", 12), column("country", "Country", 9), column("chart", "Chart", 10), column("rank", "Rank", 7, true), column("change", "7D places", 12, true), column("rating", "Rating / 5", 12, true), column("ratings", "Ratings", 12, true), column("drift", "7D rating", 12, true), column("growth", "7D ratings", 12, true)];
const APP_COMPANIES = [column("symbol", "Ticker", 12), column("name", "Company", 24, false, true), column("score", "Score / 100", 13, true), column("velocity", "Places / day", 14, true), column("apps", "Apps", 8, true), column("countries", "Countries", 11, true), column("drift", "7D rating", 12, true), column("growth", "7D ratings", 12, true)];
const appCompanyRow = (row: AppCompany): AttentionRow => ({ id: row.symbol, symbol: row.symbol, values: { symbol: row.symbol, name: row.name, score: row.attentionScore, velocity: row.rankVelocity7d, apps: row.appCount, countries: row.countryCount, drift: row.ratingChange7d, growth: row.ratingCountGrowth7d } });
/**
 * Why a company's app report is empty when no observed app is mapped to its ticker at all: the charts are captured,
 * none of their apps belongs to it, and no filter narrowed them. The free preview shows the first rows of what Pro
 * sees, so an empty preview is never the free cap. Null when the report has rows, a filter is set, or nothing has
 * been captured yet.
 */
function appsUnmappedReason(data: AppAttentionPayload, filtered: boolean): string | null {
  if (!data.symbol || filtered || data.apps.length || (data.page?.total ?? 0) > 0 || data.summary.appCount > 0) return null;
  // Rows held back for Pro are apps it maps, so a capped preview is never read as none.
  if (!Object.values(data.locked).every((count) => !count)) return null;
  if (!data.coverage.sources.some((source) => source.captures > 0)) return null;
  return `${data.symbol} has no mapped apps in the observed App Store and Google Play charts.`;
}

/** `filtered`: a country or chart narrows the rows, so an empty table is about the filter, not the company. */
export function appsModel(data: AppAttentionPayload, mix = "countries", filtered = false): AttentionModel {
  const unmapped = appsUnmappedReason(data, filtered);
  const evidence = data.evidence.map((row): AttentionRow => ({ id: `${row.revisionId}:${row.appId}`, url: row.sourceUrl, values: { name: row.name, country: row.country, chart: row.chart, rank: row.rank, observed: row.observedAt.slice(0, 10), confidence: row.confidence * 100 }, details: facts([["Chart", `${countryName(row.country) ?? row.country} · ${humanLabel(row.chart)}`], ["Rank", row.rank == null ? null : count(row.rank)], ["Rating", row.rating == null ? null : `${row.rating.toFixed(2)} / 5`], ["Ratings", row.ratingCount == null ? null : count(row.ratingCount)], ["Written reviews", row.reviewCount == null ? null : count(row.reviewCount)], ["Seen", day(row.observedAt)], ["Updated in store", day(row.sourceUpdatedAt)]]),
    links: [...(row.mappingSourceUrl ? [{ label: "Ownership", url: row.mappingSourceUrl }] : []), ...(row.ratingSourceUrl ? [{ label: "Ratings", url: row.ratingSourceUrl }] : [])] }));
  return {
    asOf: data.summary.lastObservedAt,
    preview: data.access === "preview",
    locked: Object.values(data.locked).reduce((a, b) => a + b, 0),
    notices: [...data.coverage.limitations, ...(data.apps.some((row) => row.stale) ? ["Some app observations are stale."] : [])],
    partial: data.apps.some((row) => row.stale),
    ...(unmapped ? { unmapped } : {}),
    // Seven-day figures appear once a week of captures can give them.
    figures: [
      { label: "Attention score", value: data.summary.attentionScore?.toFixed(1) ?? "--", detail: "/ 100" },
      ...(data.summary.rankVelocity7d != null ? [{ label: "Rank velocity", value: signed(data.summary.rankVelocity7d, 2), detail: "places / day" }]
        : [{ label: "Apps", value: count(data.summary.appCount), detail: `${count(data.summary.countryCount)} countries` }]),
      ...(data.summary.ratingChange7d != null ? [{ label: "Rating drift", value: signed(data.summary.ratingChange7d, 2), detail: "7D / 5" }] : []),
      ...(data.summary.ratingCountGrowth7d != null ? [{ label: "Ratings added", value: signed(data.summary.ratingCountGrowth7d), detail: "7D" }] : []),
    ],
    sections: {
      table: { columns: APP_COLUMNS, rows: data.apps.map((row): AttentionRow => ({ id: `${row.sourceId}:${row.appId}`, app: { store: row.store, appId: row.appId, name: row.name, country: row.country, chart: row.chart }, symbol: row.symbol ?? undefined, url: row.appUrl, values: { name: row.name, symbol: row.symbol, country: row.country, chart: row.chart, rank: row.rank, change: row.rankChange7d, rating: row.rating, ratings: row.ratingCount, drift: row.ratingChange7d, growth: row.ratingCountGrowth7d }, details: facts([["Developer", row.developer], ["Company", row.symbol], ["Genres", row.genres.join(", ")], ["Seen", day(row.observedAt)], ["Ratings seen", day(row.ratingObservedAt)]]) })), empty: unmapped ?? "No app observations match these filters yet." },
      chart: { columns: [column("date", "Date", 12), column("score", "Score / 100", 14, true), column("change", "Change", 10, true), column("apps", "Apps", 9, true), column("countries", "Countries", 12, true), column("rating", "Rating / 5", 12, true), column("ratings", "Ratings", 13, true)], rows: data.history.map((point, i, all): AttentionRow => ({ id: point.date, date: point.date, values: { date: point.date, score: point.attentionScore, change: point.attentionScore != null && all[i - 1]?.attentionScore != null ? point.attentionScore - all[i - 1]!.attentionScore! : null, apps: point.appCount, countries: point.countryCount, rating: point.rating, ratings: point.ratingCount } })).reverse(), empty: data.access === "preview" && data.locked.history > 0 ? "Daily history is part of Gloom Pro." : "History is accumulating from the first capture.", ...(data.access === "preview" && data.locked.history > 0 ? { locked: true } : {}) },
      mix: mix === "spreads" ? { columns: [column("name", "App", 28, false, true), column("chart", "Chart", 10), column("best", "Best country", 15), column("bestRank", "Best rank", 11, true), column("worst", "Worst country", 15), column("worstRank", "Worst rank", 12, true), column("spread", "Rank spread", 13, true)], rows: data.spreads.map((row): AttentionRow => ({ id: `${row.appId}:${row.chart}:${row.category}`, values: { name: row.name, chart: row.chart, best: row.bestCountry, bestRank: row.bestRank, worst: row.worstCountry, worstRank: row.worstRank, spread: row.spread } })), empty: "Comparable country observations are accumulating." }
        : { columns: [column("country", "Country", 16, false, true), column("apps", "Apps", 9, true), column("ranked", "Ranked apps", 13, true), column("score", "Score / 100", 14, true), column("velocity", "Places / day", 15, true), column("date", "Observed", 12)], rows: data.countries.map((row): AttentionRow => ({ id: row.country, values: { country: row.country, apps: row.appCount, ranked: row.rankedApps, score: row.attentionScore, velocity: row.rankVelocity7d, date: row.observedAt.slice(0, 10) } })), empty: "Country observations are not available yet." },
      peers: { columns: APP_COMPANIES, rows: (data.symbol ? data.peers : data.companies).map(appCompanyRow), empty: "No comparable mapped companies yet." },
      evidence: { columns: [column("name", "App", 27, false, true), column("country", "Country", 10), column("chart", "Chart", 10), column("rank", "Rank", 8, true), column("observed", "Observed", 12), column("confidence", "Confidence %", 14, true)], rows: evidence, empty: "No primary chart evidence is available yet." },
    },
    chart: { label: "Attention score", unit: "/100", points: data.history.map((point) => ({ date: point.date, value: point.attentionScore })) },
  };
}
