import { recordOrNull } from "../../../../utils/guards";
import type { ContextMenuSelectMessage } from "../../shared/protocol";
import { menuClickPayload } from "../menu-event";

function decodeActionSelection(action: string, expectedAction: string): ContextMenuSelectMessage | null {
  const prefix = `${expectedAction}:`;
  if (!action.startsWith(prefix)) return null;

  const [requestId, itemId] = action.slice(prefix.length).split(":").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  if (!requestId || !itemId) return null;

  return { requestId, itemId };
}

export function contextMenuSelectionMessage(
  event: unknown,
  expectedAction: string,
): ContextMenuSelectMessage | null {
  const payload = menuClickPayload(event);
  if (typeof payload?.action !== "string") return null;

  const actionMessage = decodeActionSelection(payload.action, expectedAction);
  if (actionMessage) return actionMessage;

  if (payload.action !== expectedAction) return null;

  const data = recordOrNull(payload.data);
  if (typeof data?.requestId !== "string" || typeof data.itemId !== "string") {
    return null;
  }

  return {
    requestId: data.requestId,
    itemId: data.itemId,
  };
}
