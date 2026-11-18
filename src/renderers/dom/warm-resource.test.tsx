/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { createDomTestHarness } from "./test-utils";
import { useAsyncResource } from "../../react/async-resource";
import { MemoryResourceStore } from "../../data/memory-resource-store";
import { setSavedCopyStore, writeSavedCopy } from "../../data/pane-saved-copies";

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
