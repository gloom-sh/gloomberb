import { recordOrNull } from "../../../utils/guards";

/**
 * The `{ action, data }` of a native menu click. Electrobun delivers it wrapped
 * in an event whose `data` is the payload; a bare payload is accepted too.
 */
export function menuClickPayload(event: unknown): Record<string, unknown> | null {
  const eventRecord = recordOrNull(event);
  if (!eventRecord) return null;

  const wrappedPayload = recordOrNull(eventRecord.data);
  if (typeof wrappedPayload?.action === "string") {
    return wrappedPayload;
  }

  return typeof eventRecord.action === "string" ? eventRecord : null;
}
