import { afterEach, describe, expect, test } from "bun:test";
import { act, useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { AppContext, createInitialState, type AppAction } from "../state/app/context";
import { createStaticAppStore } from "../test-support/app-store";
import { createDefaultConfig } from "../types/config";
import type { InputRenderable } from "../ui";
import { InputSearchBar } from "./input-search-bar";

const tui = createOpenTuiTestHarness();
let setSearchActive: Dispatch<SetStateAction<boolean>> | null = null;

afterEach(() => {
  setSearchActive = null;
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
    <AppContext value={createStaticAppStore(state, dispatch)}>
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

    await tui.render(<Harness actions={actions} />, { width: 40, height: 4 });
    await act(async () => {
      await tui.setup().renderOnce();
    });

    expect(actions).toEqual([{ type: "SET_INPUT_CAPTURED", captured: true }]);
    if (!setSearchActive) throw new Error("search setter was not registered");

    await act(async () => {
      setSearchActive(false);
      await tui.setup().renderOnce();
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

    await tui.render(
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
      await tui.setup().renderOnce();
    });

    await tui.emitKeypress({ name: "escape" });

    expect(queries).toEqual([""]);
    expect(blurred).toBe(true);
  });

  test("moves from the active search input to the table with Down", async () => {
    const actions: AppAction[] = [];
    let navigatedDown = 0;

    await tui.render(
      <Harness
        actions={actions}
        onNavigateDown={() => {
          navigatedDown += 1;
        }}
      />,
      { width: 40, height: 4 },
    );
    await act(async () => {
      await tui.setup().renderOnce();
    });

    await act(async () => {
      tui.setup().mockInput.pressArrow("down");
      await tui.setup().renderOnce();
    });

    expect(navigatedDown).toBe(1);
  });
});
