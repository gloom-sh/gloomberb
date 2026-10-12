import { isRecord } from "../../../utils/guards";

const PORTFOLIO_PANE_ID = "portfolio-list";

/**
 * The portfolio pane's default columns before AS OF UTC took AGE's place
 * (GLO-575). Frozen here: the current default may change again, and only a
 * list still equal to this one was never chosen by the user.
 */
const PREVIOUS_DEFAULT_COLUMN_IDS: readonly string[] = [
  "ticker", "price", "change_pct", "market_cap", "pe", "forward_pe", "latency",
  "sparkline", "shares", "avg_cost", "cost_basis", "mkt_value", "day_pnl", "pnl", "pnl_pct",
];

function isPreviousDefault(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length === PREVIOUS_DEFAULT_COLUMN_IDS.length
    && value.every((columnId, index) => columnId === PREVIOUS_DEFAULT_COLUMN_IDS[index]);
}

/**
 * A layout whose portfolio panes still show the old default columns, with AS
 * OF UTC where AGE was, so they date each row by the price its value uses as
 * new panes do. A list the user changed in any way keeps every column, and a
 * list already moved over is left as it is. Returns the layout itself when
 * nothing changes.
 */
export function swapDefaultPortfolioAgeColumn<T>(layout: T): T {
  if (!isRecord(layout) || !Array.isArray(layout.instances)) return layout;
  let changed = false;
  const instances = layout.instances.map((instance: unknown) => {
    if (!isRecord(instance) || instance.paneId !== PORTFOLIO_PANE_ID || !isRecord(instance.settings)) return instance;
    const columnIds = instance.settings.columnIds;
    if (!isPreviousDefault(columnIds)) return instance;
    changed = true;
    return {
      ...instance,
      settings: { ...instance.settings, columnIds: columnIds.map((columnId) => columnId === "latency" ? "as_of" : columnId) },
    };
  });
  return changed ? { ...layout, instances } as T : layout;
}

/** The open layout and every saved tab. */
export function migratePortfolioAsOfColumn(saved: Record<string, unknown>): Record<string, unknown> {
  return {
    ...saved,
    ...("layout" in saved ? { layout: swapDefaultPortfolioAgeColumn(saved.layout) } : {}),
    ...(Array.isArray(saved.layouts)
      ? {
        layouts: saved.layouts.map((entry: unknown) => (
          isRecord(entry) && "layout" in entry ? { ...entry, layout: swapDefaultPortfolioAgeColumn(entry.layout) } : entry
        )),
      }
      : {}),
  };
}
