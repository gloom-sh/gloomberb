import { apiClient } from "../../../api-client";
import type { SeriesDefinition } from "../../../series/types";
import { loadCdsSpreadHistory, resolveIssuerName } from "./client";

/** A company's on-the-run 5Y CDS spread, by its ticker, as the CDS pane charts it. */
export const SINGLE_NAME_CDS_SERIES: readonly SeriesDefinition[] = [{
  id: "cds:single-name-5y",
  name: "5Y CDS spread",
  unit: "bp",
  frequency: "daily",
  group: "Credit",
  tags: ["CDS", "single name", "credit default swap", "spread"],
  input: "ticker",
  load: async ({ ticker }) => {
    const issuer = await resolveIssuerName(ticker!, (query, limit) => apiClient.searchInstruments(query, limit));
    const history = await loadCdsSpreadHistory(issuer);
    return history.points.map((point) => ({ date: point.date, value: point.spreadBp }));
  },
}];
