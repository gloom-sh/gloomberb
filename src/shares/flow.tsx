import type { PluginRegistry } from "../plugins/registry";
import { getPaneChatSharing } from "./chat";
import { SHARE_DIALOG_COLUMNS, ShareDialog, type ShareResult } from "./dialog";
import { paneShareLink, paneShareMessage } from "./live";

/** One in-flight capture/dialog per window, including the frames before the overlay mounts. */
let sharing = false;
const TERMINAL_DIALOG_CHROME = 6;
const TERMINAL_FORM_ROWS = 25;

/** The same captured view for both destinations. A cancelled dialog creates no public link. */
export async function shareFocusedPane(registry: PluginRegistry, paneId?: string): Promise<void> {
  if (sharing) return;
  const chat = getPaneChatSharing();
  if (chat && !chat.ready(() => { void shareFocusedPane(registry, paneId); })) return;
  sharing = true;
  try {
    const capture = await registry.capturePaneImage(paneId);
    const getLink = capture.sharePayload ? paneShareLink(capture.sharePayload) : null;
    const targets = chat ? await chat.targets() : [];
    const viewport = registry.getTermSize();
    const width = Math.max(30, Math.min(SHARE_DIALOG_COLUMNS, viewport.width - TERMINAL_DIALOG_CHROME - 4));
    const naturalRows = capture.cells && capture.cells.cols <= width
      ? capture.cells.rows
      : Math.ceil((width * capture.height) / Math.max(1, capture.width) / 2);
    const previewRows = Math.max(4, Math.min(naturalRows, viewport.height - TERMINAL_FORM_ROWS));
    const result = await registry.promptDialog<ShareResult>({
      closeOnClickOutside: false,
      style: { width: width + TERMINAL_DIALOG_CHROME },
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
    sharing = false;
  }
}
