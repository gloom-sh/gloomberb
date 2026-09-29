import { setCapabilityStreamClient } from "../../../capabilities";
import { backendRequest, subscribeBackendCapability } from "./backend-rpc";

let nextSubscriptionId = 1;

/**
 * Lets a plugin in the view call a streaming capability that runs in the Bun
 * process.
 *
 * Request/response already crosses through the capability invoker. This is the
 * other half: an operation that emits as it works, such as a model writing a
 * token at a time or a provider sign-in reporting a device code. The view
 * cannot hold either, so it subscribes here and the Bun process streams back.
 */
export function installElectrobunCapabilityStreamClient(): void {
  setCapabilityStreamClient({
    invoke(capabilityId, operationId, payload) {
      return backendRequest("capability.invoke", { capabilityId, operationId, payload });
    },
    subscribe({ capabilityId, operationId, payload, onEvent, onError }) {
      return subscribeBackendCapability({
        subscriptionId: `capability-stream:${nextSubscriptionId++}`,
        capabilityId,
        operationId,
        payload,
        onEvent,
        onError,
      });
    },
  });
}
