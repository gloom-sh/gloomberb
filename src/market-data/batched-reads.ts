import type { BatchedReadMethod, DataProvider } from "../types/data-provider";
import { logFailure } from "../utils/log-failure";

/**
 * Whether `provider` sends reads of `method` asked together as batch requests
 * (`DataProvider.batchesReads`), so a caller may ask them all at once instead
 * of a few at a time. False for a provider that does not say, or whose
 * answer fails.
 */
export async function readsInBatches(
  provider: Pick<DataProvider, "batchesReads"> | null | undefined,
  method: BatchedReadMethod,
): Promise<boolean> {
  return Promise.resolve().then(() => provider?.batchesReads?.(method))
    .then((answer) => answer === true, logFailure("market-data.batched-reads", "Ask whether a source batches reads failed", false));
}
