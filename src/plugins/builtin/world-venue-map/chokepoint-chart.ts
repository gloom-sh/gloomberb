import type { GeoRequest } from "../../../api-client/geo";
import { SERIES_COLORS } from "../../../theme/series-colors";
import type { PaneTemplateInstanceConfig } from "../../../types/plugin";
import { buildCustomChartPreset } from "../chart-composer/presets";
import { formatGeoSeriesExpression } from "../chart-composer/series-expression";
import { chokepointSeriesFor, chokepointSeriesIds, chokepointShortName, KEY_CHOKEPOINTS, unknownChokepointMessage } from "./geo-series";

const CHOKE_SERIES_LIMIT = 6;

/**
 * CHOKE's chart: the key straits' daily transits together, or the one the
 * argument names. Text that names no strait (a ticker) is told which do, as
 * COT and PSD tell an unknown market or crop, rather than charting nothing.
 */
export async function createChokepointInstance(request: GeoRequest, arg?: string): Promise<PaneTemplateInstanceConfig> {
  const typed = arg?.trim();
  const named = typed ? await chokepointSeriesFor(request, typed) : null;
  if (typed && !named) throw new Error(unknownChokepointMessage(typed));
  const ids = named
    ? [named]
    // Without the series index, CHOKE still asks for the key straits by name.
    : await chokepointSeriesIds(request).then((found) => (found.length ? found : KEY_CHOKEPOINTS)).catch(() => KEY_CHOKEPOINTS);
  const charted = ids.slice(0, CHOKE_SERIES_LIMIT);
  const base = buildCustomChartPreset(charted.map(formatGeoSeriesExpression).join(", "));
  // Daily transits read best over a year, each strait in its own colour. Six together
  // take short names so the legend shows each whole; one strait keeps the index's full name.
  const spec = {
    ...base,
    viewport: { ...base.viewport, range: "1Y" as const },
    series: base.series.map((series, index) => {
      const label = named ? undefined : chokepointShortName(charted[index] ?? "");
      return { ...series, color: series.color ?? SERIES_COLORS[index % SERIES_COLORS.length]!, ...(label ? { label } : {}) };
    }),
  };
  return {
    title: named ? `G ${named} transits` : "G Chokepoint transits",
    placement: "floating",
    settings: { chartSpec: spec },
  };
}
