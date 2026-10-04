import type { DataTableColumn, StatItem } from "../../../components";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import type { HiringBoard, HiringPayload, HiringSummary } from "../../../api-client/hiring";
import type { AppAttentionPayload, AppCompany } from "../../../api-client/app-attention";

export type AttentionKind = "hiring" | "apps";
export type AttentionTab = "table" | "chart" | "mix" | "peers" | "evidence";
export interface AttentionRow {
  id: string;
  values: Record<string, string | number | null>;
  symbol?: string;
  date?: string;
  url?: string | null;
  details?: Array<{ label: string; value: string }>;
  app?: AppFocus;
}
export interface AppFocus { store: "app-store" | "google-play"; appId: string; name: string; country: string; chart: "free" | "paid" | "grossing" | "unranked" }
interface AttentionSection {
  columns: DataTableColumn[];
  rows: AttentionRow[];
  empty: string;
}
export interface AttentionModel {
  asOf: string | null;
  preview: boolean;
  locked: number;
  notices: string[];
  figures: StatItem[];
  sections: Record<AttentionTab, AttentionSection>;
  chart: { label: string; unit: string; points: Array<{ date: string; value: number | null }> };
}
export const count = (value: number | null | undefined) => value == null ? "--" : value.toLocaleString("en-US", { maximumFractionDigits: 0 });
const signed = (value: number | null | undefined, decimals = 0) => value == null ? "--" : `${value > 0 ? "+" : ""}${value.toLocaleString("en-US", { maximumFractionDigits: decimals })}`;
const percent = (value: number | null | undefined) => value == null ? "--" : `${(value * 100).toFixed(1)}%`;
const column = (id: string, label: string, width: number, numeric = false, flex = false): DataTableColumn => ({ id, label, width, align: numeric ? "right" : "left", ...(flex ? { flexGrow: 1 } : {}) });
const roleFamily = (value: string | null) => value === "data_ai" ? "Data / AI" : value?.replace(/_/g, " ") ?? null;
const COMPANY_COLUMNS = [column("symbol", "Ticker", 12), column("name", "Company", 24, false, true), column("open", "Open roles", 12, true), column("net", "Net / week", 12, true), column("remote", "Remote %", 10, true), column("z", "Z-score", 10, true), column("signal", "Signal", 12), column("date", "As of", 12)];
const HISTORY_COLUMNS = [column("date", "Week", 12), column("open", "Open roles", 12, true), column("added", "Added", 9, true), column("removed", "Removed", 9, true), column("net", "Net", 9, true), column("change", "Change %", 11, true), column("remote", "Remote %", 10, true), column("coverage", "Capture", 13, false, true)];
const companyRow = (row: HiringSummary): AttentionRow => ({ id: row.symbol, symbol: row.symbol, values: { symbol: row.symbol, name: row.name, open: row.latest?.openCount ?? null, net: row.latest?.netChange ?? null, remote: row.latest?.remoteShare == null ? null : row.latest.remoteShare * 100, z: row.zScore, signal: row.signal ?? row.status, date: row.latest?.observedAt.slice(0, 10) ?? null } });

