import { afterEach, describe, expect, test } from "bun:test";
import { act, useState, type Dispatch, type SetStateAction } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { GridFieldView } from "../../../components";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let setFieldActive: Dispatch<SetStateAction<boolean>> | null = null;

afterEach(async () => {
  setFieldActive = null;
  if (!testSetup) return;
  await act(async () => {
    testSetup!.renderer.destroy();
  });
  testSetup = undefined;
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
    testSetup = await testRender(<InlineFieldHarness commits={commits} />, { width: 36, height: 4 });

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    await act(async () => {
      setFieldActive?.(true);
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    await act(async () => {
      await testSetup!.mockInput.typeText("2");
      await testSetup!.renderOnce();
    });

    await act(async () => {
      setFieldActive?.(false);
      await testSetup!.renderOnce();
    });

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(commits.at(-1)).toBeCloseTo(0.02);
    expect(testSetup.captureCharFrame()).toContain("2.00");
  });
});


test("submitted percentage precision stays visible and is not recommitted from rounded text", async () => {
  const commits:number[]=[];
  testSetup=await testRender(<InlineFieldHarness commits={commits}/>,{width:36,height:4});
  await act(async()=>{setFieldActive?.(true);await testSetup!.renderOnce();});
  await act(async()=>{await testSetup!.mockInput.typeText("12.3456");testSetup!.mockInput.pressEnter();await testSetup!.renderOnce();});
  expect(testSetup.captureCharFrame()).toContain("12.3456");expect(commits.at(-1)).toBeCloseTo(.123456,10);
  await act(async()=>{setFieldActive?.(false);await testSetup!.renderOnce();});
  expect(commits.at(-1)).toBeCloseTo(.123456,10);
});
