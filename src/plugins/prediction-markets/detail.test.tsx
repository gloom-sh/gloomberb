import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../renderers/opentui/test-utils";
import {
  ChartHarness,
  GroupedDetailHarness,
  cleanupPredictionTest,
  flushFrames,
} from "./test-helpers";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  await cleanupPredictionTest(testSetup);
  testSetup = undefined;
});

describe("prediction markets detail views", () => {
  test("renders chart history even when cached dates are plain strings", async () => {
    testSetup = await testRender(
      <ChartHarness
        history={[
          { date: "2026-04-01T00:00:00Z", close: 0.45 },
          { date: "2026-04-02T00:00:00Z", close: 0.48 },
        ]}
      />,
      { width: 80, height: 12 },
    );
    await flushFrames(testSetup);

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("1M");
    expect(frame).not.toContain("TypeError");
  });

  test("renders grouped outcomes with their chart directly below", async () => {
    testSetup = await testRender(<GroupedDetailHarness />, {
      width: 64,
      height: 24,
    });
    await flushFrames(testSetup);

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Outcomes");
    expect(frame).toContain("Above 4.25%");
    expect(frame).toContain("Above 4.50%");
    expect(frame).toContain("1M");
    expect(frame.indexOf("1M")).toBeGreaterThan(frame.indexOf("Above 4.50%"));
    expect(frame).not.toContain(" Chart ");
    expect(frame).not.toContain("Ranked by implied YES probability.");
    expect(frame).not.toContain("TOP Above 4.25%");
    expect(frame).not.toContain("Kalshi");
    expect(frame).not.toContain("targets");
  });

  test("keeps grouped outcomes in place while selected detail is loading", async () => {
    testSetup = await testRender(<GroupedDetailHarness loading />, {
      width: 64,
      height: 24,
    });
    await flushFrames(testSetup);

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Outcomes");
    expect(frame).toContain("Above 4.25%");
    expect(frame).toContain("Loading chart...");
    expect(frame).not.toContain("No chart history.");
    expect(frame).not.toContain("Loading market detail...");
  });

  test("shows the chart crosshair on pointer movement", async () => {
    testSetup = await testRender(
      <ChartHarness
        history={[
          { date: "2026-04-01T00:00:00Z", close: 0.45 },
          { date: "2026-04-02T00:00:00Z", close: 0.48 },
          { date: "2026-04-03T00:00:00Z", close: 0.51 },
        ]}
      />,
      { width: 80, height: 12 },
    );
    await flushFrames(testSetup);
    const initialFrame = testSetup.captureCharFrame();

    await act(async () => {
      await testSetup!.mockMouse.moveTo(30, 5);
      await testSetup!.renderOnce();
    });
    await flushFrames(testSetup);

    expect(testSetup.captureCharFrame()).not.toBe(initialFrame);
  });

});
