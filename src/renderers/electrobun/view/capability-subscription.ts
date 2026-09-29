import type { DesktopCapabilitySubscribeRequest } from "../shared/protocol";

export interface CapabilitySubscriptionOptions extends DesktopCapabilitySubscribeRequest {
  onEvent(event: unknown): void;
  /** The Bun process has the subscription running. Not called once disposed. */
  onSubscribed?(): void;
  /** The subscribe request failed. Not called once disposed. */
  onError?(error: unknown): void;
}

export interface CapabilitySubscriptionTransport {
  subscribe(request: DesktopCapabilitySubscribeRequest): Promise<unknown>;
  unsubscribe(subscriptionId: string): Promise<unknown>;
  onEvent(subscriptionId: string, listener: (event: unknown) => void): () => void;
}

/**
 * Runs a capability subscription in the Bun process and forwards its events
 * until the returned dispose is called. The Bun process only registers a
 * subscription once its subscribe request lands, so an unsubscribe sent while
 * that request is in flight would be a no-op and leave it running. Disposing
 * early therefore defers the unsubscribe until the subscribe settles.
 */
export function subscribeCapability(
  transport: CapabilitySubscriptionTransport,
  { onEvent, onSubscribed, onError, ...request }: CapabilitySubscriptionOptions,
): () => void {
  let disposed = false;
  let subscribed = false;
  const unsubscribe = () => {
    void transport.unsubscribe(request.subscriptionId).catch(() => {});
  };
  const stopEvents = transport.onEvent(request.subscriptionId, onEvent);

  transport.subscribe(request).then(() => {
    subscribed = true;
    if (disposed) unsubscribe();
    else onSubscribed?.();
  }, (error) => {
    stopEvents();
    if (!disposed) onError?.(error);
  });

  return () => {
    if (disposed) return;
    disposed = true;
    stopEvents();
    if (subscribed) unsubscribe();
  };
}
