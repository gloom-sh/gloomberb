import { useCallback, useRef } from "react";
import { TextPromptDialog, usePaneFooter } from "../../../../components";
import { tf } from "../../../../i18n";
import {
  CASH_SYMBOL,
  describeTargetSum,
  formatAllocationWeight,
  holdingTarget,
  parseTargetWeight,
} from "../../../../portfolio/allocation";
import { clearPortfolioTargetWeights, setPortfolioTargetWeight } from "../../../../portfolio/mutations";
import { syncConfigActiveLayoutState, useAppDispatch, useAppStateRef } from "../../../../state/app/context";
import { scheduleConfigSave } from "../../../../state/config-save-scheduler";
import type { AppConfig } from "../../../../types/config";
import type { Portfolio } from "../../../../types/ticker";
import { useDialog } from "../../../../ui/dialog";
import { usePluginAppActions } from "../../../runtime";

/** `t` sets the cursor row's target weight, Shift+T clears it: the pane menu shows both beside them. */
export const SET_TARGET_KEY = "t";
export const CLEAR_TARGET_KEY = "T";

/** The row a target goes on: a holding by its key, or the cash line. */
export interface TargetRow {
  /** The key the target is saved under: the ticker's, or CASH. */
  symbol: string;
  /** How the row reads in a message: AAPL, or Cash. */
  label: string;
  /** Its weight now, in percent, when known. */
  weight: number | null;
}

/** "AAPL in Family Office: weight 10.6%, target 8.0%." The dialog's first line. */
function describeRow(row: TargetRow, portfolio: Portfolio): string {
  const target = row.symbol === CASH_SYMBOL ? portfolio.targetWeights?.[CASH_SYMBOL] : holdingTarget(portfolio.targetWeights, row.symbol);
  const parts = [
    row.weight != null ? `weight ${formatAllocationWeight(row.weight)}` : null,
    target != null ? `target ${formatAllocationWeight(target)}` : "no target",
  ].filter(Boolean);
  return `${row.label} in ${portfolio.name}: ${parts.join(", ")}.`;
}

/** The note under a change when the targets of the listed rows and cash do not add up to the whole. */
function targetSumNote(config: AppConfig, portfolioId: string, listed: ReadonlySet<string>): string | null {
  const portfolio = config.portfolios.find((entry) => entry.id === portfolioId);
  let sum: number | null = null;
  for (const [symbol, weight] of Object.entries(portfolio?.targetWeights ?? {})) {
    if (symbol === CASH_SYMBOL || listed.has(symbol)) sum = (sum ?? 0) + weight;
  }
  return describeTargetSum(sum);
}

/**
 * Setting and clearing the cursor row's target weight from PF, cash
 * included: `t` asks for the weight and Shift+T clears it, both in the pane
 * menu too. The same mutations `portfolio target set` and `target clear` save.
 * Nothing is offered without a portfolio or a row.
 */
export function useTargetWeightActions({
  portfolio,
  row,
  listedSymbols,
  enabled,
}: {
  portfolio: Portfolio | null;
  row: TargetRow | null;
  /** The book's rows by key, which the targets' sum counts. */
  listedSymbols: ReadonlySet<string>;
  enabled: boolean;
}) {
  const dialog = useDialog();
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const { notify } = usePluginAppActions();
  const busyRef = useRef(false);
  const latest = useRef({ portfolio, row, listedSymbols });
  latest.current = { portfolio, row, listedSymbols };

  const save = useCallback((config: AppConfig) => {
    const state = stateRef.current;
    dispatch({ type: "SET_CONFIG", config });
    scheduleConfigSave(syncConfigActiveLayoutState(config, state.paneState, state.focusedPaneId));
  }, [dispatch, stateRef]);

  const setTarget = useCallback(async () => {
    const { portfolio: book, row: target, listedSymbols: listed } = latest.current;
    if (!book || !target || busyRef.current) return;
    busyRef.current = true;
    try {
      const current = target.symbol === CASH_SYMBOL ? book.targetWeights?.[CASH_SYMBOL] : holdingTarget(book.targetWeights, target.symbol);
      const typed = await dialog.prompt<string>({
        content: (context) => (
          <TextPromptDialog
            {...context}
            title="Set Target Weight"
            body={[describeRow(target, book)]}
            label="Target"
            initialValue={current != null ? formatAllocationWeight(current).replace(/%$/, "") : ""}
            placeholder="12.5%"
            confirmLabel="Set"
          />
        ),
      });
      if (typed == null || !typed.trim()) return;
      let weight: number;
      try {
        weight = parseTargetWeight(typed);
      } catch (error) {
        notify({ type: "error", body: error instanceof Error ? error.message : String(error) });
        return;
      }
      // The config as it is now, in case a sync changed it while the dialog was open.
      const next = setPortfolioTargetWeight(stateRef.current.config, book.id, target.symbol, weight);
      save(next);
      const note = targetSumNote(next, book.id, listed);
      const values = { row: target.label, portfolio: book.name, weight: formatAllocationWeight(weight) };
      notify({
        type: "success",
        body: [target.symbol === CASH_SYMBOL
          ? tf("Set the cash target in {portfolio} to {weight}.", values)
          : tf("Set the target for {row} in {portfolio} to {weight}.", values), note].filter(Boolean).join(" "),
      });
    } finally {
      busyRef.current = false;
    }
  }, [dialog, notify, save, stateRef]);

  const clearTarget = useCallback(() => {
    const { portfolio: book, row: target, listedSymbols: listed } = latest.current;
    if (!book || !target) return;
    const { config: next, removed } = clearPortfolioTargetWeights(stateRef.current.config, book.id, target.symbol);
    const cash = target.symbol === CASH_SYMBOL;
    const values = { row: target.label, portfolio: book.name };
    if (removed.length === 0) {
      notify({ type: "info", body: cash ? tf("{portfolio} has no cash target.", values) : tf("{portfolio} has no target for {row}.", values) });
      return;
    }
    save(next);
    const note = targetSumNote(next, book.id, listed);
    notify({
      type: "success",
      body: [cash ? tf("Cleared the cash target in {portfolio}.", values) : tf("Cleared the target for {row} in {portfolio}.", values), note]
        .filter(Boolean).join(" "),
    });
  }, [notify, save, stateRef]);

  const offered = enabled && !!portfolio && !!row;
  usePaneFooter("portfolio-list-targets", () => offered ? {
    menu: [
      { id: "set-target", label: "Set Target Weight…", accelerator: SET_TARGET_KEY, onSelect: () => { void setTarget(); } },
      { id: "clear-target", label: "Clear Target", accelerator: `Shift+${CLEAR_TARGET_KEY}`, onSelect: clearTarget },
    ],
    keys: [
      { id: "set-target", key: SET_TARGET_KEY, label: "", title: "Set Target Weight", onPress: () => { void setTarget(); } },
      { id: "clear-target", key: CLEAR_TARGET_KEY, label: "", title: "Clear Target", onPress: clearTarget },
    ],
  } : null, [clearTarget, offered, setTarget]);
}
