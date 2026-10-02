import { afterEach, describe, expect, test } from "bun:test";
import { act, useState, type Dispatch, type SetStateAction } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { GridFieldView } from "./field-grid";

const tui = createOpenTuiTestHarness();
let setFieldActive: Dispatch<SetStateAction<boolean>> | null = null;

afterEach(() => {
  setFieldActive = null;
});

function InlineFieldHarness({ commits }: { commits: number[] }) {
  const [active, setActive] = useState(false);
  const [value, setValue] = useState(0.01);
  setFieldActive = setActive;

  return (
    <GridFieldView
      field={{
        id: "loss-cap",
        label: "Loss cap",
        value,
        percent: true,
        onValue: (nextValue) => {
          commits.push(nextValue);
          setValue(nextValue);
        },
      }}
      active={active}
      focused
      width={30}
      onFocus={() => setActive(true)}
    />
  );
}

describe("GridFieldView", () => {
  test("replaces the formatted value and commits when focus leaves the active field", async () => {
    const commits: number[] = [];
    await tui.render(<InlineFieldHarness commits={commits} />, { width: 36, height: 4 });

    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    await act(async () => {
      setFieldActive?.(true);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await tui.setup().mockInput.typeText("2");
      await tui.setup().renderOnce();
    });

    await act(async () => {
      setFieldActive?.(false);
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    expect(commits.at(-1)).toBeCloseTo(0.02);
    expect(tui.frame()).toContain("2.00");
  });

  test("submitted percentage precision stays visible and is not recommitted from rounded text", async () => {
    const commits: number[] = [];
    await tui.render(<InlineFieldHarness commits={commits} />, { width: 36, height: 4 });

    await act(async () => {
      setFieldActive?.(true);
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await tui.setup().mockInput.typeText("12.3456");
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
    });

    expect(tui.frame()).toContain("12.3456");
    expect(commits.at(-1)).toBeCloseTo(0.123456, 10);

    await act(async () => {
      setFieldActive?.(false);
      await tui.setup().renderOnce();
    });

    expect(commits.at(-1)).toBeCloseTo(0.123456, 10);
  });
});
