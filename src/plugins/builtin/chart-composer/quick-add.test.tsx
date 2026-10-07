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
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import {
  UiHostProvider,
  useNativeRenderer,
  useRendererHost,
  useUiHost,
} from "../../../ui";
import { useShortcut } from "../../../react/input";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createDefaultConfig } from "../../../types/config";
import type { ChartSpec } from "../../../time-series/types";
import { buildPriceChartPreset } from "./presets";
import { ChartSeriesQuickAdd, isChartQuickAddMouseTarget } from "./quick-add";

const tui = createOpenTuiTestHarness();
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

const emitKey = (name: string, sequence: string) => tui.emitKeypress({ name, sequence }, { trackPropagation: true });
const { waitForFrameToContain, waitForFrameToExclude } = tui;

afterEach(() => {
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

    await tui.render(
      <AppContext.Provider value={createStaticAppStore(initial)}>
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
      await tui.setup().renderOnce();
    });
    expect(tui.frame()).toContain("add series");
    expect(renderedWidth).toBe(14);

    await emitKey("n", "n");
    await act(async () => {
      await tui.setup().mockInput.typeText("MSFT revenue");
      await tui.setup().renderOnce();
    });
    expect(tui.frame()).toContain("MSFT revenue");
    await waitForFrameToContain("MSFT · Revenue");
    expect(renderedWidth).toBe(36);

    await act(async () => {
      await tui.setup().mockMouse.click(2, 1);
      await tui.setup().renderOnce();
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

    await tui.render(
      <AppContext.Provider value={createStaticAppStore(initial)}>
        <CaptureInputProvider>
          <Harness />
        </CaptureInputProvider>
      </AppContext.Provider>,
      { width: 92, height: 8 },
    );

    await act(async () => {
      await tui.setup().renderOnce();
    });
    await emitKey("n", "n");
    expect(activeStates.at(-1)).toBe(true);

    await act(async () => {
      capturedInputProps?.onBlur?.();
      await Bun.sleep(10);
      await tui.setup().renderOnce();
    });
    expect(activeStates.at(-1)).toBe(false);

    await emitKey("s", "s");
    expect(seriesShortcutCount).toBe(1);
  });
});
