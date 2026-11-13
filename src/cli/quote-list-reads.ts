import type { QuoteBatchResult, QuoteSubscriptionTarget } from "../types/data-provider";
import { isRateLimited, isTransientServiceFailure } from "../sources/provider-errors";

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
 * answer or was busy. A source's own reason (Not a ticker, a delisting) is an
 * answer and is kept, and so is the request limit: asked again is more of
 * what it refused, so its row says when to try.
 */
function isTransientQuoteFailure({ error, transient }: Pick<QuoteBatchResult, "error" | "transient">): boolean {
  return error != null && !isRateLimited(error) && (transient === true || isTransientServiceFailure(error));
}

/**
 * A list is asked for this many symbols at a time, a few asks in flight, so it
 * says how far it has got as each ask comes back: the service takes up to a
 * hundred from a signed-out caller.
 */
const QUOTE_LIST_CHUNK = 100;
const QUOTE_LIST_CHUNKS_IN_FLIGHT = 3;

/**
 * A list's quotes, its rows that failed for a reason that says nothing of the
 * symbol (`isTransientQuoteFailure`) asked for again after each wait, so a
 * busy moment never marks a listing that trades as having no quote. A row
 * still failing after the last wait keeps the latest reason it was given.
 * Rows come back in the order of `targets`, each the target it was asked as.
 * `onSettled` is told of each row once it is final, as the ask it came in
 * returns: answered, refused for its own reason, or failing after the last
 * wait.
 */
export async function quotesWithRetries(
  targets: QuoteSubscriptionTarget[],
  ask: (targets: QuoteSubscriptionTarget[]) => Promise<QuoteBatchResult[]>,
  {
    waitsMs = QUOTE_RETRY_WAITS_MS,
    chunkSize = QUOTE_LIST_CHUNK,
    onRetry,
    onSettled,
  }: {
    waitsMs?: readonly number[];
    chunkSize?: number;
    /** Told before each new ask, with how many rows and how long it waits first. */
    onRetry?: (count: number, waitMs: number) => void;
    /** Told of an ask's rows that are final, each with its place in `targets`. */
    onSettled?: (settled: Array<{ result: QuoteBatchResult; index: number }>) => void;
  } = {},
): Promise<QuoteBatchResult[]> {
  const results: QuoteBatchResult[] = [];
  const transient = (result: QuoteBatchResult) => !result.quote && isTransientQuoteFailure(result);
  const askInChunks = async (asked: number[], last: boolean): Promise<void> => {
    const chunks: number[][] = [];
    for (let at = 0; at < asked.length; at += chunkSize) chunks.push(asked.slice(at, at + chunkSize));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(QUOTE_LIST_CHUNKS_IN_FLIGHT, chunks.length) }, async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++]!;
        const answered = await ask(chunk.map((index) => targets[index]!));
        const rows = chunk.flatMap((index, at) => answered[at] ? [{ result: answered[at]!, index }] : []);
        for (const { result, index } of rows) results[index] = result;
        onSettled?.(last ? rows : rows.filter(({ result }) => !transient(result)));
      }
    }));
  };
  await askInChunks(targets.map((_target, index) => index), waitsMs.length === 0);
  for (const [attempt, waitMs] of waitsMs.entries()) {
    const failed = targets.flatMap((_target, index) => results[index] && transient(results[index]!) ? [index] : []);
    if (failed.length === 0) break;
    onRetry?.(failed.length, waitMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    await askInChunks(failed, attempt === waitsMs.length - 1);
  }
  return results.filter(Boolean);
}
