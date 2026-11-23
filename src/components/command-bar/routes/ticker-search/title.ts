import { commands } from "../../commands/registry";

/** The title of DES's own ticker search, and of the plain one the backtick opens. */
export const SECURITY_DESCRIPTION_TITLE = "Security Description";

/**
 * What a ticker search is titled: the function its rows open. A search a
 * function opened to ask for its ticker (SEAS, AW) is that function's
 * (Seasonality, Add to Watchlist), so a ticker typed for Seasonality never
 * reads as one opened in DES. DES's own search and the plain one are
 * Security Description.
 */
export function tickerSearchTitle(
  payload: Readonly<Record<string, unknown>> | undefined,
  paneTemplateLabel: (templateId: string) => string | null,
): string {
  const action = String(payload?.action ?? "");
  if (action === "pane-template") return paneTemplateLabel(String(payload?.templateId ?? "")) ?? SECURITY_DESCRIPTION_TITLE;
  if (action === "collection-command") {
    return commands.find((command) => command.id === payload?.commandId)?.label ?? SECURITY_DESCRIPTION_TITLE;
  }
  return SECURITY_DESCRIPTION_TITLE;
}
