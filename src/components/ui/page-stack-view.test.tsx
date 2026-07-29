import { afterEach, describe, expect, test } from "bun:test";
import { act, useMemo, useState } from "react";
import { testRender } from "../../renderers/opentui/test-utils";
import { openTuiUiHost } from "../../renderers/opentui/ui-host";
import {
  Box,
  Text,
  UiHostProvider,
  type RendererHost,
  type UiHost,
} from "../../ui";
import { PageStackView, type PageStackViewProps } from "./page-stack-view";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let setUseHost: ((useHost: boolean) => void) | undefined;
let backCalls = 0;

const rendererHost: RendererHost = {
  requestExit() {},
  openExternal: async () => {},
  copyText: async () => {},
  readText: async () => "",
  notify() {},
};

afterEach(async () => {
  setUseHost = undefined;
  backCalls = 0;
  if (!testSetup) return;
  await act(async () => {
    testSetup!.renderer.destroy();
  });
  testSetup = undefined;
});

function HostPageStackView({ detailContent }: PageStackViewProps) {
  return (
    <Box flexDirection="column">
      <Text>Host page stack</Text>
      {detailContent}
    </Box>
  );
}

function HostSwitchHarness() {
  const [useHost, updateUseHost] = useState(false);
  setUseHost = updateUseHost;
  const ui = useMemo<UiHost>(() => ({
    ...openTuiUiHost,
    PageStackView: useHost ? HostPageStackView : undefined,
  }), [useHost]);

  return (
    <UiHostProvider ui={ui} renderer={rendererHost}>
      <PageStackView
        focused
        detailOpen
        onBack={() => {}}
        rootContent={<Text>Root content</Text>}
        detailContent={<Text>Detail content</Text>}
        detailTitle="Detail title"
      />
    </UiHostProvider>
  );
}

function MouseBackHarness() {
  const [detailOpen, setDetailOpen] = useState(true);
  return (
    <PageStackView
      focused
      detailOpen={detailOpen}
      onBack={() => {
        backCalls += 1;
        setDetailOpen(false);
      }}
      rootContent={<Text>Root content</Text>}
      detailContent={<Text>Detail content</Text>}
      detailTitle="Detail title"
    />
  );
}

describe("PageStackView", () => {
  test("can switch between the fallback and host implementations without changing hook topology", async () => {
    testSetup = await testRender(<HostSwitchHarness />, { width: 48, height: 8 });
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("← Back Detail title");

    await act(async () => {
      setUseHost?.(true);
      await Promise.resolve();
    });
    await act(async () => {
      await testSetup!.renderOnce();
    });
    expect(testSetup.captureCharFrame()).toContain("Host page stack");

    await act(async () => {
      setUseHost?.(false);
      await Promise.resolve();
    });
    await act(async () => {
      await testSetup!.renderOnce();
    });
    expect(testSetup.captureCharFrame()).toContain("← Back Detail title");
  });

  test("keeps the fallback back action mouse-accessible", async () => {
    testSetup = await testRender(<MouseBackHarness />, { width: 48, height: 8 });
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Detail content");

    await act(async () => {
      await testSetup!.mockMouse.click(1, 0);
      await Promise.resolve();
    });
    await act(async () => {
      await testSetup!.renderOnce();
    });

    expect(backCalls).toBe(1);
    expect(testSetup.captureCharFrame()).toContain("Root content");
    expect(testSetup.captureCharFrame()).not.toContain("Detail content");
  });
});
