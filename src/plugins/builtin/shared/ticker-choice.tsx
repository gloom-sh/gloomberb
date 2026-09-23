import { useCallback } from "react";
import { ChoiceDialog } from "../../../components/ui/choice-dialog";
import { t } from "../../../i18n";
import { useInlineTickerOpener } from "../../../state/hooks/inline-tickers";
import { useOptionalDialog, type PromptContext } from "../../../ui/dialog";

/**
 * The keyboard way to open a ticker badge: one symbol opens straight away,
 * several ask which one first. Opens the same research pane a badge click does.
 */
export function useOpenTickerChoice(): (symbols: readonly string[]) => void {
  const openTicker = useInlineTickerOpener();
  const dialog = useOptionalDialog();
  return useCallback((symbols: readonly string[]) => {
    const unique = [...new Set(symbols.filter(Boolean))];
    if (unique.length === 0) return;
    if (unique.length === 1 || !dialog) {
      openTicker(unique[0]!);
      return;
    }
    void dialog.prompt<string>({
      closeOnClickOutside: true,
      content: (ctx: PromptContext<string>) => (
        <ChoiceDialog
          {...ctx}
          title={t("Open ticker")}
          choices={unique.map((symbol) => ({ id: symbol, label: symbol }))}
        />
      ),
    }).then((symbol) => {
      if (symbol) openTicker(symbol);
    }).catch(() => {});
  }, [dialog, openTicker]);
}
