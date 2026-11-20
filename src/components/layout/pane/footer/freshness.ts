import { formatDetailDate } from "../../../../utils/datetime-format";
import type { PaneFooterSegment } from "./model";

export function observationFooterSegment(at: number | string | null | undefined): PaneFooterSegment | null {
  return timestampFooterSegment("as-of", "as of", at);
}

export function timestampFooterSegment(id: string, label: string, at: number | string | null | undefined): PaneFooterSegment | null {
  if (at == null) return null;
  const date = formatDetailDate(at, "");
  return date ? { id, parts: [{ text: `${label} ${date}`, tone: "muted" }] } : null;
}
