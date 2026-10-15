import { functionCode, paneFunctionLabel } from "../ask-gloom/pane-context";
import { getCurrentPluginTarget } from "../plugins/current-target";
import type { PluginRegistry } from "../plugins/registry";
import { displayWidth } from "../utils/format";
import { VERSION } from "../version";
import { BUG_REPORT_CHANNEL_ID, bugReportContextLine, bugReportMessage, type BugReportContext } from "./bug-report";
import { BugReportDialog, type BugReportSent } from "./bug-report-dialog";
import { claimCaptureFlow } from "./capture-flow";
import { CAPTURE_DIALOG_CHROME, captureDialogSize } from "./capture-preview";
import { getPaneChatSharing } from "./chat";

/** What was typed, kept when the form closes without sending; a sent report clears it. */
const draft = { text: "" };
/** Terminal rows the form takes under the preview: the pane line, the field, the notes and the buttons. */
const TERMINAL_FORM_ROWS = 21;

/**
 * Whether Report a Bug can be offered: chat is there to post it, and the
 * window can take a picture of a pane.
 */
export function canReportPaneBug(canCapture: boolean): boolean {
  return canCapture && getPaneChatSharing() !== null;
}

/**
 * Report a Bug for a pane (the focused one when omitted): its picture as it
 * is now, a line from the person, its function and the app version, posted
 * to #bugs as their own message. Signed out, the sign-in prompt shows
 * instead, and the report starts again once they are in.
 */
export async function reportPaneBug(registry: PluginRegistry, paneId?: string): Promise<void> {
  const chat = getPaneChatSharing();
  if (!chat) {
    registry.notify({ body: "Turn on Gloom Cloud chat to report a bug.", type: "error" });
    return;
  }
  // One capture flow at a time, Share's included, until the post lands or the form closes.
  const release = claimCaptureFlow();
  if (!release) return;
  try {
    if (!chat.ready(() => { void reportPaneBug(registry, paneId); }, "bug-report")) return;
    // The chat session and channels load while the pane is pictured.
    const [capture] = await Promise.all([registry.capturePaneImage(paneId), chat.targets()]);
    const context: BugReportContext = {
      paneLabel: paneFunctionLabel({ title: capture.title, paneType: capture.paneType, code: functionCode(registry, capture.paneType, capture.title) }),
      version: VERSION,
      surface: getCurrentPluginTarget(),
    };
    const contextLine = bugReportContextLine(context);
    const { width } = captureDialogSize(registry.getTermSize(), capture, TERMINAL_FORM_ROWS);
    // The pane line wraps rather than cuts, as it is posted whole.
    const metaRows = Math.max(1, Math.ceil(displayWidth(contextLine) / width));
    const { previewRows } = captureDialogSize(registry.getTermSize(), capture, TERMINAL_FORM_ROWS + metaRows - 1);
    const sent = await registry.promptDialog<BugReportSent>({
      closeOnClickOutside: false,
      style: { width: width + CAPTURE_DIALOG_CHROME },
      content: (prompt) => <BugReportDialog
        {...prompt}
        capture={capture}
        context={contextLine}
        width={width}
        previewRows={previewRows}
        initialText={draft.text}
        onTextChange={(text) => { draft.text = text; }}
        send={(line) => chat.post(
          capture,
          { channelId: BUG_REPORT_CHANNEL_ID, caption: line, includeLink: false },
          bugReportMessage(line, context),
        )}
      />,
    });
    if (!sent) return;
    draft.text = "";
    registry.notify({
      body: `Bug report posted to #${BUG_REPORT_CHANNEL_ID}`,
      type: "success",
      action: { label: "Open", onClick: () => { chat.openMessage(BUG_REPORT_CHANNEL_ID, sent.messageId); } },
    });
  } catch (error) {
    registry.notify({ body: error instanceof Error && error.message ? error.message : "Could not report this bug.", type: "error" });
  } finally {
    release();
  }
}
