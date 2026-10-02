import { afterEach, describe, expect, test } from "bun:test";
import { act, useReducer, type ReactNode } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AppContext, appReducer, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { Box, ScrollBox, Text, type ScrollBoxRenderable } from "../../../ui";
import { createDefaultConfig } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import { PaneContent } from "./content";

const tui = createOpenTuiTestHarness();
let scrollRef: ScrollBoxRenderable | null = null;
let hiddenScrollRef: ScrollBoxRenderable | null = null;

afterEach(() => {
  scrollRef = null;
  hiddenScrollRef = null;
});

function emitDownArrow() {
  return act(async () => {
    tui.setup().mockInput.pressArrow("down");
    await tui.setup().renderOnce();
  });
}

async function renderHarness(component: ReactNode) {
  await act(async () => {
    await tui.render(component, { width: 30, height: 5 });
  });
  await act(async () => {
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });
}

function LongScrollPane({ width, height }: PaneProps) {
  return (
    <Box width={width} height={height}>
      <ScrollBox
        ref={(node) => {
          scrollRef = node;
        }}
        height={height}
        scrollY
        focusable={false}
      >
        <Box flexDirection="column">
          {Array.from({ length: 20 }, (_, index) => (
            <Box key={index} height={1}>
              <Text>{`Row ${index}`}</Text>
            </Box>
          ))}
        </Box>
      </ScrollBox>
    </Box>
  );
}

function HiddenMountedTabPane({ width, height }: PaneProps) {
  const renderRows = () => Array.from({ length: 20 }, (_, index) => (
    <Box key={index} height={1}>
      <Text>{`Tab row ${index}`}</Text>
    </Box>
  ));

  return (
    <Box width={width} height={height}>
      <ScrollBox
        ref={(node) => {
          scrollRef = node;
        }}
        height={height}
        scrollY
        focusable={false}
      >
        <Box flexDirection="column">{renderRows()}</Box>
      </ScrollBox>
      <Box visible={false} height={height}>
        <ScrollBox
          ref={(node) => {
            hiddenScrollRef = node;
          }}
          height={height}
          scrollY
          focusable={false}
        >
          <Box flexDirection="column">{renderRows()}</Box>
        </ScrollBox>
      </Box>
    </Box>
  );
}

function Harness({
  component = LongScrollPane,
  focused = true,
}: {
  component?: (props: PaneProps) => ReactNode;
  focused?: boolean;
}) {
  const initialState = createInitialState(createDefaultConfig("/tmp/gloomberb-pane-keyboard-scroll-test"));
  const [state, dispatch] = useReducer(appReducer, initialState);

  return (
    <AppContext value={createStaticAppStore(state, dispatch)}>
      <PaneContent
        component={component}
        paneId="test-pane:main"
        paneType="test-pane"
        focused={focused}
        width={30}
        height={5}
      />
    </AppContext>
  );
}

describe("pane keyboard scrolling", () => {
  test("scrolls the focused pane's vertical scrollbox with arrow keys", async () => {
    await renderHarness(<Harness />);

    expect(scrollRef?.scrollTop).toBe(0);
    await emitDownArrow();

    expect(scrollRef?.scrollTop).toBe(3);
  });

  test("ignores mounted scrollboxes inside hidden tabs", async () => {
    await renderHarness(<Harness component={HiddenMountedTabPane} />);

    expect(scrollRef?.scrollTop).toBe(0);
    expect(hiddenScrollRef?.scrollTop).toBe(0);
    await emitDownArrow();

    expect(scrollRef?.scrollTop).toBe(3);
    expect(hiddenScrollRef?.scrollTop).toBe(0);
  });

});
