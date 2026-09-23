import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePaneFooter, usePaneFooterScopeActive } from "../layout/pane/footer/registration";

interface ScopedAction {
  id: string;
  label: string;
  disabled: boolean;
  press: () => void;
}

interface ActionScope {
  register(action: ScopedAction): () => void;
  update(action: ScopedAction): void;
  primaryId: string | null;
}

const ActionScopeContext = createContext<ActionScope | null>(null);

/** The key a scope's first action answers to, shown on its button. */
const PRIMARY_ACTION_KEY = "Enter";

/**
 * Collects the kit Buttons rendered inside it (an empty or failed state's
 * Retry, Log in, Start) so they work without a mouse: the first answers Enter
 * while the pane is focused and shows it, and every one is in the pane menu.
 * Outside a pane it only renders its children.
 */
export function ButtonActionScope({ children }: { children: ReactNode }) {
  const inPane = usePaneFooterScopeActive();
  const registrationId = `button-actions:${useId()}`;
  const [actions, setActions] = useState<ScopedAction[]>([]);
  const handlers = useRef({
    register(action: ScopedAction) {
      setActions((current) => [...current.filter((entry) => entry.id !== action.id), action]);
      return () => setActions((current) => current.filter((entry) => entry.id !== action.id));
    },
    update(action: ScopedAction) {
      setActions((current) => {
        const index = current.findIndex((entry) => entry.id === action.id);
        if (index < 0) return current;
        const existing = current[index]!;
        if (existing.label === action.label && existing.disabled === action.disabled && existing.press === action.press) return current;
        const next = current.slice();
        next[index] = action;
        return next;
      });
    },
  }).current;
  const enabled = actions.filter((action) => !action.disabled);
  const primary = inPane ? enabled[0] ?? null : null;
  const primaryId = primary?.id ?? null;
  // A new value when the primary changes, so the buttons re-render to show the key.
  const scope = useMemo<ActionScope>(() => ({ ...handlers, primaryId }), [handlers, primaryId]);

  usePaneFooter(registrationId, () => {
    if (enabled.length === 0) return null;
    return {
      keys: primary ? [{ id: primary.id, key: PRIMARY_ACTION_KEY, label: primary.label, onPress: () => primary.press() }] : [],
      menu: enabled.map((action) => ({
        id: action.id,
        label: action.label,
        accelerator: action.id === primary?.id ? PRIMARY_ACTION_KEY : undefined,
        onSelect: () => action.press(),
      })),
    };
  }, [enabled.map((action) => `${action.id}:${action.label}`).join("|"), primary?.id]);

  return <ActionScopeContext value={scope}>{children}</ActionScopeContext>;
}

/**
 * Registers a kit Button with the nearest ButtonActionScope and returns the key
 * it should show, if it is the scope's primary action.
 */
export function useScopedButtonAction(label: string, onPress: (() => void) | undefined, disabled: boolean): string | undefined {
  const scope = useContext(ActionScopeContext);
  const id = useId();
  const pressRef = useRef(onPress);
  pressRef.current = onPress;
  const pressStable = useRef(() => pressRef.current?.()).current;
  const register = scope?.register;
  const update = scope?.update;
  const active = !!onPress;
  // Keyed on the stable register function, so a change of primary (a new
  // context value) never re-registers and reorders the actions.
  useLayoutEffect(() => {
    if (!register || !active) return;
    return register({ id, label, disabled, press: pressStable });
    // Registration identity only; label and disabled flow through update().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, active, id]);
  useLayoutEffect(() => {
    if (update && active) update({ id, label, disabled, press: pressStable });
  }, [update, active, id, label, disabled, pressStable]);
  return scope && scope.primaryId === id ? PRIMARY_ACTION_KEY : undefined;
}
