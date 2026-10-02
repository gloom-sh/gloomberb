import { afterEach, describe, expect, test } from "bun:test";
import { act, useMemo, useState } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { openTuiUiHost } from "../../renderers/opentui/ui-host";
import {
  Box,
  Text,
  UiHostProvider,
  type UiHost,
} from "../../ui";
import { PageStackView, type PageStackViewProps } from "./page-stack-view";
import { noopRendererHost } from "../../test-support/renderer-host";

const tui = createOpenTuiTestHarness();
let setUseHost: ((useHost: boolean) => void) | undefined;
let backCalls = 0;

afterEach(() => {
  setUseHost = undefined;
  backCalls = 0;
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
    <UiHostProvider ui={ui} renderer={noopRendererHost}>
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
    await tui.render(<HostSwitchHarness />, { width: 48, height: 8 });
    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("← Back Detail title");

    await act(async () => {
      setUseHost?.(true);
      await Promise.resolve();
    });
    await act(async () => {
      await tui.setup().renderOnce();
    });
    expect(tui.frame()).toContain("Host page stack");

    await act(async () => {
      setUseHost?.(false);
      await Promise.resolve();
    });
    await act(async () => {
      await tui.setup().renderOnce();
    });
    expect(tui.frame()).toContain("← Back Detail title");
  });

  test("keeps the fallback back action mouse-accessible", async () => {
    await tui.render(<MouseBackHarness />, { width: 48, height: 8 });
    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("Detail content");

    await act(async () => {
      await tui.setup().mockMouse.click(1, 0);
      await Promise.resolve();
    });
    await act(async () => {
      await tui.setup().renderOnce();
    });

    expect(backCalls).toBe(1);
    expect(tui.frame()).toContain("Root content");
    expect(tui.frame()).not.toContain("Detail content");
  });
});
