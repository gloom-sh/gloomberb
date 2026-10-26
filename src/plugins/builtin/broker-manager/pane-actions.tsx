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
import { useRowNotes } from "../../../components/ui/row-notes";
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
}

/**
 * The parts of a row a real change moves: its state, its status message and
 * when it last synced. Not the status's `updatedAt`, which an adapter may
 * stamp on every read, nor a sign-in's end, which the pane reads on its own.
 */
function rowSignature(row: BrokerProfileRow): string {
  return [row.state, row.stateLabel, row.message, row.lastSyncedAt].join("\0");
}
const rowKey = (row: BrokerProfileRow) => row.id;

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
  rows,
  selectedRow,
  editDraft,
  setEditDraft,
  setActiveEditKey,
  setDetailOpen,
  setSelectedId,
  refreshStatuses,
}: {
  rows: readonly BrokerProfileRow[];
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
  // What stops the open edit form from saving, said beside its Save.
  const [editError, setEditError] = useState<string | null>(null);
  // A note takes the row as it is when the note first shows, with the status
  // the failure left, and goes when that row moves on: a new state, message or sync.
  const { noteFor, setNote: setRowNote } = useRowNotes<BrokerProfileRow, BrokerRowNote>(rows, { key: rowKey, signature: rowSignature });
  /** Starts an action on a profile: its row says so, in place of the last one's result. */
  const startRowAction = useCallback((profileId: string, text: string) => {
    setRowNote(profileId, null);
    setBusy(text, profileId);
  }, [setBusy, setRowNote]);
  const rowActivity = useCallback((row: BrokerProfileRow): BrokerRowActivity => ({
    busy: busyState?.profileId === row.id ? busyState.text : null,
    note: noteFor(row),
  }), [busyState, noteFor]);

  const startEdit = useCallback(() => {
    if (!selectedRow?.adapter) return;
    const draft = createBrokerProfileDraft(selectedRow.adapter, selectedRow.instance);
    for (const field of selectedRow.adapter.configSchema) {
      if (field.type === "password" && draft.values[field.key]) draft.values[field.key] = "";
    }
    setEditDraft(draft);
    setActiveEditKey("label");
    setEditError(null);
    setMessage(null);
    setDetailOpen(true);
  }, [selectedRow, setActiveEditKey, setDetailOpen, setEditDraft]);

  // The form goes, and what it said with it.
  const cancelEdit = useCallback(() => {
    setEditDraft(null);
    setEditError(null);
    setMessage(null);
  }, [setEditDraft]);

  // What stops a save is about the open form, so it is said beside its Save, not on the row.
  const saveEdit = useCallback(async () => {
    if (!selectedRow?.adapter || !editDraft) return;
    setMessage(null);
    const label = editDraft.label.trim();
    if (!label) {
      setEditError(t("Profile label is required."));
      return;
    }
    const validationError = validateBrokerProfileValues(selectedRow.adapter, editDraft.values, selectedRow.instance);
    if (validationError) {
      setEditError(validationError);
      return;
    }
    setEditError(null);

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
      setEditError(errorText(error, t("Failed to save broker profile.")));
    } finally {
      setBusy(null);
    }
  }, [dialog, editDraft, selectedRow, setBusy, setEditDraft, startRowAction, updateBrokerInstance]);

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
    // A removal that failed is said on the profile's row while it has one.
    // Once the row is gone, only a toast can say it.
    const listed = () => getState().config.brokerInstances.some((entry) => entry.id === id);
    const failureText = (error: unknown) => errorText(error, tf("Failed to remove {label}.", { label }));
    const toastIfGone = (error: unknown) => {
      if (!listed()) notify({ body: failureText(error), type: "error" });
    };
    const confirm = {
      ...brokerProfileRemovalConfirm(selectedRow.instance, brokerName, async () => {
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
        } catch (error) {
          // An open confirm says it inline too; the row keeps it once that closes.
          if (listed()) setRowNote(id, { tone: "error", status: t("Remove failed"), text: failureText(error) });
          throw error;
        } finally {
          setBusy(null);
        }
      }),
      onFailureAfterClose: toastIfGone,
    };
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
        toastIfGone(error);
      }
    })();
  }, [dialog, getState, notify, removeBrokerInstance, selectedRow, setBusy, setDetailOpen, setEditDraft, setRowNote, setSelectedId, startRowAction]);

  return {
    busy,
    /** The add flow's running action, which has no row to show it on. */
    paneBusy: busyState && busyState.profileId === null ? busyState.text : null,
    message,
    editError,
    rowActivity,
    setBusy,
    setMessage,
    setRowNote,
    startEdit,
    cancelEdit,
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
