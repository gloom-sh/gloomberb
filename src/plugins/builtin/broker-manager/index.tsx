import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getVisibleBrokerConfigFields,
  type BrokerProfileDraft,
} from "../../../brokers/profile-form";
import { signedInBrokerAdapter } from "../../../brokers/signed-in/adapter";
import {
  attachSignedInBrokerPersistence,
  refreshSignedInBrokers,
  resetSignedInBrokerCatalog,
} from "../../../brokers/signed-in/catalog";
import { Button, DataTableStackView, EmptyState } from "../../../components";
import { t } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import {
  useAppDispatch,
  useAppSelector,
  usePaneAppConfig,
  usePaneInstanceId,
} from "../../../state/app/context";
import type { BrokerAdapter } from "../../../types/broker";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { getCurrentPluginTarget } from "../../current-target";
import { usePluginBrokerActions, usePluginPaneState } from "../../runtime";
import type { PluginModule } from "../plugin-module";
import { BrokerDetailContent, type BrokerEditKey } from "./detail";
import { useBrokerManagerFooter } from "./footer";
import { useBrokerManagerKeyboard } from "./keyboard";
import {
  buildBrokerProfileRows,
  type BrokerProfileRow,
} from "./model";
import { useBrokerManagerActions } from "./pane-actions";
import {
  buildBrokerColumns,
  renderBrokerCell,
  type BrokerColumn,
} from "./table";

