import { withDeadline } from "../../../../utils/async-deadline";

type CapabilityRequest = <T>(method: string, payload: unknown) => Promise<T>;
let nextCapabilityInvocationId = 1;

export function createCapabilityInvoker(options: {
  request: CapabilityRequest;
  shouldApplyDeadline(capabilityId: string): boolean;
  timeoutMs: number;
}) {
  const inFlightRequests = new Map<string, Promise<unknown>>();

  return function invoke<T>(
    capabilityId: string,
    operationId: string,
    payload: unknown,
    invokeOptions: { signal?: AbortSignal } = {},
  ): Promise<T> {
    invokeOptions.signal?.throwIfAborted();
    const key = JSON.stringify({ capabilityId, operationId, payload });
    const inFlight = invokeOptions.signal ? undefined : inFlightRequests.get(key);
    if (inFlight) return inFlight as Promise<T>;

    const invocationId = `view:${nextCapabilityInvocationId++}`;
    const request = options.request<T>("capability.invoke", {
      capabilityId,
      operationId,
      payload,
      invocationId,
    });
    const cancel = () => {
      void options.request<null>("capability.cancel", { invocationId }).catch(() => {});
    };
    invokeOptions.signal?.addEventListener("abort", cancel, { once: true });
    if (invokeOptions.signal?.aborted) cancel();
    void request.finally(() => invokeOptions.signal?.removeEventListener("abort", cancel)).catch(() => {});

    const boundedRequest = options.shouldApplyDeadline(capabilityId)
      ? withDeadline(
        request,
        options.timeoutMs,
        `Asset data request timed out after ${options.timeoutMs}ms: ${operationId}`,
      )
      : request;
    if (!invokeOptions.signal) {
      inFlightRequests.set(key, boundedRequest);
      void request.finally(() => {
        if (inFlightRequests.get(key) === boundedRequest) {
          inFlightRequests.delete(key);
        }
      }).catch(() => {
        // The returned bounded request owns error delivery to the caller.
      });
    }
    return boundedRequest;
  };
}
