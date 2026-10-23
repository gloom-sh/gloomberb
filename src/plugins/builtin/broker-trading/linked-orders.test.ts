import { expect, test } from "bun:test";
import { linkedOrderRows } from "./linked-orders";

test("a bracket lists where its newest order sits, the entry above its exits, whatever order the broker sends", () => {
  const order = (id: string, accountId: string, linkGroup?: string, linkRole?: "entry" | "takeProfit" | "stopLoss") => ({ id, accountId, linkGroup, linkRole });
  const rows = linkedOrderRows([
    order("plain", "a"), order("stop", "a", "g1", "stopLoss"), order("other-account", "b", "g1", "entry"), order("entry", "a", "g1", "entry"),
    order("target", "a", "g1", "takeProfit"), order("oco-stop", "a", "g2", "stopLoss"), order("oco-limit", "a", "g2", "takeProfit"),
  ]);
  expect(rows.map((row) => `${row.order.id}${row.child ? " (child)" : ""}`)).toEqual([
    "plain", "entry", "target (child)", "stop (child)", "other-account", "oco-limit", "oco-stop",
  ]);
});
