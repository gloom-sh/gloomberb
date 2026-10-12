import { apiClient } from "../../../api-client";
import type { SeriesDefinition } from "../../../series/types";
import { loadFredPoints } from "../shared/fred-points";
import { cachedSeriesWarning } from "../shared/series-warning";
import { IMPLIED_CORRELATION_ROWS, VOLATILITY_INDICES } from "./model";

/** VIX and VIX 3M come from FRED's daily closes, listed with the other FRED series. */
const FRED_LISTED = new Set(["vix", "vix3m"]);
const CORRELATION = IMPLIED_CORRELATION_ROWS as Readonly<Record<string, string>>;

const BOARD_NAMES: Readonly<Record<string, string>> = {
  vxn: "Nasdaq 100 volatility index",
  rvx: "Russell 2000 volatility index",
  ovx: "Oil volatility index",
  gvz: "Gold volatility index",
  vxeem: "Emerging markets volatility index",
  vxewz: "Brazil volatility index",
  vxapl: "Apple volatility index",
  vxazn: "Amazon volatility index",
  vxgog: "Alphabet volatility index",
  vxgs: "Goldman Sachs volatility index",
  vxibm: "IBM volatility index",
  cor1m: "S&P 500 implied correlation, 1 month",
  cor3m: "S&P 500 implied correlation, 3 months",
};

async function loadImpliedCorrelation(code: string) {
  const { series } = await apiClient.impliedVolatility<{ series: Array<{ id: string; observations: Array<{ date: string; value: number }> }> }>(
    "implied-correlation",
  );
  const match = series.find((entry) => entry.id === code);
  if (!match) throw new Error(`${code} history is unavailable.`);
  return match.observations.filter((row) => Number.isFinite(row.value) && row.value > 0)
    .map((row) => ({ date: row.date, value: row.value }));
}

/** Every index on the curve and the board, by its own close; implied correlation from its daily history. */
export const VOLATILITY_SERIES: readonly SeriesDefinition[] = [
  ...VOLATILITY_INDICES.filter((index) => !FRED_LISTED.has(index.id)).map((index): SeriesDefinition => {
    const name = BOARD_NAMES[index.id] ?? index.label;
    const tags = ["volatility", index.symbol.replace("^", "")];
    const code = CORRELATION[index.id];
    return code
      ? {
        id: `volatility:${index.id}`,
        name,
        unit: "index",
        frequency: "daily",
        group: "Volatility",
        tags: [...tags, "correlation"],
        load: async () => ({ points: await loadImpliedCorrelation(code) }),
      }
      : {
        id: `volatility:${index.id}`,
        name,
        unit: "index",
        frequency: "daily",
        group: "Volatility",
        tags,
        expression: `${index.symbol}:close`,
      };
  }),
  {
    id: "volatility:vix-term-ratio",
    name: "VIX 3M / VIX ratio",
    unit: "ratio",
    frequency: "daily",
    group: "Volatility",
    tags: ["term structure", "contango", "backwardation", "VIX"],
    description: "VIX 3M over VIX on each date both closed; above 1 is contango.",
    load: async ({ start }) => {
      const [spot, threeMonth] = await Promise.all([loadFredPoints("VIXCLS", start), loadFredPoints("VXVCLS", start)]);
      const spotByDate = new Map(spot.points.map((point) => [point.date, point.value]));
      const warning = cachedSeriesWarning(spot) ?? cachedSeriesWarning(threeMonth);
      return {
        points: threeMonth.points.flatMap((point) => {
          const base = spotByDate.get(point.date);
          return base != null && base > 0 && point.value != null ? [{ date: point.date, value: point.value / base }] : [];
        }),
        ...(warning ? { warning } : {}),
      };
    },
  },
];
