import { useMemo, useRef } from "react";
import { usePaneFooter, type PaneFooterSegment, type PaneHint } from "../../../components";
import { enableBrokerHint } from "../shared/broker-reconnect";
import type { BrokerManagerMessage } from "./pane-actions";

interface BrokerManagerFooterActions {
  connectSelected: () => Promise<void>;
  enableSelected: () => Promise<void>;
  startAdd: () => void;
  openProfileAction: () => void;
  removeSelected: () => void;
  saveEdit: () => Promise<void>;
  startEdit: () => void;
  syncSelected: () => Promise<void>;
}

export function useBrokerManagerFooter({
  actions,
  busy,
  paneBusy,
  canOpenSelectedAction,
  canRemoveSelected,
  canUseSelectedBroker,
  disabledSelected,
  editing,
  message,
}: {
  actions: BrokerManagerFooterActions;
  /** What is running right now, or null. */
  busy: string | null;
  /** What is running that has no row to show it on: adding a profile. */
  paneBusy: string | null;
  canOpenSelectedAction: boolean;
  canRemoveSelected: boolean;
  canUseSelectedBroker: boolean;
  /**
   * The selected profile is turned off, so it is never connected or synced:
   * its broker's name for `[b] enable`, which turns it back on.
   */
  disabledSelected: string | null;
  /** Editing a profile or adding one. */
  editing: boolean;
  /** The last result that is the whole pane's, or null. */
  message: BrokerManagerMessage | null;
}) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const footerHints = useMemo<PaneHint[]>(() => {
    // Enter to save and Esc to cancel are app-wide form conventions, and the edit
    // and add forms render their own buttons, so the footer stays empty.
    if (editing) return [];

    const hints: PaneHint[] = [
      { id: "add", key: "a", label: "dd", onPress: () => actionsRef.current.startAdd() },
    ];
    if (canUseSelectedBroker) {
      hints.push({ id: "edit", key: "e", label: "dit", onPress: () => actionsRef.current.startEdit() });
      if (disabledSelected === null) {
        hints.push(
          { id: "connect", key: "c", label: "onnect", onPress: () => actionsRef.current.connectSelected().catch(() => {}) },
          { id: "sync", key: "s", label: "ync", onPress: () => actionsRef.current.syncSelected().catch(() => {}) },
        );
      }
    }
    if (disabledSelected !== null && !busy) {
      hints.push(enableBrokerHint(disabledSelected, () => { void actionsRef.current.enableSelected(); }));
    }
    if (canOpenSelectedAction) {
      hints.push({ id: "open", key: "o", label: "pen", onPress: () => actionsRef.current.openProfileAction() });
    }
    if (canRemoveSelected) {
      hints.push({ id: "disconnect", key: "d", label: "isconnect", onPress: () => actionsRef.current.removeSelected() });
    }
    return hints;
  }, [busy, canOpenSelectedAction, canRemoveSelected, canUseSelectedBroker, disabledSelected, editing]);

  // An action on one profile, and what it came to, is said on that profile's
  // row. The footer carries only the pane's own: adding a profile.
  const info = useMemo<PaneFooterSegment[]>(() => [
    ...(paneBusy ? [{ id: "busy", parts: [{ text: paneBusy, tone: "muted" as const }] }] : []),
    ...(message ? [{ id: "message", parts: [{ text: message.text, tone: message.tone === "error" ? "negative" as const : "muted" as const }] }] : []),
  ], [message, paneBusy]);

  usePaneFooter("broker-manager", () => ({
    info,
    hints: footerHints,
  }), [footerHints, info]);
}
