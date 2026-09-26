import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { ApiRequestError } from "../../../api-client/errors";
import { ConfirmDialog } from "../../../components";
import {
  buildBrokerProfileConfig,
  createBrokerProfileDraft,
  validateBrokerProfileValues,
  type BrokerProfileDraft,
} from "../../../brokers/profile-form";
import { disconnectSignedInBroker } from "../../../brokers/signed-in/client";
import { signedInBrokerForProfile } from "../../../brokers/signed-in/connect";
import { isSignedInBrokerProfile } from "../../../brokers/signed-in/profile";
import { requestBrokerSignIn } from "../../../brokers/signed-in/sign-in-dialog";
import type { BrokerProfileAction } from "../../../types/broker";
import { useDialog, type PromptContext } from "../../../ui/dialog";
import { t, tf } from "../../../i18n";
import { usePluginAppActions, usePluginBrokerActions } from "../../runtime";
import type { BrokerEditKey } from "./detail";
import type { BrokerProfileRow } from "./model";

export function useBrokerManagerActions({
  selectedRow,
  editDraft,
  setEditDraft,
  setActiveEditKey,
  setDetailOpen,
  refreshStatuses,
}: {
  selectedRow: BrokerProfileRow | null;
  editDraft: BrokerProfileDraft | null;
  setEditDraft: Dispatch<SetStateAction<BrokerProfileDraft | null>>;
  setActiveEditKey: Dispatch<SetStateAction<BrokerEditKey>>;
  setDetailOpen: Dispatch<SetStateAction<boolean>>;
  refreshStatuses: () => void;
}) {
  const dialog = useDialog();
  const { openCommandBar, showPane } = usePluginAppActions();
  const {
    connectBrokerInstance,
    updateBrokerInstance,
    syncBrokerInstance,
    removeBrokerInstance,
  } = usePluginBrokerActions();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const openAddBroker = useCallback(() => {
    openCommandBar("Add Broker Account");
  }, [openCommandBar]);

  const startEdit = useCallback(() => {
    if (!selectedRow?.adapter) {
      setMessage(t("Broker plugin is not available."));
      return;
    }
    const draft = createBrokerProfileDraft(selectedRow.adapter, selectedRow.instance);
    for (const field of selectedRow.adapter.configSchema) {
      if (field.type === "password" && draft.values[field.key]) draft.values[field.key] = "";
    }
    setEditDraft(draft);
    setActiveEditKey("label");
    setMessage(null);
    setDetailOpen(true);
  }, [selectedRow, setActiveEditKey, setDetailOpen, setEditDraft]);

  const saveEdit = useCallback(async () => {
    if (!selectedRow?.adapter || !editDraft) return;
    const label = editDraft.label.trim();
    if (!label) {
      setMessage(t("Profile label is required."));
      return;
    }
    const validationError = validateBrokerProfileValues(selectedRow.adapter, editDraft.values, selectedRow.instance);
    if (validationError) {
      setMessage(validationError);
      return;
    }

    try {
      setBusy(t("Saving…"));
      const nextConfig = buildBrokerProfileConfig(selectedRow.adapter, editDraft.values, selectedRow.instance);
      await updateBrokerInstance(selectedRow.id, nextConfig, {
        label,
        enabled: editDraft.enabled,
        replaceConfig: true,
      });
      setEditDraft(null);
      setMessage(tf("Saved {label}.", { label }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Failed to save broker profile."));
    } finally {
      setBusy(null);
    }
  }, [editDraft, selectedRow, setEditDraft, updateBrokerInstance]);

  const connectSelected = useCallback(async () => {
    if (!selectedRow) return;
    if (isSignedInBrokerProfile(selectedRow.instance)) {
      // Connecting happens in the browser, then the profile syncs what it can now see.
      const broker = signedInBrokerForProfile(selectedRow.instance, selectedRow.brokerName);
      try {
        setBusy(t("Connecting…"));
        if (!await requestBrokerSignIn(broker)) {
          setMessage(tf("{broker} was not connected.", { broker: broker.name }));
          return;
        }
        await syncBrokerInstance(selectedRow.id);
        refreshStatuses();
        setMessage(tf("Connected {broker}.", { broker: broker.name }));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : tf("Failed to sync {label}.", { label: selectedRow.label }));
      } finally {
        setBusy(null);
      }
      return;
    }
    try {
      setBusy(t("Testing…"));
      await connectBrokerInstance(selectedRow.id);
      refreshStatuses();
      setMessage(tf("Tested {label}.", { label: selectedRow.label }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : tf("Failed to test {label}.", { label: selectedRow.label }));
    } finally {
      setBusy(null);
    }
  }, [connectBrokerInstance, refreshStatuses, selectedRow, syncBrokerInstance]);

  const syncSelected = useCallback(async () => {
    if (!selectedRow) return;
    try {
      setBusy(t("Syncing…"));
      await syncBrokerInstance(selectedRow.id);
      refreshStatuses();
      setMessage(tf("Synced {label}.", { label: selectedRow.label }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : tf("Failed to sync {label}.", { label: selectedRow.label }));
    } finally {
      setBusy(null);
    }
  }, [refreshStatuses, selectedRow, syncBrokerInstance]);

  const selectedProfileActions = useMemo(
    () => selectedRow?.adapter?.getProfileActions?.(selectedRow.instance) ?? [],
    [selectedRow],
  );
  const primaryProfileAction = selectedProfileActions[0] ?? null;

  const openProfileAction = useCallback((action: BrokerProfileAction | null = primaryProfileAction) => {
    if (!action) return;
    if (action.disabled) {
      setMessage(action.disabledReason ?? tf("{action} is unavailable for this profile.", { action: t(action.label) }));
      return;
    }
    if (action.paneId) showPane(action.paneId);
  }, [primaryProfileAction, showPane]);

  const removeSelected = useCallback(async () => {
    if (!selectedRow) return;
    // The connection belongs to the Gloom account, so removing it reaches every device.
    const signedIn = isSignedInBrokerProfile(selectedRow.instance)
      ? signedInBrokerForProfile(selectedRow.instance, selectedRow.brokerName)
      : null;
    const confirmed = await dialog.prompt<boolean>({
      closeOnClickOutside: true,
      content: (ctx: PromptContext<boolean>) => (
        <ConfirmDialog
          {...ctx}
          title={t("Disconnect broker?")}
          body={[
            tf('Remove "{label}" and imported broker data?', { label: selectedRow.label }),
            t("Broker-managed portfolios, positions, and contracts will be removed."),
            ...(signedIn
              ? [tf("This also disconnects {broker} from your other devices and agents.", { broker: signedIn.name })]
              : []),
          ]}
          confirmLabel={t("Disconnect")}
          cancelLabel={t("Back")}
          width={58}
          footer={t("Enter disconnect · Esc cancel")}
        />
      ),
    }).catch(() => false);
    if (confirmed !== true) return;

    try {
      setBusy(t("Disconnecting…"));
      if (signedIn) {
        await disconnectSignedInBroker(signedIn.id).catch((error: unknown) => {
          // Already disconnected elsewhere.
          if (error instanceof ApiRequestError && error.status === 404) return;
          throw error;
        });
      }
      await removeBrokerInstance(selectedRow.id);
      setEditDraft(null);
      setDetailOpen(false);
      setMessage(tf("Removed {label}.", { label: selectedRow.label }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : tf("Failed to remove {label}.", { label: selectedRow.label }));
    } finally {
      setBusy(null);
    }
  }, [dialog, removeBrokerInstance, selectedRow, setDetailOpen, setEditDraft]);

  return {
    busy,
    message,
    setMessage,
    openAddBroker,
    startEdit,
    saveEdit,
    connectSelected,
    syncSelected,
    selectedProfileActions,
    primaryProfileAction,
    openProfileAction,
    removeSelected,
  };
}