export function hiringModel(data: HiringBoard | HiringPayload, mix = "functions"): AttentionModel {
  const detail = "series" in data ? data : null;
  const companies = "companies" in data ? data.companies : [data];
  const history = detail?.series ?? [];
  const latest = detail?.latest;
  const mixKey = ["functions", "seniority", "countries", "locations", "signals"].includes(mix) ? mix as "functions" | "seniority" | "countries" | "locations" | "signals" : "functions";
  const rows = mixKey === "signals" ? (detail?.signals ?? []).map((row, i): AttentionRow => ({ id: `${row.type}:${i}`, url: row.evidenceUrls[0], values: { label: row.label, count: row.value, share: row.confidence * 100, date: row.asOf.slice(0, 10) }, details: [{ label: "Observed", value: row.asOf }, { label: "Confidence", value: percent(row.confidence) }, { label: "Location", value: row.location ?? "--" }] }))
    : (detail?.[mixKey] ?? []).map((row): AttentionRow => ({ id: row.id, values: { label: row.label, count: row.count, share: row.share * 100 } }));
  const model: AttentionModel = {
    asOf: latest?.observedAt ?? data.generatedAt,
    preview: data.preview,
    locked: typeof data.locked === "number" ? data.locked : Object.values(data.locked).reduce((a, b) => a + b, 0),
    notices: detail ? [detail.coverage.comparability, ...(latest?.completeness !== "complete" ? ["The latest capture has incomplete or unknown coverage."] : []), ...(detail.status === "stale" ? ["The latest hiring capture is stale."] : [])].filter(Boolean) : [],
    figures: latest ? [
      { label: "Open roles", value: count(latest.openCount) },
      { label: "Net / week", value: signed(latest.netChange), tone: latest.netChange == null ? "muted" : latest.netChange >= 0 ? "positive" : "negative" },
      { label: "Remote", value: percent(latest.remoteShare), detail: "known work modes" },
      { label: "Z-score", value: detail?.zScore?.toFixed(2) ?? "--", detail: detail?.signal ?? undefined },
    ] : [],
    sections: {
      table: { columns: COMPANY_COLUMNS, rows: companies.map(companyRow), empty: "Hiring observations are not available yet." },
      chart: { columns: HISTORY_COLUMNS, rows: [...history].reverse().map((row): AttentionRow => ({ id: row.week, date: row.week, values: { date: row.week, open: row.openCount, added: row.added, removed: row.removed, net: row.netChange, change: row.changePct, remote: row.remoteShare == null ? null : row.remoteShare * 100, coverage: row.completeness }, details: [{ label: "Observed", value: row.observedAt }, { label: "Confidence", value: percent(row.confidence) }, { label: "Capture", value: row.kind }, { label: "Evergreen roles", value: count(row.evergreenCount) }] })), empty: data.preview ? "Full hiring history requires Pro." : "History is accumulating from the first capture." },
      mix: { columns: [column("label", mixKey === "signals" ? "Signal" : "Group", 28, false, true), column("count", mixKey === "signals" ? "Value" : "Roles", 12, true), column("share", mixKey === "signals" ? "Confidence %" : "Share %", 14, true), ...(mixKey === "signals" ? [column("date", "Observed", 12)] : [])], rows, empty: "No classified observations for this group yet." },
      peers: { columns: COMPANY_COLUMNS, rows: (detail?.peers ?? []).map(companyRow), empty: "No comparable mapped peers yet." },
      evidence: { columns: [column("title", "Role", 32, false, true), column("location", "Location", 24), column("function", "Function", 18), column("seniority", "Seniority", 13), column("date", "Observed", 12), column("confidence", "Confidence %", 13, true)], rows: (detail?.evidence ?? []).map((row): AttentionRow => ({ id: `${row.snapshotId}:${row.id}`, url: row.url ?? row.sourceUrl, values: { title: row.title, location: row.location, function: roleFamily(row.jobFunction), seniority: row.seniority, date: row.observedAt.slice(0, 10), confidence: row.confidence * 100 }, details: [{ label: "Posting title", value: row.title }, { label: "Location", value: row.location ?? "--" }, { label: "Country", value: row.country ?? "Unknown" }, { label: "Function", value: row.jobFunction ?? "Unclassified" }, { label: "Seniority", value: row.seniority ?? "Unclassified" }, { label: "Remote", value: row.remote === null ? "Unknown" : row.remote ? "Yes" : "No" }, { label: "Observed", value: row.observedAt }, { label: "Revision", value: String(row.revision) }, { label: "Confidence", value: percent(row.confidence) }, { label: "Reporting ticker", value: row.sourceTicker }] })), empty: "No primary posting evidence is available yet." },
    },
    chart: { label: "Open roles", unit: "roles", points: history.map((point) => ({ date: point.week, value: point.openCount })) },
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
export function appsModel(data: AppAttentionPayload, mix = "countries"): AttentionModel {
  const evidence = data.evidence.map((row): AttentionRow => ({ id: `${row.revisionId}:${row.appId}`, url: row.sourceUrl, values: { name: row.name, country: row.country, chart: row.chart, rank: row.rank, observed: row.observedAt.slice(0, 10), confidence: row.confidence * 100 }, details: [{ label: "App", value: row.name }, { label: "App ID", value: row.appId }, { label: "Country / chart", value: `${row.country} / ${row.chart}` }, { label: "Rank", value: count(row.rank) }, { label: "Rating", value: row.rating?.toFixed(2) ?? "--" }, { label: "Ratings", value: count(row.ratingCount) }, { label: "Written reviews", value: count(row.reviewCount) }, { label: "Observed", value: row.observedAt }, { label: "Published", value: row.sourceUpdatedAt ?? "Unavailable" }, { label: "Revision", value: row.revisionId }, { label: "Supersedes", value: row.supersedesRevisionId ?? "Initial capture" }, { label: "Mapping confidence", value: percent(row.confidence) }, ...(row.mappingSourceUrl ? [{ label: "Ownership evidence", value: row.mappingSourceUrl }] : []), ...(row.ratingSourceUrl ? [{ label: "Rating evidence", value: row.ratingSourceUrl }] : [])] }));
  return {
    asOf: data.summary.lastObservedAt,
    preview: data.access === "preview",
    locked: Object.values(data.locked).reduce((a, b) => a + b, 0),
    notices: [...data.coverage.limitations, ...(data.apps.some((row) => row.stale) ? ["Some app observations are stale."] : [])],
    figures: [
      { label: "Attention score", value: data.summary.attentionScore?.toFixed(1) ?? "--", detail: "/ 100" },
      { label: "Rank velocity", value: signed(data.summary.rankVelocity7d, 2), detail: "places / day" },
      { label: "Rating drift", value: signed(data.summary.ratingChange7d, 2), detail: "7D / 5" },
      { label: "Ratings added", value: signed(data.summary.ratingCountGrowth7d), detail: "7D" },
    ],
    sections: {
      table: { columns: APP_COLUMNS, rows: data.apps.map((row): AttentionRow => ({ id: `${row.sourceId}:${row.appId}`, app: { store: row.store, appId: row.appId, name: row.name, country: row.country, chart: row.chart }, symbol: row.symbol ?? undefined, url: row.appUrl, values: { name: row.name, symbol: row.symbol, country: row.country, chart: row.chart, rank: row.rank, change: row.rankChange7d, rating: row.rating, ratings: row.ratingCount, drift: row.ratingChange7d, growth: row.ratingCountGrowth7d }, details: [{ label: "App", value: row.name }, { label: "Developer", value: row.developer }, { label: "Parent ticker", value: row.symbol ?? "Unmapped" }, { label: "Genres", value: row.genres.join(", ") || "--" }, { label: "Observed", value: row.observedAt }, { label: "Ratings observed", value: row.ratingObservedAt ?? "Unavailable" }, { label: "Mapping confidence", value: percent(row.confidence) }, { label: "Mapping revision", value: row.mappingRevisionId ?? "Unmapped" }, { label: "Capture revision", value: row.revisionId }] })), empty: "No app observations match these filters yet." },
      chart: { columns: [column("date", "Date", 12), column("score", "Score / 100", 14, true), column("change", "Change", 10, true), column("apps", "Apps", 9, true), column("countries", "Countries", 12, true), column("rating", "Rating / 5", 12, true), column("ratings", "Ratings", 13, true)], rows: data.history.map((point, i, all): AttentionRow => ({ id: point.date, date: point.date, values: { date: point.date, score: point.attentionScore, change: point.attentionScore != null && all[i - 1]?.attentionScore != null ? point.attentionScore - all[i - 1]!.attentionScore! : null, apps: point.appCount, countries: point.countryCount, rating: point.rating, ratings: point.ratingCount } })).reverse(), empty: data.access === "preview" ? "Full app history requires Pro." : "History is accumulating from the first capture." },
      mix: mix === "spreads" ? { columns: [column("name", "App", 28, false, true), column("chart", "Chart", 10), column("best", "Best country", 15), column("bestRank", "Best rank", 11, true), column("worst", "Worst country", 15), column("worstRank", "Worst rank", 12, true), column("spread", "Rank spread", 13, true)], rows: data.spreads.map((row): AttentionRow => ({ id: `${row.appId}:${row.chart}:${row.category}`, values: { name: row.name, chart: row.chart, best: row.bestCountry, bestRank: row.bestRank, worst: row.worstCountry, worstRank: row.worstRank, spread: row.spread } })), empty: "Comparable country observations are accumulating." }
        : { columns: [column("country", "Country", 16, false, true), column("apps", "Apps", 9, true), column("ranked", "Ranked apps", 13, true), column("score", "Score / 100", 14, true), column("velocity", "Places / day", 15, true), column("date", "Observed", 12)], rows: data.countries.map((row): AttentionRow => ({ id: row.country, values: { country: row.country, apps: row.appCount, ranked: row.rankedApps, score: row.attentionScore, velocity: row.rankVelocity7d, date: row.observedAt.slice(0, 10) } })), empty: "Country observations are not available yet." },
      peers: { columns: APP_COMPANIES, rows: (data.symbol ? data.peers : data.companies).map(appCompanyRow), empty: "No comparable mapped companies yet." },
      evidence: { columns: [column("name", "App", 27, false, true), column("country", "Country", 10), column("chart", "Chart", 10), column("rank", "Rank", 8, true), column("observed", "Observed", 12), column("confidence", "Confidence %", 14, true)], rows: evidence, empty: "No primary chart evidence is available yet." },
    },
    chart: { label: "Attention score", unit: "/100", points: data.history.map((point) => ({ date: point.date, value: point.attentionScore })) },
  };
}
