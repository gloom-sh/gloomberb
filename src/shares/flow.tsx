import type { PluginRegistry } from "../plugins/registry";
import { getPaneChatSharing } from "./chat";
import { claimCaptureFlow } from "./capture-flow";
import { CAPTURE_DIALOG_CHROME, captureDialogSize } from "./capture-preview";
import { ShareDialog, type ShareResult } from "./dialog";
import { paneShareLink, paneShareMessage } from "./live";

/** Terminal rows the form takes under the preview: destination, channel, caption, link, notice and buttons. */
const TERMINAL_FORM_ROWS = 25;

/** The same captured view for both destinations. A cancelled dialog creates no public link. */
export async function shareFocusedPane(registry: PluginRegistry, paneId?: string): Promise<void> {
  // One capture flow at a time, Report a Bug's included.
  const release = claimCaptureFlow();
  if (!release) return;
  try {
    const chat = getPaneChatSharing();
    if (chat && !chat.ready(() => { void shareFocusedPane(registry, paneId); })) return;
    const capture = await registry.capturePaneImage(paneId);
    const getLink = capture.sharePayload ? paneShareLink(capture.sharePayload) : null;
    const targets = chat ? await chat.targets() : [];
    const { width, previewRows } = captureDialogSize(registry.getTermSize(), capture, TERMINAL_FORM_ROWS);
    const result = await registry.promptDialog<ShareResult>({
      closeOnClickOutside: false,
      style: { width: width + CAPTURE_DIALOG_CHROME },
      content: (context) => <ShareDialog
        {...context}
        capture={capture}
        targets={targets}
        defaultChannelId={chat?.defaultChannel(targets) ?? "everyone"}
        chatAvailable={chat !== null}
        width={width}
        previewRows={previewRows}
        getLink={getLink}
        defaultIncludeLink={chat?.includeLink() ?? true}
        onIncludeLinkChange={(value) => chat?.setIncludeLink(value)}
        post={async (request) => {
          if (!chat) throw new Error("Enable Gloom Cloud to post to chat.");
          const link = request.includeLink && getLink ? await getLink() : undefined;
          return chat.post(capture, request, paneShareMessage(request.caption, link));
        }}
      />,
    });
    if (!result) return;
    if (result.kind === "copy") registry.notify({ body: "Share link copied to clipboard", type: "success" });
    else chat?.posted(result, targets);
  } catch (error) {
    registry.notify({ body: error instanceof Error ? error.message : "Could not share this pane.", type: "error" });
  } finally {
    release();
  }
}
