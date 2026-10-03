import type { TickerFinancials } from "../../types/financials";
import type { DesktopPaneShotPayload, DesktopPaneShotRenderResult } from "../desktop-pane-shot";
import type { ResolvedPaneFunction } from "./resolver";
import { createValuationCurrencyContext } from "../../time-series/valuation-currency";
import {
  resolveFinancialPeriod,
  resolveFinancialPeriodOption,
  type FinancialPeriod,
} from "../../plugins/builtin/ticker-detail/financials/model";
import { PERIOD_END_HISTORY_RESOLUTION } from "../../plugins/builtin/ticker-detail/financials/period-end-history";
import {
  findRatioTab,
  formatRatioInput,
  formatRatioValue,
  ratioPeriodEnd,
  ratioTableForFinancials,
  resolveFinancialSectionKey,
  type RatioTabDef,
  type RatioTableModel,
} from "../../plugins/builtin/ticker-detail/financials/ratios";

export interface PaneScreenshotFinancialRatioEvidence {
  kind: "financial-ratios";
  symbol: string;
  statement: string;
  period: FinancialPeriod;
  /** The newest column with a ratio, and the close it was priced at. */
  latest: {
    date: string;
    periodEnd: string;
    price: number | null;
    ratios: Array<{ id: string; label: string; value: number }>;
  };
}

/** The ratio tab an FA shot opens, or null for a statement tab. */
export function shotRatioTab(resolved: ResolvedPaneFunction): RatioTabDef | null {
  if (resolved.capability.id !== "financial-statements") return null;
  return findRatioTab(resolveFinancialSectionKey(String(resolved.options.statement ?? ""))) ?? null;
}

/** The period FA shows: the requested one, or the other when it has no statements. */
export function shotFinancialPeriod(resolved: ResolvedPaneFunction, financials: TickerFinancials): FinancialPeriod {
  const hasAnnual = financials.annualStatements.length > 0;
  const hasQuarterly = financials.quarterlyStatements.length > 0;
  const requested = typeof resolved.options.period === "string" ? resolveFinancialPeriodOption(resolved.options.period) : undefined;
  return resolveFinancialPeriod(requested ?? (hasAnnual ? "annual" : "quarterly"), hasAnnual, hasQuarterly);
}

interface RatioShot {
  symbol: string;
  financials: TickerFinancials;
  tab: RatioTabDef;
  period: FinancialPeriod;
  model: RatioTableModel;
}

/** The table the page computes from the captured data, with every ratio expanded. */
function ratioShot(resolved: ResolvedPaneFunction, payload: DesktopPaneShotPayload): RatioShot | null {
  const tab = shotRatioTab(resolved);
  const [symbol, financials] = payload.financials[0] ?? [];
  if (!tab || !symbol || !financials) return null;
  const period = shotFinancialPeriod(resolved, financials);
  // The page answers Valuation's daily request only from a daily capture.
  const history = tab.key === "valuation" && financials.priceHistoryResolution === PERIOD_END_HISTORY_RESOLUTION
    ? financials.priceHistory : null;
  return { symbol, financials, tab, period, model: ratioTableForFinancials(financials, tab, period, history) };
}

const hasRatio = ({ model, tab }: RatioShot, index: number) => tab.ratios.some((def) => (
  typeof model.cells.get(def.id)?.[index]?.value === "number"
));

/** Why the captured data cannot make a usable ratio shot, or null when it can. */
export function financialRatioShotGap(resolved: ResolvedPaneFunction, payload: DesktopPaneShotPayload): string | null {
  const shot = ratioShot(resolved, payload);
  if (!shot) return null;
  if (shot.tab.key === "valuation") {
    const unpriced = shot.model.periods.flatMap(({ statement, price }) => typeof price === "number" ? [] : [statement]);
    // A close in another currency than the statements prices nothing; the pane's footer says so.
    if (unpriced.length) {
      return createValuationCurrencyContext(shot.financials).warning(unpriced)
        ?? `Valuation has no period-end close for ${unpriced.map(ratioPeriodEnd).join(", ")}, so those columns read "no price".`;
    }
  }
  if (!shot.model.periods.some((_, index) => hasRatio(shot, index))) {
    return `Every ${shot.tab.name} ratio is unreported or not meaningful.`;
  }
  return null;
}

export function financialRatioShotEvidence(
  resolved: ResolvedPaneFunction,
  payload: DesktopPaneShotPayload,
): PaneScreenshotFinancialRatioEvidence | null {
  const shot = ratioShot(resolved, payload);
  if (!shot || financialRatioShotGap(resolved, payload)) return null;
  const index = shot.model.periods.findIndex((_, column) => hasRatio(shot, column));
  const { statement, price } = shot.model.periods[index]!;
  return {
    kind: "financial-ratios",
    symbol: shot.symbol,
    statement: shot.tab.key,
    period: shot.period,
    latest: {
      date: statement.date,
      periodEnd: ratioPeriodEnd(statement),
      price: typeof price === "number" ? price : null,
      ratios: shot.tab.ratios.flatMap((def) => {
        const value = shot.model.cells.get(def.id)![index]!.value;
        return typeof value === "number" ? [{ id: def.id, label: def.label, value }] : [];
      }),
    },
  };
}

const STATEMENT_COLUMN = /^statement:(.+):(\d+)$/;

/**
 * Rendered ratio cells that differ from the table the captured data computes.
 * A page that drew "no price" or "--" where the capture has a close, or drew
 * other periods, is not a picture of the data.
 */
export function financialRatioRenderMismatches(
  resolved: ResolvedPaneFunction,
  payload: DesktopPaneShotPayload,
  render: Pick<DesktopPaneShotRenderResult, "rows">,
): string[] {
  const shot = ratioShot(resolved, payload);
  if (!shot) return [];
  const { model, tab } = shot;
  const rows = new Map(model.rows.map((row) => [row.id, row]));
  const mismatches: string[] = [];
  let compared = 0;
  for (const rendered of render.rows) {
    const row = rendered.key ? rows.get(rendered.key) : undefined;
    if (!row) continue;
    for (const cell of rendered.cells) {
      const column = STATEMENT_COLUMN.exec(cell.columnId ?? "");
      if (!column) continue;
      const index = Number(column[2]);
      const period = model.periods[index];
      const header = cell.columnLabel.trim();
      if (period?.statement.date !== column[1]) {
        mismatches.push(`${tab.name} column ${header} is not a captured period`);
        continue;
      }
      const amounts = model.cells.get(row.def.id)![index]!;
      const expected = row.kind === "ratio"
        ? formatRatioValue(row.def.format, amounts.value)
        : formatRatioInput(row.def.inputs[row.index]!.format, amounts.inputs[row.index]!, row.divisor);
      compared += 1;
      if (cell.text.trim() !== expected.trim()) {
        mismatches.push(`${tab.name} ${row.label} ${header} reads "${cell.text.trim()}", the captured data gives "${expected.trim()}"`);
      }
    }
  }
  if (compared === 0) mismatches.push(`${tab.name} ratio cells are missing`);
  return mismatches;
}
