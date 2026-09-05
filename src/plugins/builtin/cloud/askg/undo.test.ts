import { expect, test } from "bun:test";
import { applyJsonPatch } from "../../../../remote/json-patch";
import { revisionFor } from "../../../../remote/revision";
import type { RemoteControlResponse } from "../../../../remote/types";
import type { JsonValue } from "./protocol";
import { ASKGUndoManager, type InProcessRemoteControlHandler } from "./undo";

test("restores reversible pane state only when it has not changed again", async () => {
  const resource = "app://pane-state/chart%3Amain";
  const values = new Map<string, JsonValue>([[resource, { cursor: 1, mode: "price" }]]);
  const handler: InProcessRemoteControlHandler = async (request): Promise<RemoteControlResponse> => {
    if (request.type === "get") {
      const value = values.get(request.resource) ?? {};
      return { ok: true, data: value, rev: revisionFor(value) };
    }
    if (request.type === "patch") {
      const current = values.get(request.resource) ?? {};
      if (request.expectRev && request.expectRev !== revisionFor(current)) {
        return { ok: false, error: { code: "revision_mismatch", message: "Revision mismatch." } };
      }
      const next = applyJsonPatch(current, request.patch) as JsonValue;
      values.set(request.resource, next);
      return { ok: true, data: next, rev: revisionFor(next) };
    }
    return { ok: false, error: { code: "unsupported", message: "Unsupported request." } };
  };
  const undo = new ASKGUndoManager(handler, { tokenFactory: () => "undo-1" });
  const prepared = await undo.prepare("pane.setState", { paneId: "chart:main", patch: { cursor: 2 } });
  expect(prepared).not.toBeNull();
  values.set(resource, { cursor: 2, mode: "price", transient: true });
  const token = await undo.commit(prepared!);

  expect(token).toBe("undo-1");
  expect((await undo.undo(token!)).status).toBe("ok");
  expect(values.get(resource)).toEqual({ cursor: 1, mode: "price" });

  const second = await undo.prepare("pane.setState", { paneId: "chart:main", patch: { cursor: 3 } });
  values.set(resource, { cursor: 3, mode: "price" });
  const secondToken = await undo.commit(second!);
  values.set(resource, { cursor: 4, mode: "price" });
  const denied = await undo.undo(secondToken!);
  expect(denied.status).toBe("denied");
  expect(denied.note).toContain("changed after the tool call");
});
