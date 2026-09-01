import type { ResolvedIbkrGatewayConnection } from "../../../ibkr/gateway-types";

export type NativeGatewayModule = {
  ibkrGatewayManager: any;
  setResolvedIbkrGatewayListener(
    listener: ((instanceId: string | undefined, connection: ResolvedIbkrGatewayConnection) => void | Promise<void>) | null,
  ): void;
};

export function loadNativeGatewayModule(): Promise<NativeGatewayModule> {
  return import("./native");
}
