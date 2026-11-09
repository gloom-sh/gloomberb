import { futuresContractByCode } from "../market-data/futures-board";
import { continuousFuturesRoot } from "../utils/futures-generic";
import { isFiniteNumber } from "../utils/guards";
import { FORMULA_NEXT_MONTH_OF, FORMULA_ROLLS_WITH } from "./studies/formula";
import type { ChartResolutionResult, ChartSeriesSpec, ChartSpec } from "./types";

/** The id of a formula leg's next listed month, which no saved chart holds: it is added to a chart as it resolves. */
const NEXT_MONTH_ID = ":next-month:";

/**
 * A chart whose formulas price their legs in one delivery month (`rollsWith`,
 * the 3-2-1 crack), with each continuous leg besides the one it rolls with
 * read in its next listed month too: RB2 beside RB=F. Between crude's roll and
 * the products' (CLZ26 beside RBX26), the products' next month is the month
 * crude holds. Hidden inputs of the formula alone, never saved or drawn. A
 * root that does not list every month has no next month to take; its leg
 * stays as served.
 */
export function withFormulaNextMonths(spec: ChartSpec): ChartSpec {
  const added: ChartSeriesSpec[] = [];
  const studies = spec.studies.map((study) => {
    const rollsWith = study.parameters[FORMULA_ROLLS_WITH];
    if (study.kind !== "formula" || study.visible === false || !isFiniteNumber(rollsWith)) return study;
    const inputSeriesIds = [...study.inputSeriesIds];
    const parameters = { ...study.parameters };
    const before = added.length;
    study.inputSeriesIds.forEach((id, index) => {
      if (index === rollsWith - 1 || !isFiniteNumber(study.parameters[`weight${index + 1}`])) return;
      const series = spec.series.find((entry) => entry.id === id);
      if (series?.source.kind !== "security" || series.source.instrument.instrument || series.source.instrument.brokerId) return;
      const root = continuousFuturesRoot(series.source.instrument.symbol);
      if (!root || !futuresContractByCode(root)?.everyMonth) return;
      const nextId = `${study.id}${NEXT_MONTH_ID}${index + 1}`;
      added.push({
        ...series, id: nextId, label: `${root}2`, visible: false,
        source: { ...series.source, instrument: { symbol: `${root}2`, exchange: "" } },
      });
      inputSeriesIds.push(nextId);
      parameters[`${FORMULA_NEXT_MONTH_OF}${inputSeriesIds.length}`] = index + 1;
    });
    return added.length > before ? { ...study, inputSeriesIds, parameters } : study;
  });
  return added.length ? { ...spec, series: [...spec.series, ...added], studies } : spec;
}

/** A series `withFormulaNextMonths` added: a formula's hidden input, which no message, coverage or integrity notice names. */
export function isFormulaNextMonth(seriesId: string): boolean {
  return seriesId.includes(NEXT_MONTH_ID);
}

/** A resolved chart without the next months `withFormulaNextMonths` added: they are a formula's inputs, not the chart's series. */
export function withoutFormulaNextMonths(result: ChartResolutionResult): ChartResolutionResult {
  if (!result.legendSeries?.some((entry) => isFormulaNextMonth(entry.id))) return result;
  return { ...result, legendSeries: result.legendSeries.filter((entry) => !isFormulaNextMonth(entry.id)) };
}
