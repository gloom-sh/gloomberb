import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../renderers/opentui/test-utils";
import {
  RemoteUiRegistryProvider,
  createRemoteUiRegistry,
  useRemoteUiNode,
} from "./semantic-tree";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let setValue: ((value: number) => void) | null = null;
let metadataReads = 0;

afterEach(async () => {
  if (!setup) return;
  await act(async () => setup?.renderer.destroy());
  setup = undefined;
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
  setup = await testRender(
    <RemoteUiRegistryProvider registry={registry}>
      <LazyMetadataNode />
    </RemoteUiRegistryProvider>,
    { width: 20, height: 4 },
  );
  await setup.renderOnce();

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

  setup = await testRender(
    <RemoteUiRegistryProvider registry={registry}>
      <DynamicNode />
    </RemoteUiRegistryProvider>,
    { width: 20, height: 4 },
  );
  await setup.renderOnce();

  const nodeId = registry.snapshot()[0]!.id;
  expect(registrations).toBe(1);
  expect(await registry.invoke(nodeId, "read")).toBe(1);

  await act(async () => {
    setValue?.(2);
    await setup!.renderOnce();
  });

  expect(registrations).toBe(1);
  expect(registry.snapshot()[0]).toMatchObject({
    label: "Value 2",
    metadata: { value: 2 },
  });
  expect(await registry.invoke(nodeId, "read")).toBe(2);
});
