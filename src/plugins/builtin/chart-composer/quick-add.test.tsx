import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  createElement,
  forwardRef,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import {
  UiHostProvider,
  useNativeRenderer,
  useRendererHost,
  useUiHost,
} from "../../../ui";
import { useShortcut } from "../../../react/input";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import type { ChartSpec } from "../../../time-series/types";
import { buildPriceChartPreset } from "./presets";
import {
  blurActiveQuickAddElement,
  ChartSeriesQuickAdd,
  isChartQuickAddMouseTarget,
} from "./quick-add";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let capturedInputProps: Record<string, any> | null = null;

function CaptureInputProvider({ children }: { children: ReactNode }) {
  const baseUi = useUiHost();
  const renderer = useRendererHost();
  const nativeRenderer = useNativeRenderer();
  const CapturingInput = useMemo(() => {
    const BaseInput = baseUi.Input;
    return forwardRef<any, Record<string, any>>(function CapturingInput(props, ref) {
      capturedInputProps = props;
      return createElement(BaseInput as any, { ...props, ref });
    });
  }, [baseUi]);
  const ui = useMemo(() => ({ ...baseUi, Input: CapturingInput }), [CapturingInput, baseUi]);
  return (
    <UiHostProvider ui={ui} renderer={renderer} nativeRenderer={nativeRenderer}>
      {children}
    </UiHostProvider>
  );
}

async function emitKey(name: string, sequence: string) {
  await act(async () => {
    (testSetup!.renderer as any).keyInput.emit("keypress", {
      name,
      sequence,
      ctrl: false,
      meta: false,
      super: false,
      option: false,
      shift: false,
      eventType: "press",
      repeated: false,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
    });
    await testSetup!.renderOnce();
  });
}

async function waitForFrameToContain(text: string, attempts = 12): Promise<string> {
  let frame = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await act(async () => {
      await Bun.sleep(10);
      await testSetup!.renderOnce();
    });
    frame = testSetup!.captureCharFrame();
    if (frame.includes(text)) return frame;
  }
  return frame;
}

async function waitForFrameToExclude(text: string, attempts = 12): Promise<string> {
  let frame = testSetup!.captureCharFrame();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!frame.includes(text)) return frame;
    await act(async () => {
      await Bun.sleep(10);
      await testSetup!.renderOnce();
    });
    frame = testSetup!.captureCharFrame();
  }
  return frame;
}

afterEach(async () => {
  if (!testSetup) return;
  await act(async () => {
    testSetup!.renderer.destroy();
  });
  testSetup = undefined;
  capturedInputProps = null;
});

