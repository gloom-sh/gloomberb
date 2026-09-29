import { expect, test } from "bun:test";
import type { PluginRegistry } from "../../plugins/registry";
import { createDefaultConfig, type BrokerInstanceConfig, type LayoutConfig } from "../../types/config";
import { activatePickerSelectionAction } from "./picker-activation";
import type { OpenInlineConfirm } from "./routing/confirm";
import type { CommandBarCollectionWorkflowActions } from "./workflow/collection-actions";

function confirmDisconnect(instance: BrokerInstanceConfig): string[] {
  const config = { ...createDefaultConfig("/tmp/gloomberb-picker-disconnect"), brokerInstances: [instance] };
  let body: string[] = [];
  const openInlineConfirm: OpenInlineConfirm = (options) => {
    body = options.body;
  };
  activatePickerSelectionAction({
    closeAll: () => {},
    collectionWorkflowActions: {} as CommandBarCollectionWorkflowActions,
    executeCollectionCommand: async () => {},
    layout: {} as LayoutConfig,
    openInlineConfirm,
    persistLayoutChange: () => {},
    pluginRegistry: { getConfigFn: () => config } as unknown as PluginRegistry,
    route: {
      kind: "picker",
      pickerId: "disconnect-broker",
      title: "Disconnect Broker Account",
      query: "",
      selectedIdx: 0,
      hoveredIdx: null,
      options: [{ id: instance.id, label: instance.label }],
    },
    selectedId: instance.id,
  });
  return body;
}

test("disconnecting a signed-in profile warns that the account-wide connection goes too", () => {
  const signedIn: BrokerInstanceConfig = { id: "ibkr-main", brokerType: "signed-in", label: "IBKR", connectionMode: "ibkr", config: {} };
  expect(confirmDisconnect(signedIn)).toEqual([
    'Remove "IBKR" and imported broker data?',
    "Broker-managed portfolios, positions, and contracts will be removed.",
    "This also disconnects IBKR from your other devices and agents.",
  ]);

  const flex: BrokerInstanceConfig = { id: "ibkr-flex", brokerType: "ibkr", label: "IBKR Flex", connectionMode: "flex", config: {} };
  expect(confirmDisconnect(flex)).toEqual([
    'Remove "IBKR Flex" and imported broker data?',
    "Broker-managed portfolios, positions, and contracts will be removed.",
  ]);
});
