import type { PowerFilter } from "../../../api-client/power";
import { powerTab } from "./model";

export const POWER_SORT_COLUMNS = ["capacityMw", "name", "region", "status", "proposedDate", "generationMwh", "salesMwh", "revenueUsd", "summerPeakDemandMw", "winterPeakDemandMw"];

/** A shared scope keeps panes, exports and captured evidence on the same data. */
export function powerQuery(options: Record<string, unknown>, symbol?: string | null): PowerFilter {
  const tab = powerTab(options.tab);
  const benchmark = options.historical === true && ["queue", "history", "outcomes"].includes(tab);
  const sourceId = options.sourceId && (!String(options.sourceId).startsWith("us-lbnl") || benchmark) ? String(options.sourceId) : null;
  const loads = tab === "loads" || tab === "utilities";
  return {
    ...Object.fromEntries(["country", "region", "search", "from", "to"].flatMap((key) => typeof options[key] === "string" && options[key] ? [[key, options[key]]] : [])),
    ...(tab === "capacity" && !sourceId ? { sourceId: options.context === "generation" ? "us-eia923" : options.context === "utility" ? "us-eia861" : "us-eia860" } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(symbol ? { symbol } : {}),
    ...(loads && options.loadClass ? { loadClass: String(options.loadClass) } : {}),
    ...(!loads && tab !== "coverage" && options.fuel ? { fuel: String(options.fuel) } : {}),
    ...(tab !== "coverage" && options.status ? { status: String(options.status) } : {}),
    historical: benchmark,
    ...(tab === "coverage" ? {} : { kind: loads ? "load" : tab === "capacity" ? options.context === "utility" ? "utility" : "capacity" : "queue" }),
    sort: POWER_SORT_COLUMNS.includes(String(options.sort)) ? options.sort as PowerFilter["sort"] : tab === "capacity" && options.context === "generation" ? "generationMwh" : tab === "capacity" && options.context === "utility" ? "salesMwh" : "capacityMw",
    direction: options.direction === "asc" ? "asc" : "desc",
  };
}
