import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getVisibleBrokerConfigFields,
  type BrokerProfileDraft,
} from "../../../brokers/profile-form";
import { DataTableStackView } from "../../../components";
import { t } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import {
  useAppDispatch,
  useAppSelector,
  usePaneAppConfig,
} from "../../../state/app/context";
import type { BrokerAdapter } from "../../../types/broker";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
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
  const openSelectedDetailFromKeyboard = useCallback(() => {
    setEditDraft(null);
    setDetailOpen(true);
  }, [setDetailOpen]);

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

  useBrokerManagerKeyboard({
    activeEditKey,
    canOpenSelectedAction,
    canRemoveSelected,
    canUseSelectedBroker,
    connectSelected,
    detailOpen,
    editing: !!editDraft,
    editKeys,
    focused,
    hasSelectedRow,
    onActiveEditKeyChange: setActiveEditKey,
    onCancelEdit: cancelEdit,
    onOpenDetail: openSelectedDetailFromKeyboard,
    openAddBroker,
    openProfileAction,
    removeSelected,
    saveEdit,
    startEdit,
    syncSelected,
  });

  const bodyHeight = Math.max(5, height);
  const tableWidth = Math.max(24, width - 2);
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
      onActiveEditKeyChange={setActiveEditKey}
      onDraftLabelChange={updateDraftLabel}
      onDraftEnabledChange={updateDraftEnabled}
      onDraftValueChange={updateDraftValue}
      onSaveEdit={saveCurrentEdit}
      onCancelEdit={cancelEdit}
    />
  );

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
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
          onHeaderClick={() => {}}
          getItemKey={(row) => row.id}
          renderCell={renderBrokerCell}
          emptyStateTitle={t("No broker profiles.")}
          emptyStateHint={t("Add a broker profile to test connections and sync positions.")}
        />
      </Box>
    </Box>
  );
}

export const brokerManagerModule: PluginModule = {
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
};
