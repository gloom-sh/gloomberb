import { isMarketFieldId, listTimeSeriesFields } from "../../../time-series/field-catalog";
import type { SeriesPeriod, TimeSeriesFieldDefinition } from "../../../time-series/types";
import type { SeriesDefinition, SeriesFrequency } from "../../../series/types";
import { fieldCategory } from "./series-catalog";

/** The short name an expression uses for a field: `price` for OHLCV, else the id's last part. */
function chartFieldToken(fieldId: string): string {
  if (fieldId === "market.ohlcv") return "price";
  return fieldId.split(".").at(-1) ?? fieldId;
}

function fieldFrequency(period: SeriesPeriod): SeriesFrequency {
  if (period === "auto") return "daily";
  return period === "ttm" ? "quarterly" : period;
}

function fieldSeries(field: TimeSeriesFieldDefinition, input: "ticker" | "option"): SeriesDefinition {
  return {
    id: `${input === "option" ? "option" : "field"}:${field.id}`,
    name: field.label,
    unit: field.unit,
    frequency: fieldFrequency(field.nativeFrequency),
    group: input === "option" ? "Options" : "Securities",
    tags: [fieldCategory(field), field.shortLabel, ...(input === "option" ? ["option"] : [])],
    input,
    expression: `{ticker}:${chartFieldToken(field.id)}`,
  };
}

/**
 * Every ticker field once, asking for the ticker when charted, and the market
 * fields again for option contracts. Typing a ticker in the catalog fills them in.
 */
export function listFieldSeries(): SeriesDefinition[] {
  const fields = listTimeSeriesFields();
  return [
    ...fields.map((field) => fieldSeries(field, "ticker")),
    ...fields.filter((field) => isMarketFieldId(field.id)).map((field) => fieldSeries(field, "option")),
  ];
}
