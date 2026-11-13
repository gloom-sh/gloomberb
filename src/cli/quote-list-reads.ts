import type { QuoteBatchResult, QuoteSubscriptionTarget } from "../types/data-provider";
import { isProviderBusy, rateLimitedMessage, serviceDidNotAnswerMessage } from "../sources/provider-errors";
import { isNetworkFailure } from "../utils/network-failure";

/**
 * Waits before each new ask for a list's rows that failed for a reason that
 * says nothing of the symbol. Two: a busy moment passes within them, and a
 * list still refused after them is done within ten seconds, each row saying why.
 */
const QUOTE_RETRY_WAITS_MS: readonly number[] = [2_000, 6_000];

/** Lists longer than this say how far they have got while they are slow. */
export const QUOTE_PROGRESS_MIN_SYMBOLS = 50;

/**
 * Whether a row's failure says nothing of its symbol, so asked again in a
 * moment it may be quoted: a source failed rather than answered (`transient`,
 * which the router sets for a timeout or a refusal behind its bare "No quote
 * provider available"), or the data service could not be reached, did not
 * answer, was busy or at its request limit. A source's own reason (Not a
 * ticker, a delisting) is an answer and is kept.
 */
function isTransientQuoteFailure({ error, transient }: Pick<QuoteBatchResult, "error" | "transient">): boolean {
  if (error == null) return false;
  if (transient || isNetworkFailure(error) || isProviderBusy(error)) return true;
  const message = (error instanceof Error ? error.message : String(error)).trim();
  return message.startsWith(serviceDidNotAnswerMessage().split(".")[0]!) || message.startsWith(rateLimitedMessage().split(".")[0]!);
}

/**
 * A list's quotes, its rows that failed for a reason that says nothing of the
 * symbol (`isTransientQuoteFailure`) asked for again after each wait, so a
 * busy moment never marks a listing that trades as having no quote. A row
 * still failing after the last wait keeps the latest reason it was given.
 * Rows come back in the order of `targets`, each the target it was asked as.
 */
export async function quotesWithRetries(
  targets: QuoteSubscriptionTarget[],
  ask: (targets: QuoteSubscriptionTarget[]) => Promise<QuoteBatchResult[]>,
  {
    waitsMs = QUOTE_RETRY_WAITS_MS,
    onRetry,
  }: {
    waitsMs?: readonly number[];
    /** Told before each new ask, with how many rows and how long it waits first. */
    onRetry?: (count: number, waitMs: number) => void;
  } = {},
): Promise<QuoteBatchResult[]> {
  let results = await ask(targets);
  for (const waitMs of waitsMs) {
    const failed = results.flatMap((result, index) => !result.quote && isTransientQuoteFailure(result) ? [index] : []);
    if (failed.length === 0) break;
    onRetry?.(failed.length, waitMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const again = await ask(failed.map((index) => targets[index]!));
    const answered = new Map(again.map((result) => [result.target, result] as const));
    results = results.map((result, index) => answered.get(targets[index]!) ?? result);
  }
  return results;
}
