import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  buildBrokerProfileConfig,
  createBrokerProfileDraft,
  validateBrokerProfileValues,
  type BrokerProfileDraft,
} from "../../../brokers/profile-form";
import { brokerProfileRemovalConfirm, removeBrokerProfile } from "../../../brokers/remove-profile";
import { signedInBrokerForProfile } from "../../../brokers/signed-in/connect";
import { isSignedInBrokerProfile } from "../../../brokers/signed-in/profile";
import { requestBrokerSignIn } from "../../../brokers/signed-in/sign-in-dialog";
import { confirmDialog } from "../../../components";
import { openConfirmModal } from "../../../components/form-modal";
import { useAppGetState } from "../../../state/app/context";
import type { BrokerProfileAction } from "../../../types/broker";
import { useDialog } from "../../../ui/dialog";
import { t, tf } from "../../../i18n";
import { usePluginAppActions, usePluginBrokerActions } from "../../runtime";
import { enableBrokerProfile } from "../shared/broker-reconnect";
import type { BrokerEditKey } from "./detail";
import { neighbourBrokerProfileId, type BrokerProfileRow } from "./model";

/**
 * A result that is the whole pane's, said in its footer: the add flow's, which
 * has no row yet, or a request the pane turned down.
 */
export interface BrokerManagerMessage {
  tone: "info" | "error";
  text: string;
}

/**
 * What the last action on one profile came to, said on its row: `status` in
 * its STATUS, `text` in its detail, in place of the profile's own status
 * message. It stands until the next action on the profile, or until the
 * profile's own status or sync moves on past it.
 */
export interface BrokerRowNote {
  tone: "info" | "error";
  text: string;
  /** A failure's short state for STATUS, "Sync failed"; none keeps the row's own state. */
  status?: string;
  at: number;
}

