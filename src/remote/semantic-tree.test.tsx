import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { Button } from "../components/ui/button";
import { Box, Text } from "../ui";
import {
  RemoteUiRegistryProvider,
  RemoteUiScope,
  createRemoteUiRegistry,
  useRemoteUiNode,
} from "./semantic-tree";

const tui = createOpenTuiTestHarness();
let setValue: ((value: number) => void) | null = null;
let metadataReads = 0;

afterEach(() => {
  setValue = null;
  metadataReads = 0;
});

function LazyMetadataNode() {
  useRemoteUiNode({
    role: "table",
    getMetadata: () => {
      metadataReads += 1;
      return { rowCount: 200 };
    },
  });
  return <text>table</text>;
}

function DynamicNode() {
  const [value, updateValue] = useState(1);
  setValue = updateValue;
  useRemoteUiNode({
    role: "button",
    label: `Value ${value}`,
    actions: { read: () => value },
    metadata: { value },
  });
  return <text>{value}</text>;
}

test("semantic registry rejects non-function actions consistently", async () => {
  const registry = createRemoteUiRegistry();
  registry.register("invalid", {
    role: "button",
    actions: { broken: "not-a-function" as unknown as () => void },
  });

  expect(registry.snapshot()[0]?.actions).toEqual([]);
  await expect(registry.invoke("invalid", "broken")).rejects.toThrow(
    'UI node "invalid" does not expose action "broken".',
  );
});

test("semantic metadata is projected only when a remote snapshot requests it", async () => {
  const registry = createRemoteUiRegistry();
  await tui.render(
    <RemoteUiRegistryProvider registry={registry}>
      <LazyMetadataNode />
    </RemoteUiRegistryProvider>,
    { width: 20, height: 4 },
  );
  await tui.setup().renderOnce();

  expect(metadataReads).toBe(0);
  expect(registry.snapshot()[0]?.metadata).toEqual({ rowCount: 200 });
  expect(metadataReads).toBe(1);
});

test("semantic nodes keep current behavior without re-registering on every render", async () => {
  const registry = createRemoteUiRegistry();
  const register = registry.register.bind(registry);
  let registrations = 0;
  registry.register = (id, registration) => {
    registrations += 1;
    register(id, registration);
  };

  await tui.render(
    <RemoteUiRegistryProvider registry={registry}>
      <DynamicNode />
    </RemoteUiRegistryProvider>,
    { width: 20, height: 4 },
  );
  await tui.setup().renderOnce();

  const nodeId = registry.snapshot()[0]!.id;
  expect(registrations).toBe(1);
  expect(await registry.invoke(nodeId, "read")).toBe(1);

  await act(async () => {
    setValue?.(2);
    await tui.setup().renderOnce();
  });

  expect(registrations).toBe(1);
  expect(registry.snapshot()[0]).toMatchObject({
    label: "Value 2",
    metadata: { value: 2 },
  });
  expect(await registry.invoke(nodeId, "read")).toBe(2);
});

test("a prompt's scope reaches every control drawn in it, and a kit button is in the tree once", async () => {
  const registry = createRemoteUiRegistry();
  await tui.render(
    <RemoteUiRegistryProvider registry={registry}>
      <RemoteUiScope scope="askg-prompt">
        <Box flexDirection="column">
          <Button label="Approve" onPress={() => {}} />
          <Box height={1} onMouseDown={() => {}}><Text>row</Text></Box>
          <Text onMouseDown={() => {}}>{"link"}</Text>
        </Box>
      </RemoteUiScope>
    </RemoteUiRegistryProvider>,
    { width: 30, height: 4 },
  );

  expect(registry.snapshot().map((node) => [node.role, node.label ?? null, node.metadata?.scope])).toEqual([
    ["button", "Approve", "askg-prompt"],
    ["box", null, "askg-prompt"],
    ["text", "link", "askg-prompt"],
  ]);
});

test("a node's detail is read for that node alone, never with the tree", () => {
  const registry = createRemoteUiRegistry();
  let rowsRead = 0;
  registry.register("ui:table", {
    role: "table",
    metadata: { rowCount: 2 },
    getDetail: () => {
      rowsRead += 1;
      return { rows: [{ key: "AAPL" }, { key: "MSFT" }] };
    },
  });

  expect(registry.snapshot()[0]?.metadata).toEqual({ rowCount: 2 });
  expect(rowsRead).toBe(0);
  expect(registry.detail("ui:table")?.metadata).toEqual({ rowCount: 2, rows: [{ key: "AAPL" }, { key: "MSFT" }] });
  expect(registry.detail("ui:gone")).toBeNull();
});
