import { afterEach, describe, expect, test } from "bun:test";
import { act, useEffect } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { colors } from "../../../theme/colors";
import { RemoteUiRegistryProvider, useRemoteUiRegistry, type RemoteUiRegistry } from "../../../remote/semantic-tree";
import { resolveChartPalette } from "../core/palette";
import { StaticChartSurface, buildStaticChartSeries } from "./chart-surface";
import type { ProjectedChartPoint } from "../core/data";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let remoteRegistry: RemoteUiRegistry | null = null;

afterEach(async () => {
  const setup = testSetup;
  testSetup = undefined;
  remoteRegistry = null;
  if (!setup) return;
  await act(async () => {
    setup.renderer.destroy();
  });
});

const points: ProjectedChartPoint[] = [
  { date: new Date("2026-01-01"), open: 3.5, high: 3.5, low: 3.5, close: 3.5, volume: 0 },
  { date: new Date("2026-01-02"), open: 4.1, high: 4.1, low: 4.1, close: 4.1, volume: 0 },
  { date: new Date("2026-01-03"), open: 4.9, high: 4.9, low: 4.9, close: 4.9, volume: 0 },
];

function RemoteRegistryProbe() {
  const registry = useRemoteUiRegistry();
  useEffect(() => {
    remoteRegistry = registry;
  }, [registry]);
  return null;
}

describe("StaticChartSurface", () => {
  test("aligns an index-keyed overlay to the primary observations", () => {
    const [primary, overlay] = buildStaticChartSeries(points, "line", "#00ff00", [
      { id: "secondary", color: "#ffaa00", points: [{ index: 0, value: 1 }, { index: 2, value: 3 }, { index: 9, value: 4 }] },
    ]);
    expect(primary?.timeBasis?.kind).toBe("market");
    expect(overlay?.points.map((point) => [point.date.toISOString().slice(0, 10), point.value]))
      .toEqual([["2026-01-01", 1], ["2026-01-03", 3]]);
  });

  test("renders the y-axis title with custom tick labels", async () => {
    testSetup = await testRender(
      <StaticChartSurface
        points={points}
        width={48}
        height={10}
        mode="line"
        colors={resolveChartPalette(colors, "positive")}
        yAxisLabel="Yield (%)"
        yAxisColor={colors.textDim}
        formatYAxisValue={(value) => `${value.toFixed(2)}%`}
      />,
      { width: 50, height: 12 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Yield (%)");
    expect(frame).toMatch(/\d\.\d\d%/);
  });

  test("renders custom x-axis labels and decision markers instead of dates", async () => {
    testSetup = await testRender(
      <StaticChartSurface
        points={points}
        width={56}
        height={10}
        mode="line"
        colors={resolveChartPalette(colors, "positive")}
        xAxisLabels={["0%", "50%", "100%"]}
        xMarkers={[
          { id: "current", xRatio: 0.1, label: "current", lineChar: "┊" },
          { id: "target", xRatio: 0.5, label: "target", lineChar: "┃" },
          { id: "full", xRatio: 0.8, label: "full", lineChar: "│" },
        ]}
        xAxisColor={colors.textDim}
      />,
      { width: 58, height: 12 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("0%");
    expect(frame).toContain("50%");
    expect(frame).toContain("100%");
    expect(frame).not.toContain("Jan");
    expect(frame).toContain("current");
    expect(frame).toContain("target");
    expect(frame).toContain("full");
    expect(frame).toContain("┃");
  });

  test("moves a remote-controlled cursor and labels both axes through the formatters", async () => {
    testSetup = await testRender(
      <RemoteUiRegistryProvider>
        <RemoteRegistryProbe />
        <StaticChartSurface
          points={points}
          width={48}
          height={10}
          mode="line"
          colors={resolveChartPalette(colors, "positive")}
          xAxisLabels={["0%", "50%", "100%"]}
          formatXAxisCursorValue={(ratio) => `X${Math.round(ratio * 100)}`}
          formatYAxisValue={(value) => `Y${value.toFixed(2)}`}
        />
      </RemoteUiRegistryProvider>,
      { width: 50, height: 12 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });
    const initialFrame = testSetup.captureCharFrame();
    const chartNode = remoteRegistry?.snapshot().find((node) => node.metadata?.kind === "static-chart");
    expect(chartNode?.actions).toContain("moveCursor");

    await act(async () => {
      await remoteRegistry!.invoke(chartNode!.id, "moveCursor", { x: 20, y: 4 });
    });
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).not.toBe(initialFrame);
    expect(frame).toMatch(/X\d+/);
    expect(frame).toMatch(/Y\d\.\d\d/);
  });
});