export function BrokersPane({ focused, width, height }: PaneProps) {
  const language = useAppLanguage();
  const dispatch = useAppDispatch();
  const config = usePaneAppConfig();
  const paneId = usePaneInstanceId();
  const brokerAccounts = useAppSelector((state) => state.brokerAccounts);
  const { getBrokerAdapter } = usePluginBrokerActions();
  // The profile is remembered by id so a reload lands on the same row.
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedId", null);
  const [detailOpen, setDetailOpen] = usePluginPaneState<boolean>("detailOpen", false);
  const [editDraft, setEditDraft] = useState<BrokerProfileDraft | null>(null);
  const [activeEditKey, setActiveEditKey] = useState<BrokerEditKey>("label");
  const [statusVersion, setStatusVersion] = useState(0);

  const adapters = useMemo(() => {
    const next = new Map<string, BrokerAdapter | null>();
    for (const instance of config.brokerInstances) {
      if (!next.has(instance.brokerType)) next.set(instance.brokerType, getBrokerAdapter(instance.brokerType));
    }
    return next;
  }, [config.brokerInstances, getBrokerAdapter]);

  useEffect(() => {
    const disposers = config.brokerInstances.flatMap((instance) => {
      const adapter = getBrokerAdapter(instance.brokerType);
      const dispose = adapter?.subscribeStatus?.(instance, () => setStatusVersion((version) => version + 1));
      return dispose ? [dispose] : [];
    });
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [config.brokerInstances, getBrokerAdapter]);

  const rows = useMemo(
    () => buildBrokerProfileRows(config, adapters, brokerAccounts),
    [adapters, brokerAccounts, config, language, statusVersion],
  );
  const selectedIndex = Math.max(0, rows.findIndex((row) => row.id === selectedId));
  const selectedRow = rows[selectedIndex] ?? null;
  const selectedAccounts = selectedRow ? brokerAccounts[selectedRow.id] ?? [] : [];
  const editFields = editDraft && selectedRow?.adapter
    ? getVisibleBrokerConfigFields(selectedRow.adapter, editDraft.values)
    : [];
  const editKeys = useMemo<BrokerEditKey[]>(
    () => ["label", "enabled", ...editFields.map((field) => field.key)],
    [editFields],
  );
  const editSelectKeys = useMemo<ReadonlySet<BrokerEditKey>>(
    () => new Set(["enabled", ...editFields.filter((field) => field.type === "select").map((field) => field.key)]),
    [editFields],
  );
  const editScope = `broker-edit:${paneId}`;

  useEffect(() => {
    if (rows.length === 0 && detailOpen) setDetailOpen(false);
  }, [detailOpen, rows.length, setDetailOpen]);

  useEffect(() => {
    if (!editDraft) return;
    if (!editKeys.includes(activeEditKey)) setActiveEditKey(editKeys[0] ?? "label");
  }, [activeEditKey, editDraft, editKeys]);

  useEffect(() => {
    if (!focused || !editDraft) return;
    dispatch({ type: "SET_INPUT_CAPTURED", captured: true });
    return () => {
      dispatch({ type: "SET_INPUT_CAPTURED", captured: false });
    };
  }, [dispatch, editDraft, focused]);

  const refreshStatuses = useCallback(() => {
    setStatusVersion((version) => version + 1);
  }, []);

  const {
    busy,
    message,
    openAddBroker,
    startEdit,
    saveEdit,
    connectSelected,
    syncSelected,
    selectedProfileActions,
    openProfileAction,
    removeSelected,
  } = useBrokerManagerActions({
    selectedRow,
    editDraft,
    setEditDraft,
    setActiveEditKey,
    setDetailOpen,
    refreshStatuses,
  });

  const hasSelectedRow = selectedRow !== null;
  const selectedHasAdapter = !!selectedRow?.adapter;
  const canUseSelectedBroker = selectedHasAdapter && !busy;
  const canOpenSelectedAction = selectedProfileActions.some((action) => !action.disabled && action.paneId);
  const canRemoveSelected = hasSelectedRow && !busy;
  const cancelEdit = useCallback(() => setEditDraft(null), []);

  useBrokerManagerFooter({
    busy,
    message,
    actions: {
      connectSelected,
      openAddBroker,
      openProfileAction,
      removeSelected,
      saveEdit,
      startEdit,
      syncSelected,
    },
    canOpenSelectedAction,
    canRemoveSelected,
    canUseSelectedBroker,
    editing: !!editDraft,
  });

  const cycleEditSelect = useCallback((key: BrokerEditKey, direction: -1 | 1) => {
    if (key === "enabled") {
      setEditDraft((current) => current ? { ...current, enabled: !current.enabled } : current);
      return;
    }
    const options = editFields.find((field) => field.key === key)?.options ?? [];
    if (options.length === 0) return;
    setEditDraft((current) => {
      if (!current) return current;
      const index = options.findIndex((option) => option.value === current.values[key]);
      const next = options[index < 0 ? 0 : (index + direction + options.length) % options.length];
      return next ? { ...current, values: { ...current.values, [key]: next.value } } : current;
    });
  }, [editFields]);

  useBrokerManagerKeyboard({
    activeEditKey,
    editing: !!editDraft,
    editKeys,
    focused,
    scope: editScope,
    selectKeys: editSelectKeys,
    onActiveEditKeyChange: setActiveEditKey,
    onCancelEdit: cancelEdit,
    onCycleSelect: cycleEditSelect,
    saveEdit,
  });

  const bodyHeight = Math.max(5, height);
  const tableWidth = Math.max(24, width);
  const columns = useMemo(() => buildBrokerColumns(tableWidth), [language, tableWidth]);

  const openSelectedDetail = useCallback((_index: number, row: BrokerProfileRow) => {
    setSelectedId(row.id);
    setEditDraft(null);
    setDetailOpen(true);
  }, [setDetailOpen, setSelectedId]);

  const selectBrokerRow = useCallback((_index: number, row: BrokerProfileRow) => {
    setSelectedId(row.id);
    if (selectedRow?.id !== row.id) {
      setEditDraft(null);
    }
  }, [selectedRow?.id, setSelectedId]);

  const updateDraftValue = useCallback((key: string, value: string) => {
    setEditDraft((current) => current
      ? { ...current, values: { ...current.values, [key]: value } }
      : current);
  }, []);

  const updateDraftLabel = useCallback((label: string) => {
    setEditDraft((current) => current ? { ...current, label } : current);
  }, []);

  const updateDraftEnabled = useCallback((enabled: boolean) => {
    setEditDraft((current) => current ? { ...current, enabled } : current);
  }, []);

  const saveCurrentEdit = useCallback(() => {
    saveEdit().catch(() => {});
  }, [saveEdit]);

  // The detail insets one cell each side like the table cells.
  const detailContentWidth = Math.max(24, tableWidth - 2);
  const detailContent = (
    <BrokerDetailContent
      row={selectedRow}
      accounts={selectedAccounts}
      editDraft={editDraft}
      editFields={editFields}
      activeEditKey={activeEditKey}
      busy={busy}
      message={message}
      width={detailContentWidth}
      editScope={editScope}
      paneFocused={focused}
      onActiveEditKeyChange={setActiveEditKey}
      onDraftLabelChange={updateDraftLabel}
      onDraftEnabledChange={updateDraftEnabled}
      onDraftValueChange={updateDraftValue}
      onSaveEdit={saveCurrentEdit}
      onCancelEdit={cancelEdit}
    />
  );

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box height={bodyHeight} overflow="hidden">
        <DataTableStackView<BrokerProfileRow, BrokerColumn>
          focused={focused}
          detailOpen={detailOpen && !!selectedRow}
          onBack={() => {
            setEditDraft(null);
            setDetailOpen(false);
          }}
          detailContent={detailContent}
          detailTitle={selectedRow?.label}
          rootWidth={tableWidth}
          rootHeight={bodyHeight}
          selection={{
            kind: "index",
            selectedIndex,
            onChange: (index, row) => selectBrokerRow(index, row),
          }}
          onActivate={(row, index) => openSelectedDetail(index, row)}
          columns={columns}
          items={rows}
          sortColumnId={null}
          sortDirection="asc"
          getItemKey={(row) => row.id}
          renderCell={renderBrokerCell}
          emptyContent={(
            <Box width="100%" paddingX={1} paddingY={1}>
              <EmptyState
                title={t("No broker profiles.")}
                hint={t("Add a broker profile to test connections and sync positions.")}
                actions={<Button label={t("Add broker")} variant="primary" compact onPress={openAddBroker} />}
              />
            </Box>
          )}
          emptyStateTitle={t("No broker profiles.")}
        />
      </Box>
    </Box>
  );
}

export const brokerManagerModule: PluginModule = {
  broker: signedInBrokerAdapter,
  panes: [
    {
      id: "brokers",
      name: "Brokers",
      icon: "B",
      component: BrokersPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 92, height: 24 },
      portableShare: {
        private: { title: true, params: true, settings: true, state: true },
      },
    },
  ],
  paneTemplates: [
    {
      id: "brokers-pane",
      paneId: "brokers",
      label: "Brokers",
      description: "Open broker profiles and connection status",
      keywords: ["broker", "brokers", "connection", "status"],
      shortcut: { prefix: "BR" },
      createInstance: () => ({ placement: "floating" }),
    },
  ],

  setup(ctx) {
    attachSignedInBrokerPersistence(ctx.persistence);
    // The app fetches the connector list; a CLI run and the desktop's Bun half read the saved one.
    if (getCurrentPluginTarget() !== "cli") void refreshSignedInBrokers();

    ctx.registerCommand({
      id: "open-brokers",
      label: "Open Brokers",
      description: "Manage broker profiles and connection status",
      keywords: ["broker", "brokers", "connection", "accounts", "sync"],
      category: "navigation",
      execute: () => {
        ctx.showPane("brokers");
      },
    });
  },

  dispose() {
    resetSignedInBrokerCatalog();
  },
};
