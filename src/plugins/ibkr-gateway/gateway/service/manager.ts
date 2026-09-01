import type { IbkrSnapshot } from "../../../ibkr/gateway-types";

export interface IbkrGatewayServiceLike {
  getSnapshot(): IbkrSnapshot;
  subscribe(listener: () => void): () => void;
  disconnect(): Promise<void>;
}

export class IbkrGatewayServiceManager<T extends IbkrGatewayServiceLike = IbkrGatewayServiceLike> {
  private services = new Map<string, T>();

  constructor(
    private readonly createService?: (instanceId: string) => T,
    private readonly fallbackSnapshot?: IbkrSnapshot,
  ) {}

  getService(instanceId: string): T {
    let service = this.services.get(instanceId);
    if (!service) {
      if (!this.createService) throw new Error("IBKR gateway service factory is required.");
      service = this.createService(instanceId);
      this.services.set(instanceId, service);
    }
    return service;
  }

  getSnapshot(instanceId?: string): IbkrSnapshot {
    if (!instanceId) {
      if (!this.fallbackSnapshot) throw new Error("IBKR gateway snapshot fallback is required without an instance ID.");
      return this.fallbackSnapshot;
    }
    return this.getService(instanceId).getSnapshot();
  }

  subscribe(instanceId: string | undefined, listener: () => void): () => void {
    if (!instanceId) return () => {};
    return this.getService(instanceId).subscribe(listener);
  }

  async removeInstance(instanceId: string): Promise<void> {
    const service = this.services.get(instanceId);
    if (!service) return;
    await service.disconnect();
    this.services.delete(instanceId);
  }

  async destroyAll(): Promise<void> {
    const services = [...this.services.values()];
    this.services.clear();
    await Promise.allSettled(services.map((service) => service.disconnect()));
  }
}