describe("chart series inline quick add", () => {
  test("distinguishes its own drawer from outside desktop clicks", () => {
    const ownRoot = {
      getAttribute: (name: string) => name === "data-gloom-chart-quick-add" ? "chart-a" : null,
    };
    const otherRoot = {
      getAttribute: (name: string) => name === "data-gloom-chart-quick-add" ? "chart-b" : null,
    };

    expect(isChartQuickAddMouseTarget({ closest: () => ownRoot }, "chart-a")).toBe(true);
    expect(isChartQuickAddMouseTarget({ closest: () => otherRoot }, "chart-a")).toBe(false);
    expect(isChartQuickAddMouseTarget({ closest: () => null }, "chart-a")).toBe(false);
  });

  test("stays visible and adds a smart ticker-metric suggestion", async () => {
    const initial = createInitialState(createDefaultConfig("/tmp/gloomberb-chart-quick-add"));
    const startingSpec = buildPriceChartPreset("AAPL");
    let updatedSpec: ChartSpec | undefined;
    let renderedWidth = 0;

    testSetup = await testRender(
      <AppContext.Provider value={{ state: initial, dispatch: () => {} }}>
        <ChartSeriesQuickAdd
          spec={startingSpec}
          setSpec={(next) => {
            updatedSpec = next;
          }}
          focused
          width={92}
          height={8}
          shortcutEnabled
          shortcutBlocked={false}
          onActivatePane={() => {}}
          onWidthChange={(width) => {
            renderedWidth = width;
          }}
        />
      </AppContext.Provider>,
      { width: 92, height: 8 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
    });
    expect(testSetup.captureCharFrame()).toContain("add series");
    expect(renderedWidth).toBe(14);

    await emitKey("n", "n");
    await act(async () => {
      await testSetup!.mockInput.typeText("MSFT revenue");
      await testSetup!.renderOnce();
    });
    expect(testSetup.captureCharFrame()).toContain("MSFT revenue");
    expect(await waitForFrameToContain("MSFT · Revenue")).toContain("MSFT · Revenue");
    expect(renderedWidth).toBe(36);

    await act(async () => {
      await testSetup!.mockMouse.click(2, 1);
      await testSetup!.renderOnce();
    });
    expect(updatedSpec?.series).toHaveLength(2);
    expect(updatedSpec?.series[1]?.source).toMatchObject({
      kind: "security",
      instrument: { symbol: "MSFT" },
      fieldId: "fundamental.totalRevenue",
      timestampMode: "available-at",
    });
    expect(updatedSpec?.series[1]).toMatchObject({
      style: "columns",
      interpolation: "none",
      panelId: "fundamentals",
    });
    expect(updatedSpec?.panels.find((panel) => panel.id === "fundamentals")).toMatchObject({
      label: "Fundamentals",
      height: 0.35,
    });

    const closedFrame = await waitForFrameToExclude("MSFT · Revenue");
    expect(closedFrame).toContain("add series");
    expect(closedFrame).not.toContain("MSFT · Revenue");
    expect(renderedWidth).toBe(14);
  });

  test("gives up the DOM focus it left behind when it closes", () => {
    let blurred = 0;
    const element = {
      blur: () => { blurred += 1; },
      closest: (selector: string) => selector === "[data-gloom-chart-quick-add]"
        ? { getAttribute: () => "chart-a" }
        : null,
    };
    const globals = globalThis as { document?: unknown };
    const previous = globals.document;
    globals.document = { activeElement: element };
    try {
      // The handle can only reach the element it owns; the focus can outlive it.
      expect(isChartQuickAddMouseTarget(element, "chart-a")).toBe(true);
      blurActiveQuickAddElement("chart-a");
      expect(blurred).toBe(1);
      blurActiveQuickAddElement("chart-b");
      expect(blurred).toBe(1);
    } finally {
      globals.document = previous;
    }
  });

  test("puts itself away when the pane reports the pointer went elsewhere", async () => {
    const initial = createInitialState(createDefaultConfig("/tmp/gloomberb-chart-quick-add-dismiss"));
    const startingSpec = buildPriceChartPreset("AAPL");
    const activeStates: boolean[] = [];
    let dismiss: (() => void) | null = null;

    function Harness() {
      const [dismissSignal, setDismissSignal] = useState(0);
      dismiss = () => setDismissSignal((current) => current + 1);
      return (
        <ChartSeriesQuickAdd
          spec={startingSpec}
          setSpec={() => {}}
          focused
          width={92}
          height={8}
          shortcutEnabled
          shortcutBlocked={false}
          dismissSignal={dismissSignal}
          onActivatePane={() => {}}
          onActiveChange={(active) => activeStates.push(active)}
        />
      );
    }

    testSetup = await testRender(
      <AppContext.Provider value={{ state: initial, dispatch: () => {} }}>
        <CaptureInputProvider>
          <Harness />
        </CaptureInputProvider>
      </AppContext.Provider>,
      { width: 92, height: 8 },
    );
    await act(async () => testSetup!.renderOnce());
    await emitKey("n", "n");
    expect(activeStates.at(-1)).toBe(true);

    await act(async () => {
      dismiss?.();
      await testSetup!.renderOnce();
    });
    expect(activeStates.at(-1)).toBe(false);
  });

  test("releases focus capture when the input blurs", async () => {
    const initial = createInitialState(createDefaultConfig("/tmp/gloomberb-chart-quick-add-blur"));
    const startingSpec = buildPriceChartPreset("AAPL");
    const activeStates: boolean[] = [];
    let seriesShortcutCount = 0;

    function Harness() {
      const [capturing, setCapturing] = useState(false);
      const handleActiveChange = useCallback((active: boolean) => {
        activeStates.push(active);
        setCapturing(active);
      }, []);
      useShortcut((event) => {
        if (event.name === "s") seriesShortcutCount += 1;
      }, { enabled: !capturing });
      return (
        <ChartSeriesQuickAdd
          spec={startingSpec}
          setSpec={() => {}}
          focused
          width={92}
          height={8}
          shortcutEnabled
          shortcutBlocked={false}
          onActivatePane={() => {}}
          onActiveChange={handleActiveChange}
        />
      );
    }

    testSetup = await testRender(
      <AppContext.Provider value={{ state: initial, dispatch: () => {} }}>
        <CaptureInputProvider>
          <Harness />
        </CaptureInputProvider>
      </AppContext.Provider>,
      { width: 92, height: 8 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
    });
    await emitKey("n", "n");
    expect(activeStates.at(-1)).toBe(true);

    await act(async () => {
      capturedInputProps?.onBlur?.();
      await Bun.sleep(10);
      await testSetup!.renderOnce();
    });
    expect(activeStates.at(-1)).toBe(false);

    await emitKey("s", "s");
    expect(seriesShortcutCount).toBe(1);
  });
});
