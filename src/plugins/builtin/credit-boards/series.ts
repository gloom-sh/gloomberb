import type { CdxBoardIndex, CreditBoardPoint } from "../../../api-client/credit-boards";
import type { SeriesDefinition, SeriesLoadRequest, SeriesLoadResult, SeriesPoint } from "../../../series/types";
import { logFailure } from "../../../utils/log-failure";
import { cachedSeriesNote } from "../shared/series-warning";
import { loadCdxBoard, loadFullCdxHistory, loadSovrBoard } from "./client";

/** The five on-the-run 5Y index contracts the CDX tab lists; IG and iTraxx quote spread, HY and EM price. */
const INDEXES = [
  { code: "IG", name: "CDX IG 5Y", quote: "spread" },
  { code: "HY", name: "CDX HY 5Y", quote: "price" },
  { code: "EM", name: "CDX EM 5Y", quote: "price" },
  { code: "MAIN", name: "iTraxx Main 5Y", quote: "spread" },
  { code: "XOVER", name: "iTraxx Crossover 5Y", quote: "spread" },
] as const;

/** The sovereigns the SOVR tab follows, by ISO code. */
const SOVEREIGNS: ReadonlyArray<readonly [code: string, name: string]> = [
  ["BR", "Brazil"], ["MX", "Mexico"], ["CO", "Colombia"], ["TR", "Turkey"], ["ZA", "South Africa"],
  ["CN", "China"], ["ID", "Indonesia"], ["CL", "Chile"], ["PE", "Peru"], ["PH", "Philippines"],
  ["AR", "Argentina"], ["PA", "Panama"], ["SA", "Saudi Arabia"], ["MY", "Malaysia"], ["EG", "Egypt"],
  ["KR", "Korea"], ["IT", "Italy"], ["FR", "France"], ["ES", "Spain"], ["GR", "Greece"],
  ["IE", "Ireland"], ["JP", "Japan"], ["IL", "Israel"], ["PL", "Poland"], ["QA", "Qatar"],
  ["AD", "Abu Dhabi"], ["BH", "Bahrain"], ["OM", "Oman"], ["MA", "Morocco"], ["NG", "Nigeria"],
  ["DO", "Dominican Republic"], ["CI", "Ivory Coast"],
];

function boardPoints(
  rows: ReadonlyArray<{ id: string; points: readonly CreditBoardPoint[] }>,
  id: string,
  label: string,
  resource: { stale?: boolean; refreshError?: string | null; savedAt?: number },
): SeriesLoadResult {
  const row = rows.find((entry) => entry.id === id);
  if (!row) throw new Error(`${label} is not on the board right now.`);
  return {
    points: row.points.map((point) => ({ date: point.date, value: point.level })),
    ...cachedSeriesNote(resource),
  };
}

/** A chart that starts within this of the board's first day is drawn from the board. */
const BOARD_SLACK_MS = 7 * 86_400_000;

type CdxSeriesResource = { stale?: boolean; refreshError?: string | null; savedAt?: number };

/** What a chart that asked for more than the board's year says when the rest did not load. */
const BOARD_YEAR_ONLY = "The full history did not load; showing the last year.";

/**
 * The indexes as a chart asks for them: the board, which holds a year, or
 * every day the server keeps when the chart starts before it (ALL, 5Y).
 * When that read fails the board's year stands in, said with `warning`.
 */
async function cdxIndexes(request: SeriesLoadRequest): Promise<{ indexes: readonly CdxBoardIndex[]; resource: CdxSeriesResource; warning?: string }> {
  const resource = await loadCdxBoard();
  const first = Math.min(...resource.payload.indexes.flatMap((index) => index.points.slice(0, 1).map((point) => Date.parse(`${point.date}T00:00:00Z`))));
  if (!request.start || request.start.getTime() < first - BOARD_SLACK_MS) {
    const full = await loadFullCdxHistory().catch(logFailure("credit-boards", "Read the full index CDS history failed", null));
    if (full) return { indexes: full.indexes, resource: {} };
    return { indexes: resource.payload.indexes, resource, warning: BOARD_YEAR_ONLY };
  }
  return { indexes: resource.payload.indexes, resource };
}

/** A CDX series' note: the board's own, or, when it stood in for the full history, that. */
function cdxSeriesNote({ resource, warning }: { resource: CdxSeriesResource; warning?: string }): Pick<SeriesLoadResult, "warning" | "savedAt"> {
  const note = cachedSeriesNote(resource);
  return warning ? { ...note, warning: note.warning ? `${warning} ${note.warning}` : warning } : note;
}

/**
 * HY and EM's price as the spread credit desks compare (each day's on its
 * on-the-run contract, ISDA standard model at the index's coupon and standard
 * recovery), so HY less IG, or cash less CDX, is one formula in bp.
 */
function spreadEquivalentPoints(indexes: readonly CdxBoardIndex[], code: string, name: string): SeriesPoint[] {
  const row = indexes.find((entry) => entry.id === code);
  if (!row) throw new Error(`${name} is not on the board right now.`);
  const points = row.points.flatMap((point) => typeof point.spreadBp === "number" ? [{ date: point.date, value: point.spreadBp }] : []);
  if (points.length === 0) throw new Error(`${name} has no spread equivalent from this server yet.`);
  return points;
}

export const CREDIT_BOARD_SERIES: readonly SeriesDefinition[] = [
  ...INDEXES.map((index): SeriesDefinition => ({
    id: `cdx:${index.code.toLowerCase()}`,
    name: index.name,
    unit: index.quote === "spread" ? "bp" : "points",
    frequency: "daily",
    group: "Credit",
    tags: ["CDS", "index CDS", index.quote, "credit default swap"],
    load: async (request) => {
      const read = await cdxIndexes(request);
      return { ...boardPoints(read.indexes, index.code, index.name, read.resource), ...cdxSeriesNote(read) };
    },
  })),
  ...INDEXES.filter((index) => index.quote === "price").map((index): SeriesDefinition => ({
    id: `cdx:${index.code.toLowerCase()}-spread`,
    name: `${index.name} spread eq`,
    unit: "bp",
    frequency: "daily",
    group: "Credit",
    tags: ["CDS", "index CDS", "spread", "spread equivalent", index.code, "credit default swap"],
    description: `${index.name}'s daily price as a conventional spread: a model figure from the ISDA standard model at the index's coupon and standard recovery, on each day's on-the-run contract, not a traded spread.`,
    load: async (request) => {
      const read = await cdxIndexes(request);
      return { points: spreadEquivalentPoints(read.indexes, index.code, `${index.name} spread eq`), ...cdxSeriesNote(read) };
    },
  })),
  ...SOVEREIGNS.map(([code, name]): SeriesDefinition => ({
    id: `sovereign-cds:${code.toLowerCase()}`,
    name: `${name} 5Y sovereign CDS`,
    unit: "bp",
    frequency: "daily",
    group: "Credit",
    tags: ["CDS", "sovereign", code, "credit default swap"],
    load: async () => {
      const resource = await loadSovrBoard();
      return boardPoints(resource.payload.sovereigns, code, name, resource);
    },
  })),
];
