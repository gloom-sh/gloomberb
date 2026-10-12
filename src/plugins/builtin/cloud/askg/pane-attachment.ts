import type { AskGloomPaneAttachment } from "../../../../ask-gloom/pane-request";
import type { ASKGSessionContext, JsonValue } from "./protocol";

/** The question a pane opens its conversation with: in the field, to edit or send. */
export const ASKG_PANE_QUESTION = "What does this pane show?";

/**
 * The platform keeps the first 2,000 characters of the terminal context's
 * `layout`, so the pane's description stays under that whole.
 */
const MAX_LAYOUT_CHARS = 1_900;
/** The route's bounds on the other context fields; a longer one fails the whole turn. */
const MAX_PANE_ID_LENGTH = 64;
const MAX_SYMBOL_LENGTH = 32;
const MAX_QUERY_LENGTH = 120;

/**
 * Whether what the pane shows goes with the question: a pane with nothing of
 * the user's in it goes as is; one that shows personal data (holdings,
 * account details or messages) waits for a yes, and a no keeps its contents on the device.
 */
type ASKGPaneConsent = "not-needed" | "pending" | "granted" | "declined";

/** A pane attached to the conversation on screen. */
export interface ASKGAttachedPane {
  pane: AskGloomPaneAttachment;
  consent: ASKGPaneConsent;
}

export function attachPane(pane: AskGloomPaneAttachment): ASKGAttachedPane {
  return { pane, consent: pane.personal ? "pending" : "not-needed" };
}

/** Its contents go with the question. */
function sharesPaneContents(attached: ASKGAttachedPane): boolean {
  return attached.consent === "not-needed" || attached.consent === "granted";
}

/** What the chip says: the function and what it shows, such as `DES AAPL`. */
export function attachedPaneLabel(pane: AskGloomPaneAttachment): string {
  const title = pane.title.trim() || pane.paneType;
  if (!pane.code) return title;
  return title.split(/\s+/)[0]?.toUpperCase() === pane.code ? title : `${pane.code} ${title}`;
}

/** Drops whole lines from the end, then characters, until `fits` holds. */
function trimToFit(text: string, fits: (candidate: string) => boolean): string | null {
  if (fits(text)) return text;
  const lines = text.split("\n");
  while (lines.length > 1) {
    lines.pop();
    const candidate = `${lines.join("\n")}\n…`;
    if (fits(candidate)) return candidate;
  }
  let line = lines[0] ?? "";
  while (line.length > 0) {
    line = line.slice(0, Math.max(0, line.length - Math.max(1, Math.ceil(line.length / 10))));
    if (fits(`${line}…`)) return line ? `${line}…` : null;
  }
  return null;
}

/**
 * The attached pane in the terminal context every turn of its conversation
 * carries, through the fields the platform already reads (the pane, its
 * symbol, its command, and `layout`, which it quotes as data rather than
 * instructions): the function and its arguments, and what it shows once that
 * may go. Within the route's bounds, so a long title or a full pane never
 * costs the question.
 */
export function attachedPaneContext(attached: ASKGAttachedPane): Pick<ASKGSessionContext, "paneId" | "symbol" | "query" | "layout"> {
  const { pane } = attached;
  const contents = sharesPaneContents(attached);
  const symbol = pane.symbol && pane.symbol.length <= MAX_SYMBOL_LENGTH ? pane.symbol : null;
  const description: Record<string, JsonValue> = {
    title: pane.title.slice(0, MAX_QUERY_LENGTH),
    ...(pane.code ? { function: pane.code } : {}),
    ...(symbol ? { symbol } : {}),
    ...(contents && Object.keys(pane.args).length > 0 ? { arguments: { ...pane.args } } : {}),
    ...(contents ? {} : { contents: "not attached: the pane shows the user's own data (holdings, account details or messages)" }),
  };
  const layout = (shows: string | null): JsonValue => ({
    attachedPane: shows ? { ...description, shows } : description,
  });
  const fits = (shows: string | null) => JSON.stringify(layout(shows)).length <= MAX_LAYOUT_CHARS;
  const shows = contents && pane.visibleText ? trimToFit(pane.visibleText, fits) : null;
  const query = [pane.code ?? pane.title, symbol].filter(Boolean).join(" ").slice(0, MAX_QUERY_LENGTH);
  return {
    paneId: pane.paneId.slice(0, MAX_PANE_ID_LENGTH),
    ...(symbol ? { symbol } : {}),
    ...(query ? { query } : {}),
    layout: fits(shows) ? layout(shows) : { attachedPane: { title: pane.title.slice(0, 60) } },
  };
}
