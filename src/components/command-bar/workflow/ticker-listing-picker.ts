import { tf } from "../../../i18n";
import { AmbiguousTickerError } from "../../../tickers/search";
import { formatTickerListInput, parseTickerListInput } from "../../../tickers/list";
import type { CommandBarWorkflowRoute } from "./types";

/** Which field a listing choice writes, and the whole field value each choice gives it. */
export interface TickerListingPicker {
  fieldId: string;
  title: string;
  options: Array<{ id: string; label: string; detail?: string }>;
}

/** Keep the form intact while the user resolves one ambiguous listing at a time. */
export function buildTickerListingPicker(
  route: CommandBarWorkflowRoute,
  error: unknown,
  readValue: (fieldId: string) => string,
): TickerListingPicker | null {
  if (!(error instanceof AmbiguousTickerError) || route.payload.kind !== "pane-template") return null;
  const fieldId = String(route.payloadMeta?.argPlaceholder ?? "");
  if ((fieldId !== "ticker" && fieldId !== "tickers") || !route.fields.some((field) => field.id === fieldId)) return null;
  let tokens: string[];
  try {
    tokens = fieldId === "tickers" ? parseTickerListInput(readValue(fieldId)) : [readValue(fieldId).trim().toUpperCase()];
  } catch {
    return null;
  }
  if (!tokens.includes(error.query) || error.listings.length < 2) return null;
  return {
    fieldId,
    title: tf("Choose listing for {symbol}", { symbol: error.query }),
    options: error.listings.map((listing) => ({
      id: formatTickerListInput(tokens.map((token) => token === error.query ? listing : token)),
      label: error.listingNames[listing] ? `${listing} · ${error.listingNames[listing]}` : listing,
      detail: error.listingNames[listing],
    })),
  };
}
