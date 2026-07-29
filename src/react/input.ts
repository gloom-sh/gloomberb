import {
  createContext,
  createElement,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";

export interface KeyEventLike {
  key: string;
  name?: string;
  sequence?: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  super?: boolean;
  targetEditable?: boolean;
  readonly defaultPrevented?: boolean;
  readonly propagationStopped?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface ShortcutOptions {
  enabled?: boolean;
  /**
   * Groups related handlers into one interaction surface. Within each phase,
   * newer enabled scopes receive events before older scopes and unscoped
   * handlers. Once a scoped handler prevents the default action, only that
   * scope receives the rest of the dispatch.
   */
  scope?: string;
  phase?: "before" | "normal" | "after";
  allowEditable?: boolean;
}

interface ShortcutRegistration {
  handler(event: KeyEventLike): void;
  isEnabled(): boolean;
  allowsEditable(): boolean;
  scope?: string;
  phase: NonNullable<ShortcutOptions["phase"]>;
}

interface ShortcutEntry extends ShortcutRegistration {
  order: number;
}

export interface ShortcutRegistry {
  register(registration: ShortcutRegistration): () => void;
  dispatch(event: KeyEventLike): void;
}

const SHORTCUT_PHASES: ReadonlyArray<ShortcutEntry["phase"]> = [
  "before",
  "normal",
  "after",
];

function normalizeShortcutScope(scope: string | undefined): string | undefined {
  const normalized = scope?.trim();
  return normalized || undefined;
}

function orderShortcutEntries(entries: ShortcutEntry[]): ShortcutEntry[] {
  const scopePriority = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.scope) continue;
    scopePriority.set(entry.scope, Math.max(scopePriority.get(entry.scope) ?? 0, entry.order));
  }

  return entries.sort((left, right) => {
    if (left.scope === right.scope) return left.order - right.order;
    if (!left.scope) return 1;
    if (!right.scope) return -1;
    return (scopePriority.get(right.scope) ?? 0) - (scopePriority.get(left.scope) ?? 0);
  });
}

export function createShortcutRegistry(): ShortcutRegistry {
  let nextOrder = 1;
  const entries = new Map<number, ShortcutEntry>();

  return {
    register(registration) {
      const order = nextOrder++;
      entries.set(order, {
        ...registration,
        scope: normalizeShortcutScope(registration.scope),
        order,
      });
      return () => {
        entries.delete(order);
      };
    },
    dispatch(event) {
      const eligible = orderShortcutEntries(
        [...entries.values()].filter((entry) => (
          entry.isEnabled() && shouldDeliverShortcut(event, entry.allowsEditable())
        )),
      );
      let claimedScope: string | undefined;

      for (const phase of SHORTCUT_PHASES) {
        if (phase === "after" && (event.defaultPrevented || event.propagationStopped)) return;
        for (const entry of eligible) {
          if (entry.phase !== phase) continue;
          if (claimedScope && entry.scope !== claimedScope) continue;

          const wasDefaultPrevented = event.defaultPrevented === true;
          entry.handler(event);
          if (!wasDefaultPrevented && event.defaultPrevented && entry.scope) {
            claimedScope = entry.scope;
          }
          if (event.propagationStopped) return;
        }
      }
    },
  };
}

export function useRegisteredShortcut(
  registry: ShortcutRegistry,
  handler: (event: KeyEventLike) => void,
  options?: ShortcutOptions,
): void {
  const handlerRef = useRef(handler);
  const enabledRef = useRef(options?.enabled !== false);
  const allowEditableRef = useRef(options?.allowEditable === true);
  handlerRef.current = handler;
  enabledRef.current = options?.enabled !== false;
  allowEditableRef.current = options?.allowEditable === true;

  useLayoutEffect(() => registry.register({
    handler: (event) => handlerRef.current(event),
    isEnabled: () => enabledRef.current,
    allowsEditable: () => allowEditableRef.current,
    phase: options?.phase ?? "normal",
    scope: options?.scope,
  }), [options?.phase, options?.scope, registry]);
}

export interface InputHost {
  useShortcut(
    handler: (event: KeyEventLike) => void,
    options?: ShortcutOptions,
  ): void;
  useViewport(): { width: number; height: number };
}

const InputHostContext = createContext<InputHost | null>(null);

export function InputHostProvider({
  host,
  children,
}: {
  host: InputHost;
  children: ReactNode;
}) {
  return createElement(InputHostContext, { value: host }, children);
}

function useInputHost(): InputHost {
  const host = useContext(InputHostContext);
  if (!host) {
    throw new Error("Input host hooks must be used inside InputHostProvider");
  }
  return host;
}

export function useShortcut(
  handler: (event: KeyEventLike) => void,
  options?: ShortcutOptions,
): void {
  useInputHost().useShortcut(handler, options);
}

export function shouldDeliverShortcut(
  event: KeyEventLike,
  allowEditable: boolean,
): boolean {
  if (allowEditable || event.targetEditable !== true) return true;
  return event.ctrl || event.meta || event.super === true;
}

export function useViewport(): { width: number; height: number } {
  return useInputHost().useViewport();
}
