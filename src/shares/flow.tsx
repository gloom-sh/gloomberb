import { ConfirmDialog } from "../components/ui/confirm-dialog";
import type { PluginRegistry } from "../plugins/registry";
import type { PanePersonalData } from "../types/plugin";
import { createShare, openLiveShareUrl } from "./api";
import { claimCaptureFlow } from "./capture-flow";
import { personalDataNotice } from "./pane-image";
import type { SharePayload } from "./payload";
import { readyToShare } from "./ready";

/** What Share reads from a pane: the view its public link opens, and whether it shows the person's own data. */
export interface PaneShareView {
  /** The pane as its link opens it, with the fields it keeps private left out; null when it has no public view. */
  sharePayload: Extract<SharePayload, { kind: "pane" }> | null;
  /** What personal data the pane shows now; null for market data. */
  personalData: PanePersonalData | null;
}

export interface PaneShareHost extends Pick<PluginRegistry, "notify" | "promptDialog"> {
  /** Flushes what the pane is in the middle of into its settings, then reads its view. */
  readShareView(paneId: string): Promise<PaneShareView>;
  copyText(text: string): Promise<void>;
}

/**
 * Asked before a pane that shows the person's own data gets a public link.
 * Enter cancels: only `y` or a press on Copy link makes the link, so the
 * Enter that chose Share in a menu, held or pressed again, cannot.
 */
async function confirmPersonalLink(host: PaneShareHost, kind: PanePersonalData): Promise<boolean> {
  const answer = await host.promptDialog<boolean>({
    closeOnClickOutside: true,
    content: (context) => (
      <ConfirmDialog
        {...context}
        title="Copy a public link?"
        body={[personalDataNotice(kind), "Anyone with the link can open this pane with its settings."]}
        confirmLabel="Copy link"
        defaultAction="cancel"
      />
    ),
  }).catch(() => undefined);
  return answer === true;
}

/**
 * Share: copies the pane's public link and says so in a toast, with no dialog
 * in between. A pane that shows the person's own data asks once first. No
 * link is made when the pane has no public view, the account cannot share
 * yet, or the question is declined; each says why in a toast.
 */
export async function sharePaneLink(host: PaneShareHost, paneId: string): Promise<void> {
  // One at a time, Report a Bug's included.
  const release = claimCaptureFlow();
  if (!release) return;
  try {
    if (!readyToShare(host.notify, () => { void sharePaneLink(host, paneId); }, "share")) return;
    const view = await host.readShareView(paneId);
    if (!view.sharePayload) throw new Error("A public link is unavailable for this pane.");
    if (view.personalData && !await confirmPersonalLink(host, view.personalData)) return;
    const { id } = await createShare(view.sharePayload);
    await host.copyText(openLiveShareUrl(id));
    host.notify({ body: "Link copied", type: "success" });
  } catch (error) {
    host.notify({ body: error instanceof Error && error.message ? error.message : "Could not share this pane.", type: "error" });
  } finally {
    release();
  }
}
