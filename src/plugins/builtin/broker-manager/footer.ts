import { useMemo, useRef } from "react";
import { usePaneFooter, type PaneFooterSegment, type PaneHint } from "../../../components";
import { isBrokerErrorMessage } from "./table";

interface BrokerManagerFooterActions {
  connectSelected: () => Promise<void>;
  openAddBroker: () => void;
  openProfileAction: () => void;
  removeSelected: () => Promise<void>;
  saveEdit: () => Promise<void>;
  startEdit: () => void;
  syncSelected: () => Promise<void>;
}

export function useBrokerManagerFooter({
  actions,
  busy,
  canOpenSelectedAction,
  canRemoveSelected,
  canUseSelectedBroker,
  editing,
  message,
}: {
  actions: BrokerManagerFooterActions;
  /** What is running right now, or null. */
  busy: string | null;
  canOpenSelectedAction: boolean;
  canRemoveSelected: boolean;
  canUseSelectedBroker: boolean;
  editing: boolean;
  /** The last result of an action, or null. */
  message: string | null;
}) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const footerHints = useMemo<PaneHint[]>(() => {
    // Enter to save and Esc to cancel are app-wide form conventions, and the edit
    // form already renders its own Save and Cancel buttons, so the footer stays empty.
    if (editing) return [];

    const hints: PaneHint[] = [
      { id: "add", key: "a", label: "dd", onPress: () => actionsRef.current.openAddBroker() },
    ];
    if (canUseSelectedBroker) {
      hints.push(
        { id: "edit", key: "e", label: "dit", onPress: () => actionsRef.current.startEdit() },
        { id: "connect", key: "c", label: "onnect", onPress: () => actionsRef.current.connectSelected().catch(() => {}) },
        { id: "sync", key: "s", label: "ync", onPress: () => actionsRef.current.syncSelected().catch(() => {}) },
      );
    }
    if (canOpenSelectedAction) {
      hints.push({ id: "open", key: "o", label: "pen", onPress: () => actionsRef.current.openProfileAction() });
    }
    if (canRemoveSelected) {
      hints.push({ id: "disconnect", key: "d", label: "isconnect", onPress: () => actionsRef.current.removeSelected().catch(() => {}) });
    }
    return hints;
  }, [canOpenSelectedAction, canRemoveSelected, canUseSelectedBroker, editing]);

  // The pane's rows already say which profiles exist and how they are doing,
  // so the footer carries only what changes: the running action and its result.
  const info = useMemo<PaneFooterSegment[]>(() => [
    ...(busy ? [{ id: "busy", parts: [{ text: busy, tone: "muted" as const }] }] : []),
    ...(message ? [{ id: "message", parts: [{ text: message, tone: isBrokerErrorMessage(message) ? "negative" as const : "muted" as const }] }] : []),
  ], [busy, message]);

  usePaneFooter("broker-manager", () => ({
    info,
    hints: footerHints,
  }), [footerHints, info]);
}
