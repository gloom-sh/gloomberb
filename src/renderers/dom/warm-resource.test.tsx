/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { createDomTestHarness } from "./test-utils";
import { useAsyncResource } from "../../react/async-resource";
import { MemoryResourceStore } from "../../data/memory-resource-store";
import { setSavedCopyStore, writeSavedCopy } from "../../data/pane-saved-copies";
import { ApiRequestError } from "../../api-client/errors";
import { markSavedCopy } from "../../data/saved-copies";

const dom = createDomTestHarness({ withUi: false });

test("desktop and web pane content renders before a saved resource refresh settles", async () => {
  const savedCopy = { key: ["board", "NYSE"] };
  const previous = setSavedCopyStore(new MemoryResourceStore());
  const pending = Promise.withResolvers<string>();
  const loader = () => pending.promise;
  const drawn: string[] = [];
  function Pane() {
    const state = useAsyncResource(loader, { savedCopy });
    const content = state.loading ? "Loading" : state.data ?? "Empty";
    drawn.push(content);
    return <div>{content}</div>;
  }
  try {
    writeSavedCopy(savedCopy, "Old rows", Date.UTC(2023, 0, 1));
    const pane = await dom.render(<Pane />);
    expect(pane.textContent).toBe("Old rows");
    await act(async () => { pending.resolve("New rows"); });
    expect(pane.textContent).toBe("New rows");
    expect(drawn).not.toContain("Loading");
  } finally {
    setSavedCopyStore(previous);
  }
});

test("a cached initial resource keeps its retrieval time until revalidation refuses it", async () => {
  const savedAt = Date.UTC(2023, 0, 1);
  const pending = Promise.withResolvers<{ label: string }>();
  const refreshes: boolean[] = [];
  const loader = (force: boolean) => { refreshes.push(force); return pending.promise; };
  function Pane() {
    const state = useAsyncResource(loader, { initialData: () => markSavedCopy({ label: "Saved rows" }, savedAt) });
    return <div>{state.loading ? "Loading" : state.data ? `${state.data.label} at ${state.updatedAt}` : state.error}</div>;
  }
  const pane = await dom.render(<Pane />);
  expect(pane.textContent).toBe(`Saved rows at ${savedAt}`);
  expect(refreshes).toEqual([true]);
  await act(async () => { pending.reject(new ApiRequestError("Sign in again", 401)); });
  expect(pane.textContent).toBe("Sign in again");
});
