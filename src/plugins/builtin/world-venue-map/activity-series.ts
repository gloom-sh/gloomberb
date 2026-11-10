/**
 * US activity in the catalog, beside the chokepoint transits: travellers
 * through TSA's airport checkpoints and electricity demand from EIA-930, each
 * a day at a time with its 7-day average and its change on the same weekday a
 * year earlier. Gloom Cloud reads both from their publishers and serves them
 * through the map's series index (`GEO:TSA`, `GEO:US48.LOAD`), each with who
 * published it and when.
 */
import type { ExpressionSeriesDefinition, SeriesDefinition } from "../../../series/types";
import { formatGeoSeriesExpression } from "../chart-composer/series-expression";

const TSA_PAGE = "https://www.tsa.gov/travel/passenger-volumes";
const EIA_GRID_MONITOR = "https://www.eia.gov/electricity/gridmonitor/";

const TSA_TAGS = ["TSA", "air travel", "footfall", "airport", "passengers", "travelers", "checkpoint", "consumer activity"];
const GRID_TAGS = ["power load", "electricity demand", "grid load", "load", "EIA-930", "power", "electricity"];

type Described = Pick<ExpressionSeriesDefinition, "name" | "unit" | "description" | "group" | "publisher" | "url" | "tags">;

function entry(alias: string, definition: Described): ExpressionSeriesDefinition {
  return { id: `geo:${alias.toLowerCase()}`, frequency: "daily", ...definition, expression: formatGeoSeriesExpression(alias) };
}

/** An observed series, its 7-day average and its change on the same weekday 52 weeks earlier. */
function withDerived(
  alias: string,
  name: string,
  unit: string,
  base: Pick<Described, "group" | "publisher" | "url" | "tags">,
  description: string,
  derived: { average: boolean },
): ExpressionSeriesDefinition[] {
  return [
    entry(alias, { ...base, name, unit, description }),
    ...(derived.average
      ? [entry(`${alias}.7D`, { ...base, name: `${name}, 7-day average`, unit, description: `${description} Averaged over the seven days to each day.` })]
      : []),
    entry(`${alias}.YOY`, {
      ...base,
      name: `${name} vs a year ago`,
      unit: "%",
      description: `${description} As a change on the same weekday 52 weeks earlier.`,
    }),
  ];
}

const TSA_SERIES = withDerived(
  "TSA",
  "US airport checkpoint travelers",
  "people",
  { group: "Alternative data", publisher: "TSA", url: TSA_PAGE, tags: TSA_TAGS },
  "Travelers screened at TSA airport checkpoints each day, a read on US air travel and footfall.",
  { average: true },
);

/** The Lower 48 and the balancing authorities that run the largest US power markets, by the alias the server gives them. */
const GRID_AREAS: ReadonlyArray<{ alias: string; label: string; area: string }> = [
  { alias: "US48", label: "US Lower 48", area: "the Lower 48 states" },
  { alias: "ERCOT", label: "ERCOT", area: "ERCOT (most of Texas)" },
  { alias: "PJM", label: "PJM", area: "PJM (the Mid-Atlantic and parts of the Midwest)" },
  { alias: "MISO", label: "MISO", area: "MISO (the central US)" },
  { alias: "CAISO", label: "CAISO", area: "CAISO (most of California)" },
  { alias: "NYISO", label: "NYISO", area: "NYISO (New York)" },
  { alias: "ISONE", label: "ISO-NE", area: "ISO-NE (New England)" },
  { alias: "SPP", label: "SPP", area: "SPP (the central Plains)" },
];

const GRID_SERIES = GRID_AREAS.flatMap(({ alias, label, area }) => withDerived(
  `${alias}.LOAD`,
  `${label} electricity demand`,
  "GWh/day",
  { group: "Energy", publisher: "EIA", url: EIA_GRID_MONITOR, tags: [...GRID_TAGS, label] },
  `Electricity demand in ${area} each Eastern-time day, from EIA-930 hourly demand, not adjusted for weather.`,
  // The Lower 48's average is the headline; a balancing authority's stays a `GEO:` expression away.
  { average: alias === "US48" },
));

/**
 * The catalog's activity series. The server's series index has the rest
 * (`GEO:PJM.LOAD.7D`), charted the same way.
 */
export const ACTIVITY_SERIES: readonly SeriesDefinition[] = [...TSA_SERIES, ...GRID_SERIES];
