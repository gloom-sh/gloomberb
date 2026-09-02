import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { RemoteUiNodeSnapshot } from "./types";

type RemoteUiAction = (input?: unknown) => unknown | Promise<unknown>;

export interface RemoteUiNodeRegistration {
  role: string;
  label?: string;
  disabled?: boolean;
  actions?: Record<string, RemoteUiAction | undefined>;
  metadata?: Record<string, unknown>;
  /** Defers expensive metadata projection until a remote snapshot requests it. */
  getMetadata?: () => Record<string, unknown>;
}

interface RegisteredRemoteUiNode {
  id: string;
  registration: RemoteUiNodeRegistration;
}

export interface RemoteUiRegistry {
  register(id: string, registration: RemoteUiNodeRegistration): void;
  unregister(id: string): void;
  snapshot(): RemoteUiNodeSnapshot[];
  invoke(nodeId: string, action: string, input?: unknown): Promise<unknown>;
}

const RemoteUiRegistryContext = createContext<RemoteUiRegistry | null>(null);

export function createRemoteUiRegistry(): RemoteUiRegistry {
  const nodes = new Map<string, RegisteredRemoteUiNode>();

  return {
    register(id, registration) {
      nodes.set(id, { id, registration });
    },
    unregister(id) {
      nodes.delete(id);
    },
    snapshot() {
      return [...nodes.values()].map((node) => {
        const registration = node.registration;
        return {
          id: node.id,
          role: registration.role,
          label: registration.label,
          disabled: registration.disabled,
          actions: Object.entries(registration.actions ?? {})
            .filter((entry): entry is [string, RemoteUiAction] => typeof entry[1] === "function")
            .map(([action]) => action)
            .sort(),
          metadata: registration.getMetadata?.() ?? registration.metadata,
        };
      });
    },
    async invoke(nodeId, action, input) {
      const node = nodes.get(nodeId);
      if (!node) throw new Error(`Unknown UI node "${nodeId}".`);
      const registration = node.registration;
      if (registration.disabled) throw new Error(`UI node "${nodeId}" is disabled.`);
      const handler = registration.actions?.[action];
      if (typeof handler !== "function") {
        throw new Error(`UI node "${nodeId}" does not expose action "${action}".`);
      }
      return await handler(input);
    },
  };
}

export function RemoteUiRegistryProvider({
  children,
  registry,
}: {
  children: ReactNode;
  registry?: RemoteUiRegistry;
}) {
  const registryRef = useRef<RemoteUiRegistry | null>(registry ?? null);
  if (!registryRef.current) {
    registryRef.current = createRemoteUiRegistry();
  }
  return (
    <RemoteUiRegistryContext value={registryRef.current}>
      {children}
    </RemoteUiRegistryContext>
  );
}

export function useRemoteUiRegistry(): RemoteUiRegistry | null {
  return useContext(RemoteUiRegistryContext);
}

export function useRemoteUiNode(registration: RemoteUiNodeRegistration | null | undefined): string | null {
  const registry = useRemoteUiRegistry();
  const generatedId = useId();
  const nodeId = useMemo(() => `ui:${generatedId.replace(/:/g, "")}`, [generatedId]);
  const registrationRef = useRef(registration);
  registrationRef.current = registration;
  const dynamicRegistrationRef = useRef<RemoteUiNodeRegistration | null>(null);
  if (!dynamicRegistrationRef.current) {
    dynamicRegistrationRef.current = {
      get role() { return registrationRef.current?.role ?? "unknown"; },
      get label() { return registrationRef.current?.label; },
      get disabled() { return registrationRef.current?.disabled; },
      get actions() { return registrationRef.current?.actions; },
      get metadata() { return registrationRef.current?.metadata; },
      get getMetadata() { return registrationRef.current?.getMetadata; },
    };
  }
  const registered = registration != null;

  useEffect(() => {
    if (!registry) return;
    if (!registered) {
      registry.unregister(nodeId);
      return;
    }
    registry.register(nodeId, dynamicRegistrationRef.current!);
    return () => registry.unregister(nodeId);
  }, [nodeId, registered, registry]);

  return registry && registered ? nodeId : null;
}