/** What a row shows of the pane's own work on it. */
export interface BrokerRowActivity {
  /** The action running on the profile: "Syncing…". */
  busy?: string | null;
  note?: BrokerRowNote | null;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useBrokerManagerActions({
  selectedRow,
  editDraft,
  setEditDraft,
  setActiveEditKey,
  setDetailOpen,
  setSelectedId,
  refreshStatuses,
}: {
  selectedRow: BrokerProfileRow | null;
  editDraft: BrokerProfileDraft | null;
  setEditDraft: Dispatch<SetStateAction<BrokerProfileDraft | null>>;
  setActiveEditKey: Dispatch<SetStateAction<BrokerEditKey>>;
  setDetailOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedId: (id: string | null) => void;
  refreshStatuses: () => void;
}) {
  const getState = useAppGetState();
  const dialog = useDialog();
  const { notify, showPane } = usePluginAppActions();
  const {
    connectBrokerInstance,
    updateBrokerInstance,
    syncBrokerInstance,
    removeBrokerInstance,
  } = usePluginBrokerActions();
  // The running action and the profile it is on; none for the add flow's.
  const [busyState, setBusyState] = useState<{ text: string; profileId: string | null } | null>(null);
  const setBusy = useCallback((text: string | null, profileId: string | null = null) => {
    setBusyState(text ? { text, profileId } : null);
  }, []);
  const busy = busyState?.text ?? null;
  const [message, setMessage] = useState<BrokerManagerMessage | null>(null);
  const [rowNotes, setRowNotes] = useState<ReadonlyMap<string, BrokerRowNote>>(() => new Map());
  const setRowNote = useCallback((profileId: string, note: Omit<BrokerRowNote, "at"> | null) => {
    setRowNotes((current) => {
      if (!note && !current.has(profileId)) return current;
      const next = new Map(current);
      if (note) next.set(profileId, { ...note, at: Date.now() });
      else next.delete(profileId);
      return next;
    });
  }, []);
  /** Starts an action on a profile: its row says so, in place of the last one's result. */
  const startRowAction = useCallback((profileId: string, text: string) => {
    setRowNote(profileId, null);
    setBusy(text, profileId);
  }, [setBusy, setRowNote]);
  const rowActivity = useCallback((row: BrokerProfileRow): BrokerRowActivity => {
    const note = rowNotes.get(row.id);
    return {
      busy: busyState?.profileId === row.id ? busyState.text : null,
      // A later status or sync, from anywhere, is newer news than the note.
      note: note && row.updatedAt <= note.at && row.lastSyncedAt <= note.at ? note : null,
    };
  }, [busyState, rowNotes]);

  const startEdit = useCallback(() => {
    if (!selectedRow?.adapter) return;
    const draft = createBrokerProfileDraft(selectedRow.adapter, selectedRow.instance);
    for (const field of selectedRow.adapter.configSchema) {
      if (field.type === "password" && draft.values[field.key]) draft.values[field.key] = "";
    }
    setEditDraft(draft);
    setActiveEditKey("label");
    setRowNote(selectedRow.id, null);
    setDetailOpen(true);
  }, [selectedRow, setActiveEditKey, setDetailOpen, setEditDraft, setRowNote]);

  // The edit form is in the profile's detail, so what stops a save is said there, not in STATUS.
  const saveEdit = useCallback(async () => {
    if (!selectedRow?.adapter || !editDraft) return;
    const label = editDraft.label.trim();
    if (!label) {
      setRowNote(selectedRow.id, { tone: "error", text: t("Profile label is required.") });
      return;
    }
    const validationError = validateBrokerProfileValues(selectedRow.adapter, editDraft.values, selectedRow.instance);
    if (validationError) {
      setRowNote(selectedRow.id, { tone: "error", text: validationError });
      return;
    }

    try {
      startRowAction(selectedRow.id, t("Saving…"));
      const nextConfig = buildBrokerProfileConfig(selectedRow.adapter, editDraft.values, selectedRow.instance);
      const wasEnabled = selectedRow.adapter.getTradingCapabilities?.(selectedRow.instance).enabled === true;
      const willEnable = selectedRow.adapter.getTradingCapabilities?.({ ...selectedRow.instance, config: nextConfig }).enabled === true;
      if (!wasEnabled && willEnable && !await confirmDialog(dialog, {
        title: "Enable trading?", body: "Orders can commit real money. Start with a simulation account. Every order needs review and confirmation; LIVE orders also need a typed confirmation. You can turn trading off in this profile at any time.",
        confirmLabel: "Enable trading", confirmVariant: "danger",
      })) return;
      await updateBrokerInstance(selectedRow.id, nextConfig, {
        label,
        enabled: editDraft.enabled,
        localOnly: editDraft.localOnly,
        replaceConfig: true,
      });
      // The row shows the saved profile.
      setEditDraft(null);
    } catch (error) {
      setRowNote(selectedRow.id, { tone: "error", text: errorText(error, t("Failed to save broker profile.")) });
    } finally {
      setBusy(null);
    }
  }, [dialog, editDraft, selectedRow, setBusy, setEditDraft, setRowNote, startRowAction, updateBrokerInstance]);

  const connectSelected = useCallback(async () => {
    if (!selectedRow) return;
    if (isSignedInBrokerProfile(selectedRow.instance)) {
      // Connecting happens in the browser, then the profile syncs what it can now see.
      const broker = signedInBrokerForProfile(selectedRow.instance, selectedRow.brokerName);
      const { id, label } = selectedRow;
      startRowAction(id, t("Connecting…"));
      try {
        // A connected broker is connected again only by a new sign-in: this renews it before the broker ends it.
        // A row that says when the sign-in ends is renewable before this session's first sync too.
        const renew = selectedRow.state === "connected" || selectedRow.signInEndsAt !== null;
        let signedIn: boolean;
        try {
          signedIn = await requestBrokerSignIn(broker, { renew });
        } catch (error) {
          setRowNote(id, {
            tone: "error",
            status: t("Sign-in failed"),
            text: errorText(error, tf("{broker} was not connected.", { broker: broker.name })),
          });
          return;
        }
        if (!signedIn) {
          // Backing out of a renewal leaves the broker connected, for now.
          setRowNote(id, {
            tone: "info",
            text: renew
              ? tf("{broker} sign-in was not renewed.", { broker: broker.name })
              : tf("{broker} was not connected.", { broker: broker.name }),
          });
          return;
        }
        try {
          await syncBrokerInstance(id);
        } catch (error) {
          setRowNote(id, { tone: "error", status: t("Sync failed"), text: errorText(error, tf("Failed to sync {label}.", { label })) });
        }
        refreshStatuses();
      } finally {
        setBusy(null);
      }
      return;
    }
    const { id, label } = selectedRow;
    try {
      startRowAction(id, t("Testing…"));
      await connectBrokerInstance(id);
      refreshStatuses();
    } catch (error) {
      setRowNote(id, { tone: "error", status: t("Connect failed"), text: errorText(error, tf("Failed to test {label}.", { label })) });
    } finally {
      setBusy(null);
    }
  }, [connectBrokerInstance, refreshStatuses, selectedRow, setBusy, setRowNote, startRowAction, syncBrokerInstance]);

  // A disabled profile is never connected or synced; b turns it back on, then syncs it.
  const enableSelected = useCallback(async () => {
    if (!selectedRow || selectedRow.instance.enabled !== false) return;
    const { id, label } = selectedRow;
    try {
      startRowAction(id, t("Enabling…"));
      const failure = await enableBrokerProfile({ updateBrokerInstance, syncBrokerInstance }, id, {
        sync: !!selectedRow.adapter,
        label,
      });
      if (failure) {
        setRowNote(id, {
          tone: "error",
          status: failure.step === "enable" ? t("Enable failed") : t("Sync failed"),
          text: failure.text,
        });
      }
      refreshStatuses();
    } finally {
      setBusy(null);
    }
  }, [refreshStatuses, selectedRow, setBusy, setRowNote, startRowAction, syncBrokerInstance, updateBrokerInstance]);

  const syncSelected = useCallback(async () => {
    if (!selectedRow) return;
    const { id, label } = selectedRow;
    try {
      startRowAction(id, t("Syncing…"));
      await syncBrokerInstance(id);
      refreshStatuses();
    } catch (error) {
      setRowNote(id, { tone: "error", status: t("Sync failed"), text: errorText(error, tf("Failed to sync {label}.", { label })) });
    } finally {
      setBusy(null);
    }
  }, [refreshStatuses, selectedRow, setBusy, setRowNote, startRowAction, syncBrokerInstance]);

  const selectedProfileActions = useMemo(
    () => selectedRow?.adapter?.getProfileActions?.(selectedRow.instance) ?? [],
    [selectedRow],
  );
  const primaryProfileAction = selectedProfileActions[0] ?? null;

  const openProfileAction = useCallback((action: BrokerProfileAction | null = primaryProfileAction) => {
    if (!action) return;
    if (action.disabled) {
      if (selectedRow) {
        setRowNote(selectedRow.id, {
          tone: "info",
          text: action.disabledReason ?? tf("{action} is unavailable for this profile.", { action: t(action.label) }),
        });
      }
      return;
    }
    if (action.paneId) showPane(action.paneId);
  }, [primaryProfileAction, selectedRow, setRowNote, showPane]);

  const removeSelected = useCallback(() => {
    if (!selectedRow) return;
    const { id, brokerName, label } = selectedRow;
    const confirm = brokerProfileRemovalConfirm(selectedRow.instance, brokerName, async () => {
      // Read when confirmed: the profile can change, or go, while the confirm is open.
      const instances = getState().config.brokerInstances;
      const instance = instances.find((entry) => entry.id === id);
      if (!instance) return;
      const nextSelectedId = neighbourBrokerProfileId(instances, id);
      try {
        startRowAction(id, t("Disconnecting…"));
        const removal = await removeBrokerProfile(instance, brokerName, removeBrokerInstance);
        setEditDraft(null);
        setDetailOpen(false);
        setSelectedId(nextSelectedId);
        setRowNote(id, null);
        setMessage(null);
        notify({ body: removal.message, type: removal.accountKept ? "info" : "success" });
      } finally {
        setBusy(null);
      }
    });
    if (openConfirmModal(confirm)) return;
    // A detached window has no confirm modal; its own dialog asks instead.
    void (async () => {
      const confirmed = await confirmDialog(dialog, {
        title: t(confirm.title),
        body: confirm.body,
        confirmLabel: t(confirm.confirmLabel),
        width: 58,
      });
      if (!confirmed) return;
      try {
        await confirm.onConfirm();
      } catch (error) {
        setRowNote(id, { tone: "error", status: t("Remove failed"), text: errorText(error, tf("Failed to remove {label}.", { label })) });
      }
    })();
  }, [dialog, getState, notify, removeBrokerInstance, selectedRow, setBusy, setDetailOpen, setEditDraft, setRowNote, setSelectedId, startRowAction]);

  return {
    busy,
    /** The add flow's running action, which has no row to show it on. */
    paneBusy: busyState && busyState.profileId === null ? busyState.text : null,
    message,
    rowActivity,
    setBusy,
    setMessage,
    setRowNote,
    startEdit,
    saveEdit,
    connectSelected,
    enableSelected,
    syncSelected,
    selectedProfileActions,
    primaryProfileAction,
    openProfileAction,
    removeSelected,
  };
}
