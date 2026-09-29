import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { emitKeypress, testRender, type TestKeyEvent } from "../../renderers/opentui/test-utils";
import { Text } from "../../ui";
import { useFieldRing, type FieldRingOptions } from "./field-ring";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let active: string | null = null;
const pressed: string[] = [];

afterEach(async () => {
  pressed.length = 0;
  if (!testSetup) return;
  await act(async () => {
    testSetup!.renderer.destroy();
  });
  testSetup = undefined;
});

function Ring(props: Pick<FieldRingOptions<string>, "wrap" | "wrapArrows">) {
  const [activeId, setActiveId] = useState<string | null>("a");
  active = activeId;
  useFieldRing({
    ids: ["a", "b", "c"],
    activeId,
    onActivate: setActiveId,
    enabled: true,
    scope: "field-ring-test",
    actions: { b: () => pressed.push("b") },
    ...props,
  });
  return <Text>{activeId ?? "none"}</Text>;
}

async function renderRing(props: Pick<FieldRingOptions<string>, "wrap" | "wrapArrows"> = {}) {
  testSetup = await testRender(<Ring {...props} />, { width: 20, height: 3 });
  await act(async () => {
    await testSetup!.renderOnce();
  });
}

/** Presses keys in one batch and says whether the last one was taken. */
async function press(...events: TestKeyEvent[]): Promise<boolean> {
  const last = await emitKeypress(testSetup!, events, { trackPropagation: true }) as { propagationStopped: boolean };
  return last.propagationStopped;
}

const TAB = { name: "tab", sequence: "\t" };
const BACKTAB = { name: "tab", sequence: "\t", shift: true };

describe("useFieldRing", () => {
  test("Tab lets go past either end, the arrows stop there, and Enter fires only a field's action", async () => {
    await renderRing();
    expect(await press(BACKTAB)).toBe(false);
    expect(active).toBe("a");
    // Two presses before the pane renders still move two fields.
    expect(await press(TAB, TAB)).toBe(true);
    expect(active).toBe("c");
    expect(await press(TAB)).toBe(false);
    expect(await press({ name: "j", sequence: "j" })).toBe(true);
    expect(active).toBe("c");
    await press({ name: "k", sequence: "k" });
    expect(await press({ name: "return", sequence: "\r" })).toBe(true);
    expect(pressed).toEqual(["b"]);
    await press({ name: "k", sequence: "k" });
    expect(await press({ name: "space", sequence: " " })).toBe(false);
  });

  test("wrap takes Tab and the arrows round; wrapArrows only the arrows", async () => {
    await renderRing({ wrap: true });
    await press(BACKTAB);
    expect(active).toBe("c");
    await press({ name: "j", sequence: "j" });
    expect(active).toBe("a");
    await act(async () => {
      testSetup!.renderer.destroy();
    });

    await renderRing({ wrapArrows: true });
    expect(await press(BACKTAB)).toBe(false);
    await press({ name: "k", sequence: "k" });
    expect(active).toBe("c");
  });
});
