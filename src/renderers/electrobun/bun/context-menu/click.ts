import { recordOrNull } from "../../../../utils/guards";

export interface ContextMenuSelectionMessage {
  requestId: string;
  itemId: string;
}

function contextMenuClickPayload(event: unknown): Record<string, unknown> | null {
  const eventRecord = recordOrNull(event);
  if (!eventRecord) return null;

  const wrappedPayload = recordOrNull(eventRecord.data);
  if (typeof wrappedPayload?.action === "string") {
    return wrappedPayload;
  }

  return typeof eventRecord.action === "string" ? eventRecord : null;
}

function decodeActionSelection(action: string, expectedAction: string): ContextMenuSelectionMessage | null {
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
): ContextMenuSelectionMessage | null {
  const payload = contextMenuClickPayload(event);
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
