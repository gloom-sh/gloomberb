import { afterEach, describe, expect, test } from "bun:test";
import { act, useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { testRender } from "../renderers/opentui/test-utils";
import { AppContext, createInitialState, type AppAction } from "../state/app/context";
import { createDefaultConfig } from "../types/config";
import type { InputRenderable } from "../ui";
import { InputSearchBar } from "./input-search-bar";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let setSearchActive: Dispatch<SetStateAction<boolean>> | null = null;

afterEach(async () => {
  setSearchActive = null;
  if (!testSetup) return;
  await act(async () => {
    testSetup!.renderer.destroy();
  });
  testSetup = undefined;
});

function Harness({
  actions,
  onNavigateDown,
  onBlur,
  onQueryChange,
}: {
  actions: AppAction[];
  onNavigateDown?: () => void;
  onBlur?: () => void;
  onQueryChange?: (query: string) => void;
}) {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-input-search-bar"));
  const inputRef = useRef<InputRenderable | null>(null);
  const [active, setActive] = useState(true);
  setSearchActive = setActive;
  const dispatch = useCallback((action: AppAction) => {
    actions.push(action);
  }, [actions]);

  return (
    <AppContext value={{ state, dispatch }}>
      <InputSearchBar
        value=""
        focused
        active={active}
        width={30}
        focusToken={0}
        inputRef={inputRef}
        placeholder="search"
        debounceMs={100}
        onNavigateDown={onNavigateDown}
        onFocus={() => {}}
        onBlur={onBlur ?? (() => {})}
        onQueryChange={onQueryChange ?? (() => {})}
      />
    </AppContext>
  );
}

describe("InputSearchBar", () => {
  test("captures app input while the search input is active", async () => {
    const actions: AppAction[] = [];

    testSetup = await testRender(<Harness actions={actions} />, { width: 40, height: 4 });
    await act(async () => {
      await testSetup!.renderOnce();
    });

    expect(actions).toEqual([{ type: "SET_INPUT_CAPTURED", captured: true }]);
    if (!setSearchActive) throw new Error("search setter was not registered");

    await act(async () => {
      setSearchActive(false);
      await testSetup!.renderOnce();
    });

    expect(actions).toEqual([
      { type: "SET_INPUT_CAPTURED", captured: true },
      { type: "SET_INPUT_CAPTURED", captured: false },
    ]);
  });

  test("Escape clears the query and releases the field", async () => {
    // The input consumes every key while focused, so without this there is no
    // way out of a search once it is entered.
    const actions: AppAction[] = [];
    const queries: string[] = [];
    let blurred = false;

    testSetup = await testRender(
      <Harness
        actions={actions}
        onBlur={() => {
          blurred = true;
        }}
        onQueryChange={(query) => queries.push(query)}
      />,
      { width: 40, height: 4 },
    );
    await act(async () => {
      await testSetup!.renderOnce();
    });

    await act(async () => {
      testSetup!.renderer.keyInput.emit("keypress", { name: "escape" });
      await testSetup!.renderOnce();
    });

    expect(queries).toEqual([""]);
    expect(blurred).toBe(true);
  });

  test("moves from the active search input to the table with Down", async () => {
    const actions: AppAction[] = [];
    let navigatedDown = 0;

    testSetup = await testRender(
      <Harness
        actions={actions}
        onNavigateDown={() => {
          navigatedDown += 1;
        }}
      />,
      { width: 40, height: 4 },
    );
    await act(async () => {
      await testSetup!.renderOnce();
    });

    await act(async () => {
      testSetup!.mockInput.pressArrow("down");
      await testSetup!.renderOnce();
    });

    expect(navigatedDown).toBe(1);
  });
});
