import type { CreditBoardPoint } from "../../../api-client/credit-boards";
import type { SeriesDefinition, SeriesLoadResult } from "../../../series/types";
import { cachedSeriesNote } from "../shared/series-warning";
import { loadCdxBoard, loadSovrBoard } from "./client";

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

export const CREDIT_BOARD_SERIES: readonly SeriesDefinition[] = [
  ...INDEXES.map((index): SeriesDefinition => ({
    id: `cdx:${index.code.toLowerCase()}`,
    name: index.name,
    unit: index.quote === "spread" ? "bp" : "points",
    frequency: "daily",
    group: "Credit",
    tags: ["CDS", "index CDS", index.quote, "credit default swap"],
    load: async () => {
      const resource = await loadCdxBoard();
      return boardPoints(resource.payload.indexes, index.code, index.name, resource);
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
