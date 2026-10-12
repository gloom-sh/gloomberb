import { createShare, openLiveShareUrl } from "./api";
import type { SharePayload } from "./payload";

/** One lazy link for the captured view. Retry failures, reuse successes across copy/post retries. */
export function paneShareLink(payload: Extract<SharePayload, { kind: "pane" }>): () => Promise<string> {
  let pending: Promise<string> | null = null;
  return () => {
    pending ??= createShare(payload).then(({ id }) => openLiveShareUrl(id)).catch((error) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

/** Keep the optional caption intact and put the reopenable view on its own line. */
export function paneShareMessage(caption: string, link?: string): string {
  return [caption.trim(), link].filter(Boolean).join("\n\n");
}
