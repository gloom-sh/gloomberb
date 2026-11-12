import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { Text } from "../../../ui";
import type { ScreenRow } from "../../../api-client/equity-screener";
import { screenFixture } from "./test-fixture";
import { useRefreshAnchor } from "./refresh-anchor";

const tui = createOpenTuiTestHarness();
const rowsOf = (...symbols: string[]): ScreenRow[] => symbols.map((symbol) => ({ ...screenFixture().rows[0]!, symbol }));

test("a refresh asks the table to keep the row that was at the top where it was, unless the list sat at its top or lost the row", async () => {
  let latest!: ReturnType<typeof useRefreshAnchor>;
  let update!: (next: { snapshotId: string; rows: ScreenRow[]; firstVisible: number }) => void;
  function Harness() {
    const [state, setState] = useState({ snapshotId: "one", rows: rowsOf("A", "B", "C", "D", "E", "F"), firstVisible: 2 });
    update = setState;
    latest = useRefreshAnchor(state.snapshotId, state.rows, state.firstVisible);
    return <Text>{latest.anchor ? `${latest.anchor.index}:${latest.anchor.version}` : "none"}</Text>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 20, height: 2 }); });
  const apply = async (next: Parameters<typeof update>[0]) => { await act(async () => { update(next); await tui.setup().renderOnce(); }); };

  // C was the top row; the new snapshot has it fourth.
  await apply({ snapshotId: "one", rows: rowsOf("A", "B", "C", "D", "E", "F"), firstVisible: 2 });
  expect(latest.anchor).toBeNull();
  await apply({ snapshotId: "two", rows: rowsOf("X", "A", "B", "C", "D", "E", "F"), firstVisible: 2 });
  expect(latest.anchor).toEqual({ index: 3, version: 1 });
  // The user scrolling lets go of it.
  await act(async () => { latest.release(); await tui.setup().renderOnce(); });
  expect(latest.anchor).toBeNull();
  // Row D is the top now and the next snapshot dropped it: the scroll stays.
  await apply({ snapshotId: "two", rows: rowsOf("X", "A", "B", "C", "D", "E", "F"), firstVisible: 4 });
  await apply({ snapshotId: "three", rows: rowsOf("X", "A", "B", "C", "E", "F"), firstVisible: 4 });
  expect(latest.anchor).toBeNull();
  // A list at its top stays at its top.
  await apply({ snapshotId: "three", rows: rowsOf("X", "A", "B", "C", "E", "F"), firstVisible: 0 });
  await apply({ snapshotId: "four", rows: rowsOf("Y", "X", "A", "B", "C", "E", "F"), firstVisible: 0 });
  expect(latest.anchor).toBeNull();
});
