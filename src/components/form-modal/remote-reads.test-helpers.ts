import { redactRelayResult, redactResource } from "../../plugins/builtin/cloud/terminal-relay/redact";
import type { PluginRegistry } from "../../plugins/registry";
import { createRemoteResources } from "../../remote/resources";
import type { RemoteUiRegistry } from "../../remote/semantic-tree";
import { createInitialState } from "../../state/app/context";
import { createDefaultConfig } from "../../types/config";
import { isDialogOpen } from "../../ui/dialog-stack";

/**
 * Everything remote control can read of the open form, each as one string:
 * the UI tree, every node's detail, app://form and both snapshots, as the app
 * answers (`read`) and as the relay and Ask Gloom send them on (`relayed`).
 */
export function readFormRemotely(uiRegistry: RemoteUiRegistry): { read: string; relayed: string } {
  const { getResource } = createRemoteResources({
    dispatch: () => {},
    getState: () => createInitialState(createDefaultConfig("/tmp/gloomberb-form-remote")),
    pluginRegistry: {} as PluginRegistry,
    uiRegistry,
    isDialogOpen,
  });
  const resources = [
    "ui://tree",
    "app://form",
    "app://snapshot",
    "app://snapshot/full",
    ...uiRegistry.snapshot().map((node) => `ui://node/${encodeURIComponent(node.id)}`),
  ];
  const reads = resources.map((resource) => [resource, getResource(resource)] as const);
  return {
    read: JSON.stringify(reads),
    relayed: JSON.stringify(reads.map(([resource, data]) => [resource, redactRelayResult(redactResource(resource, data))])),
  };
}
