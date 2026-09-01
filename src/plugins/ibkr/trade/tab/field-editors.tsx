import { useCallback } from "react";
import { PriceSelectorDialog } from "../../../../components";
import type { DialogApi, PromptContext } from "../../../../ui/dialog";
import type { TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { InputDialog } from "../../dialogs";
import { setTradeTicketMessage } from "../../trading/state";

export type NumericEditor = (
  label: string,
  currentValue: number | undefined,
  onCommit: (value: number | undefined) => void,
) => Promise<void>;

function parseEditorNumber(
  response: string | undefined,
  label: string,
  onCommit: (value: number | undefined) => void,
  symbol: string | null,
  ticker: TickerRecord | null,
): void {
  if (response === undefined) return;
  if (!response.trim()) {
    onCommit(undefined);
    return;
  }
  const numeric = Number(response);
  if (!Number.isFinite(numeric)) {
    if (symbol && ticker) setTradeTicketMessage(symbol, undefined, `${label} must be numeric.`, ticker);
    return;
  }
  onCommit(numeric);
}

export function useTradeFieldEditors({
  dialog,
  financials,
  symbol,
  ticker,
}: {
  dialog: DialogApi;
  financials: TickerFinancials | null;
  symbol: string | null;
  ticker: TickerRecord | null;
}) {
  const editNumericField = useCallback<NumericEditor>(async (label, currentValue, onCommit) => {
    const response = await dialog.prompt<string>({
      content: (ctx: PromptContext<string>) => (
        <InputDialog
          {...ctx}
          step={{
            key: label,
            type: "number",
            label,
            placeholder: currentValue != null ? String(currentValue) : "",
          }}
        />
      ),
    });
    parseEditorNumber(response, label, onCommit, symbol, ticker);
  }, [dialog, symbol, ticker]);

  const editPriceField = useCallback<NumericEditor>(async (label, currentValue, onCommit) => {
    const response = await dialog.prompt<string>({
      content: (ctx: PromptContext<string>) => (
        <PriceSelectorDialog
          {...ctx}
          label={label}
          currentValue={currentValue}
          quote={financials?.quote}
          assetCategory={ticker?.metadata.assetCategory}
        />
      ),
    });
    parseEditorNumber(response, label, onCommit, symbol, ticker);
  }, [dialog, financials, symbol, ticker]);

  return { editNumericField, editPriceField };
}
